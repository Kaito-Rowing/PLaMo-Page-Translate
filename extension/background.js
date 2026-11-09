/* MV3 coordinator: no localhost, models, or inference in the service worker. */
importScripts('core.js');

const CACHE_KEY = 'plamoPageTranslateCacheV2';
const CACHE_LIMIT = 600;
const cache = new Map();
const pending = new Map();
let ensurePromise;
let persistTimer;

const cacheReady = chrome.storage.local.get(CACHE_KEY).then((data) => {
  for (const pair of (Array.isArray(data[CACHE_KEY]) ? data[CACHE_KEY] : []).slice(-CACHE_LIMIT)) {
    if (Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === 'string')) {
      cache.set(pair[0], pair[1]);
    }
  }
}).catch(() => {});

function remember(key, result) {
  if (key.length + result.length > 7500) return;
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.local.set({ [CACHE_KEY]: [...cache] }).catch(() => {});
  }, 1000);
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.some((c) => c.documentUrl === chrome.runtime.getURL('offscreen.html'));
}

async function ensureEngine() {
  if (await hasOffscreenDocument()) return;
  if (!ensurePromise) {
    ensurePromise = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run the bundled WebAssembly/WebGPU translation engine offscreen while pages remain responsive.'
    }).catch(async (error) => {
      if (!(await hasOffscreenDocument())) throw error;
    }).finally(() => { ensurePromise = undefined; });
  }
  await ensurePromise;
}

async function engineMessage(action, payload = {}) {
  const message = { target: 'PLAMO_ENGINE', action, ...payload };
  // Freshly created offscreen pages need a moment to register their ESM listener.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      const detail = String(error?.message || error);
      if (attempt === 11 || !/receiving end does not exist|message port closed/i.test(detail)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
}

async function status() {
  if (!(await hasOffscreenDocument())) {
    return { ok: true, phase: 'idle', webgpu: null, loaded: 0, total: 0, message: 'モデルを準備してください。' };
  }
  const response = await engineMessage('STATUS');
  return response && typeof response === 'object'
    ? response : { ok: false, phase: 'error', error: '推論エンジンから応答がありません。' };
}

async function prepare(mode = 'gpu') {
  await ensureEngine();
  return engineMessage('START', { mode }); // responds immediately; 1.8 GB download continues offscreen
}

async function translate(text, context = '') {
  if (typeof text !== 'string' || !PLaMoCore.shouldTranslateText(text) || text.length > 1200) {
    throw new Error('翻訳対象の文字列が無効です（上限1200文字）。');
  }
  if (typeof context !== 'string' || context.length > 400) throw new Error('翻訳の文脈が無効です。');
  await cacheReady;
  const key = JSON.stringify(['plamo3-context-v1', context, text]);
  if (cache.has(key)) return cache.get(key);
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    if (!(await hasOffscreenDocument())) throw new Error('先に「モデルを準備」を押してください。');
    const result = await engineMessage('TRANSLATE', { text, context });
    if (!result?.ok || typeof result.translation !== 'string') {
      throw new Error(result?.error || 'モデルが翻訳できませんでした。');
    }
    remember(key, result.translation);
    return result.translation;
  })().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || message.target) return false;
  let job;
  if (message.type === 'ENGINE_STATUS') job = status();
  else if (message.type === 'ENGINE_PREPARE') job = prepare(message.mode === 'cpu' ? 'cpu' : 'gpu');
  else if (message.type === 'ENGINE_TEST') job = engineMessage('TEST');
  else if (message.type === 'TRANSLATE_TEXT') job = translate(message.text, message.context).then((translation) => ({ ok: true, translation }));
  else return false;
  Promise.resolve(job).then(reply).catch((error) => reply({ ok: false, error: String(error?.message || error) }));
  return true;
});
