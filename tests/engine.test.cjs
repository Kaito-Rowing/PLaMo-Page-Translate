const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function engine({ completion, jspi = true, adapter = true } = {}) {
  let listener;
  const instances = [];
  class Wllama {
    constructor() { this.loaded = false; this.calls = []; instances.push(this); }
    setCompat(value) { this.compat = value; }
    isSupportWebGPU() { return true; }
    async loadModelFromUrl(url, options) { this.options = options; this.loaded = true; }
    isModelLoaded() { return this.loaded; }
    async createCompletion(options) {
      this.calls.push(options);
      return completion ? completion(options, this) : { choices: [{ text: '今日はいい天気だ。', finish_reason: 'stop' }] };
    }
    async exit() { this.exited = true; this.loaded = false; }
  }
  const source = fs.readFileSync(path.join(__dirname, '../extension/engine.js'), 'utf8').replace("import { Wllama } from '@wllama/wllama';", '');
  vm.runInNewContext(source, {
    Wllama, WebAssembly: { Suspending: jspi ? function () {} : undefined },
    navigator: { gpu: { requestAdapter: async () => adapter ? {} : null } },
    chrome: { runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener(fn) { listener = fn; } } } },
  });
  const send = (action, extra = {}) => new Promise(resolve => {
    listener({ target: 'PLAMO_ENGINE', action, ...extra }, { id: 'test' }, resolve);
  });
  async function settled() {
    for (let i = 0; i < 100; i++) {
      const state = await send('STATUS');
      if (['ready', 'error'].includes(state.phase)) return state;
      await new Promise(setImmediate);
    }
    throw new Error('Engine did not settle');
  }
  return { send, settled, instances };
}

test('engine becomes ready only after Japanese smoke inference and disables CDN fallback', async () => {
  const e = engine();
  assert.equal((await e.send('START')).phase, 'downloading');
  const state = await e.settled();
  assert.equal(state.phase, 'ready');
  assert.equal(state.smokeTranslation, '今日はいい天気だ。');
  assert.equal(e.instances[0].compat, null);
  assert.match(e.instances[0].calls[0].prompt, /lang<\|plamo:val\|>ja<\|plamo:key\|>form<\|plamo:val\|>plain/);
  assert.equal(e.instances[0].options.n_gpu_layers, 999);
});

test('broken native inference or echoed English does not report model ready', async () => {
  for (const completion of [async () => { throw new Error('native failure'); }, async () => ({ choices: [{ text: 'The weather is nice today.' }] })]) {
    const e = engine({ completion });
    await e.send('START');
    assert.equal((await e.settled()).phase, 'error');
    assert.equal(e.instances[0].exited, true);
  }
});

test('unsupported browser and missing GPU fail before downloading the model', async () => {
  const old = engine({ jspi: false });
  await old.send('START');
  assert.match((await old.settled()).error, /Chrome 137/);
  assert.equal(old.instances.length, 0);
  const noGPU = engine({ adapter: false });
  await noGPU.send('START');
  assert.match((await noGPU.settled()).error, /GPU/);
  assert.equal(noGPU.instances[0].options, undefined);
});

test('mode switch waits for in-flight inference before releasing its runtime', async () => {
  let release;
  let inferenceStarted;
  const started = new Promise(r => { inferenceStarted = r; });
  const e = engine({ completion: async (options, instance) => {
    if (instance.calls.length === 2) {
      inferenceStarted();
      await new Promise(r => { release = r; });
    }
    return { choices: [{ text: '日本語の訳文。' }] };
  } });
  await e.send('START');
  await e.settled();
  const translation = e.send('TRANSLATE', { text: 'Translate this sentence.' });
  await started;
  await e.send('START', { mode: 'cpu' });
  assert.equal(e.instances[0].exited, undefined);
  release();
  assert.equal((await translation).ok, true);
  const state = await e.settled();
  assert.equal(state.phase, 'ready');
  assert.equal(state.mode, 'cpu');
  assert.equal(e.instances[0].exited, true);
  assert.equal(e.instances[1].options.n_gpu_layers, 0);
});

test('truncated output is retried in smaller pieces without resetting the runtime', async () => {
  const e = engine({ completion: async options => ({ choices: [{ text: '訳文。', finish_reason: options.prompt.includes('a'.repeat(200)) ? 'length' : 'stop' }] }) });
  await e.send('START');
  await e.settled();
  const result = await e.send('TRANSLATE', { text: 'a'.repeat(350) });
  assert.equal(result.translation, '訳文。訳文。');
  assert.equal((await e.send('STATUS')).phase, 'ready');
  assert.equal(e.instances[0].exited, undefined);
});
