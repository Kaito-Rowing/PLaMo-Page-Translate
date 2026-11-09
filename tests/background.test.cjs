const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeBackground({ engineReady = true } = {}) {
  const folder = path.resolve(__dirname, '../extension');
  let listener = null;
  let documentCreated = false;
  let createCalls = 0;
  const engineCalls = [];
  const storage = new Map();
  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      getContexts: async () => documentCreated ? [{ documentUrl: 'chrome-extension://test-extension/offscreen.html' }] : [],
      sendMessage: async (message) => {
        engineCalls.push(message);
        if (message.action === 'STATUS') return { ok: true, phase: engineReady ? 'ready' : 'idle' };
        if (message.action === 'START') return { ok: true, phase: 'downloading' };
        if (message.action === 'TRANSLATE') return { ok: true, translation: '翻訳済み:' + message.text };
        if (message.action === 'TEST') return { ok: true, translation: 'こんにちは、世界！' };
        throw new Error('unexpected message');
      },
      onMessage: { addListener(fn) { listener = fn; } }
    },
    offscreen: { createDocument: async () => { createCalls++; documentCreated = true; } },
    storage: { local: {
      get: async (key) => ({ [key]: storage.get(key) }),
      set: async (value) => { for (const [key, val] of Object.entries(value)) storage.set(key, val); }
    } }
  };
  const ctx = vm.createContext({ URL, setTimeout, clearTimeout, console, chrome });
  ctx.importScripts = (filename) => {
    vm.runInContext(fs.readFileSync(path.join(folder, filename), 'utf8'), ctx, { filename });
  };
  vm.runInContext(fs.readFileSync(path.join(folder, 'background.js'), 'utf8'), ctx);
  function message(input, senderId = 'test-extension') {
    return new Promise((resolve) => {
      const asynchronous = listener(input, { id: senderId }, resolve);
      if (!asynchronous) resolve(undefined);
    });
  }
  return { message, storage, engineCalls, getCreateCalls: () => createCalls };
}

test('returns idle when model was not prepared, without opening an offscreen document', async () => {
  const app = makeBackground();
  const state = await app.message({ type: 'ENGINE_STATUS' });
  assert.equal(state.phase, 'idle');
  assert.equal(app.getCreateCalls(), 0);
});

test('prepares the offscreen model host just once and checks status', async () => {
  const app = makeBackground();
  const [first, second] = await Promise.all([
    app.message({ type: 'ENGINE_PREPARE' }), app.message({ type: 'ENGINE_PREPARE' })
  ]);
  assert.equal(first.phase, 'downloading');
  assert.equal(second.phase, 'downloading');
  assert.equal(app.getCreateCalls(), 1);
  assert.equal((await app.message({ type: 'ENGINE_STATUS' })).phase, 'ready');
});

test('passes CPU mode and short inference test to the offscreen engine', async () => {
  const app = makeBackground();
  await app.message({ type: 'ENGINE_PREPARE', mode: 'cpu' });
  assert.equal(app.engineCalls.find((x) => x.action === 'START').mode, 'cpu');
  const result = await app.message({ type: 'ENGINE_TEST' });
  assert.equal(result.translation, 'こんにちは、世界！');
  assert.equal(app.engineCalls.filter((x) => x.action === 'TEST').length, 1);
});

test('translates using offscreen WebGPU only, deduplicates concurrent messages and caches translation', async () => {
  const app = makeBackground();
  await app.message({ type: 'ENGINE_PREPARE' });
  const results = await Promise.all([
    app.message({ type: 'TRANSLATE_TEXT', text: 'Hello world' }),
    app.message({ type: 'TRANSLATE_TEXT', text: 'Hello world' })
  ]);
  assert.equal(results[0].translation, '翻訳済み:Hello world');
  assert.equal(results[1].translation, '翻訳済み:Hello world');
  const again = await app.message({ type: 'TRANSLATE_TEXT', text: 'Hello world' });
  assert.equal(again.translation, '翻訳済み:Hello world');
  assert.equal(app.engineCalls.filter((x) => x.action === 'TRANSLATE').length, 1);
});

test('rejects web page senders, unsupported requests and translation before model preparation', async () => {
  const app = makeBackground();
  assert.equal(await app.message({ type: 'ENGINE_PREPARE' }, 'untrusted-page'), undefined);
  assert.equal(await app.message({ type: 'PLAMO_ENGINE', target: 'PLAMO_ENGINE' }), undefined);
  assert.equal((await app.message({ type: 'TRANSLATE_TEXT', text: '123456' })).ok, false);
  const result = await app.message({ type: 'TRANSLATE_TEXT', text: 'Hello' });
  assert.equal(result.ok, false);
  assert.match(result.error, /モデルを準備/);
});

test('manifest requires no local server and all scripts run under MV3 CSP', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
  assert.doesNotMatch(JSON.stringify(manifest), /localhost|127\.0\.0\.1/);
  assert.ok(manifest.host_permissions.some((x) => x.startsWith('https://huggingface.co')));
});

test('separates identical words by page context in the translation cache', async () => {
  const app = makeBackground();
  await app.message({ type: 'ENGINE_PREPARE' });
  await app.message({ type: 'TRANSLATE_TEXT', text: 'Architecture', context: 'Software engineering' });
  await app.message({ type: 'TRANSLATE_TEXT', text: 'Architecture', context: 'Building design' });
  assert.equal(app.engineCalls.filter(x => x.action === 'TRANSLATE').length, 2);
  assert.equal(app.engineCalls.filter(x => x.action === 'TRANSLATE')[0].context, 'Software engineering');
  assert.equal((await app.message({ type: 'TRANSLATE_TEXT', text: 'Architecture', context: 'x'.repeat(401) })).ok, false);
});
