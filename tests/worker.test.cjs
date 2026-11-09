const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

test('build generates parseable static workers and a valid WASM asset', async () => {
  const { generateWorkers } = await import('../scripts/build.mjs');
  const destination = await mkdtemp(join(tmpdir(), 'plamo-worker-test-'));
  try {
    await generateWorkers({ destination });
    for (const file of ['llama-worker.js', 'module.js', 'opfs-worker.js']) {
      const parsed = spawnSync(process.execPath, ['--check', join(destination, file)], { encoding: 'utf8' });
      assert.equal(parsed.status, 0, parsed.stderr);
    }
    const wasm = await readFile(join(destination, 'wllama.wasm'));
    assert.deepEqual(wasm.subarray(0, 4), Buffer.from([0, 97, 115, 109]));
  } finally {
    await rm(destination, { force: true, recursive: true });
  }
});
