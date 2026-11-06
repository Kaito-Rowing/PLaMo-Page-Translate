const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeBackground(fetcher) {
  const root = path.resolve(__dirname, '../extension');
  let listener = null;
  const storage = new Map();
  const ctx = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout, console, fetch: fetcher,
    chrome: {
      runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: {
        get: async (key) => ({ [key]: storage.get(key) }),
        set: async (value) => { for (const [key, val] of Object.entries(value)) storage.set(key, val); }
      } }
    }
  });
  ctx.importScripts = (filename) => {
    vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), ctx, { filename });
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);
  function message(input, senderId = 'test-extension') {
    return new Promise((resolve) => {
      const async = listener(input, { id: senderId }, resolve);
      if (!async) resolve(undefined);
    });
  }
  return { message, storage };
}

test('checks the loopback health endpoint', async () => {
  const urls = [];
  const service = makeBackground(async (url) => {
    urls.push(url);
    return { ok: true };
  });
  const result = await service.message({ type: 'CHECK_SERVER' });
  assert.equal(result.ok, true);
  assert.equal(urls[0], 'http://127.0.0.1:8000/health');
});

test('translates using the official template, caches repeats and deduplicates inflight requests', async () => {
  const payloads = [];
  const service = makeBackground(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8000/v1/chat/completions');
    payloads.push(JSON.parse(options.body));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'ようこそ' } }] })
    };
  });
  const [one, two] = await Promise.all([
    service.message({ type: 'TRANSLATE_TEXT', text: 'Welcome' }),
    service.message({ type: 'TRANSLATE_TEXT', text: 'Welcome' })
  ]);
  const three = await service.message({ type: 'TRANSLATE_TEXT', text: 'Welcome' });
  assert.equal(one.translation, 'ようこそ');
  assert.equal(two.translation, 'ようこそ');
  assert.equal(three.translation, 'ようこそ');
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].chat_template_kwargs.target_lang, 'ja');
  assert.equal(payloads[0].chat_template_kwargs.form, 'plain');
  assert.deepEqual(payloads[0].stop, ['<|plamo:tag|>', '<|plamo:bos|>']);
});

test('does not accept arbitrary senders or invalid translation requests', async () => {
  let calls = 0;
  const service = makeBackground(async () => { calls++; throw new Error('not reached'); });
  assert.equal(await service.message({ type: 'TRANSLATE_TEXT', text: 'Hello' }, 'website'), undefined);
  const response = await service.message({ type: 'TRANSLATE_TEXT', text: '123456' });
  assert.equal(response.ok, false);
  assert.equal(calls, 0);
});

test('returns a readable error when the local server is unavailable', async () => {
  const service = makeBackground(async () => { throw new TypeError('Failed to fetch'); });
  const response = await service.message({ type: 'TRANSLATE_TEXT', text: 'Hello' });
  assert.equal(response.ok, false);
  assert.match(response.error, /接続/);
});
