/* Reproducible Chrome MV3 build: patches wllama workers to avoid blob: URLs forbidden by CSP. */
import { readFile, writeFile, copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const wllamaRoot = join(root, 'node_modules', '@wllama', 'wllama');
const wllamaDist = join(dist, 'wllama');
const sourceFiles = {
  generated: join(wllamaRoot, 'src', 'workers-code', 'generated.ts'),
  worker: join(wllamaRoot, 'src', 'worker.ts'),
  utils: join(wllamaRoot, 'src', 'utils.ts')
};

function constant(text, name) {
  const match = text.match(new RegExp(`export const ${name} = ("(?:[^"\\\\]|\\\\.)*");`));
  if (!match) throw new Error(`Installed wllama does not export ${name}; check pinned dependency`);
  return JSON.parse(match[1]);
}
function mustContain(haystack, needle, name) {
  if (!haystack.includes(needle)) throw new Error(`wllama ${name} signature changed: ${needle}`);
}

/**
 * wllama 3.8.1 native wllama_action returns nullptr on C++ exceptions without
 * overwriting its GLUE input header with a response length. 0x45554c47 then
 * becomes a bogus 1.16GB allocation. Validate the native pointer and result
 * before allocating, and retain the native C++ error message for diagnosis.
 */
export function patchLlamaWorker(code) {
  const substitutions = [
    ["let lastStack = '';", "let lastStack = '';\nlet lastNativeError = '';"],
    ["      const logLine = cppLogToJSLog(text);", "      const logLine = cppLogToJSLog(text);\n      if (logLine.level === 'error') lastNativeError = logLine.text;"],
    ["    const outputPtr = await wllamaAction(argAction, inputPtr);", [
      "    lastNativeError = '';",
      "    const outputPtr = await wllamaAction(argAction, inputPtr);",
      "    if (outputPtr == null || outputPtr === 0 || outputPtr === 0n) {",
      "      throw new Error('wllama native ' + argAction + ' failed: ' + (lastNativeError || 'no native error detail'));",
      "    }"
    ].join('\\n')],
    ["    // copy the output buffer to JS heap", [
      "    // C++ exceptions leave the original GLUE magic (0x45554c47) at inputPtr.",
      "    // Reject invalid response sizes instead of allocating a bogus huge array.",
      "    if (outputLen < 16 || outputLen > 16 * 1024 * 1024 ||",
      "        !Number.isSafeInteger(Number(outputPtr)) || Number(outputPtr) + outputLen > getHeapU8().byteLength) {",
      "      throw new Error('Invalid native GLUE response (' + argAction + ', length=' + outputLen + '): ' + (lastNativeError || 'backend did not write a valid response'));",
      "    }",
      "    // copy the output buffer to JS heap"
    ].join('\\n')]
  ];
  let patched = code;
  for (const [before, after] of substitutions) {
    if (!patched.includes(before)) throw new Error('wllama worker signature changed: ' + before.slice(0, 70));
    patched = patched.replace(before, after);
  }
  return patched;
}

export async function generateWorkers({ generatedPath = sourceFiles.generated, workerPath = sourceFiles.worker, destination = wllamaDist } = {}) {
  const [generated, worker] = await Promise.all([readFile(generatedPath, 'utf8'), readFile(workerPath, 'utf8')]);
  const llama = constant(generated, 'LLAMA_CPP_WORKER_CODE');
  const opfs = constant(generated, 'OPFS_UTILS_WORKER_CODE');
  const emscripten = constant(generated, 'WLLAMA_EMSCRIPTEN_CODE');
  const stub = worker.match(/const JSPI_STUB = `([\s\S]*?)`;/)?.[1];
  if (!stub) throw new Error('wllama JSPI_STUB not found');
  const moduleSource = stub + emscripten;
  mustContain(moduleSource, 'var Module', 'emscripten module');
  mustContain(llama, '? argMainScriptBlob', 'llama cpp worker');
  const pthreadStatic = patchLlamaWorker(llama).replace('? argMainScriptBlob', '? RUN_OPTIONS.moduleUrl');
  // `Module` is deliberately renamed in wModuleInit to prevent shadowing the worker's Module.
  const moduleInWorker = moduleSource.replace('var Module', 'var ___Module');
  const workerSource = `// Static MV3 worker generated from pinned wllama.\nconst RUN_OPTIONS = JSON.parse(new URLSearchParams(self.location.search).get('o') || '{}');\nfunction wModuleInit() { ${moduleInWorker}; return Module; }\n${pthreadStatic}\n`;
  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(join(destination, 'llama-worker.js'), workerSource),
    writeFile(join(destination, 'module.js'), moduleSource),
    writeFile(join(destination, 'opfs-worker.js'), opfs),
    copyFile(join(wllamaRoot, 'esm', 'wasm', 'wllama.wasm'), join(destination, 'wllama.wasm'))
  ]);
}

const originalWorkerFn = `export const createWorker = (workerCode: string | Blob): Worker => {
  const workerURL = URL.createObjectURL(
    isString(workerCode)
      ? new Blob([workerCode], { type: 'text/javascript' })
      : (workerCode as Blob)
  );
  return new Worker(workerURL, { type: 'module' });
};`;
const staticWorkerFn = `export const createWorker = (workerCode: string | Blob): Worker => {
  if (typeof workerCode !== 'string') throw new Error('Unsupported worker source');
  if (workerCode.startsWith('const RUN_OPTIONS = ')) {
    const found = /^const RUN_OPTIONS = (\\{[^\\n]+\\});/.exec(workerCode);
    if (!found) throw new Error('Could not parse wllama worker options');
    const opts = JSON.parse(found[1]);
    opts.moduleUrl = chrome.runtime.getURL('wllama/module.js');
    const url = chrome.runtime.getURL('wllama/llama-worker.js') + '?o=' + encodeURIComponent(JSON.stringify(opts));
    return new Worker(url, { type: 'module' });
  }
  return new Worker(chrome.runtime.getURL('wllama/opfs-worker.js'), { type: 'module' });
};`;

export function patchWllamaUtils(text) {
  mustContain(text, originalWorkerFn, 'createWorker');
  return text.replace(originalWorkerFn, staticWorkerFn);
}

export async function buildExtension() {
  await rm(dist, { recursive: true, force: true });
  await cp(join(root, 'extension'), dist, { recursive: true });
  await rm(join(dist, 'engine.js'));
  await generateWorkers();
  await build({
    entryPoints: [join(root, 'extension', 'engine.js')],
    outfile: join(dist, 'engine.bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome124'],
    logLevel: 'info',
    minify: true,
    plugins: [{
      name: 'wllama-mv3-workers',
      setup(plugin) {
        plugin.onResolve({ filter: /^@wllama\/wllama$/ }, () => ({ path: join(wllamaRoot, 'index.ts') }));
        plugin.onLoad({ filter: /[\\/]@wllama[\\/]wllama[\\/]src[\\/]utils\.ts$/ }, async (args) => {
          const text = await readFile(args.path, 'utf8');
          return { contents: patchWllamaUtils(text), loader: 'ts' };
        });
      }
    }]
  });
  console.log('Built Chrome extension into dist/. Use chrome://extensions -> Load unpacked -> dist/');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildExtension().catch((error) => { console.error(error); process.exitCode = 1; });
}
