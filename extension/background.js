/* All network requests originate in the extension service worker, never in web pages. */
importScripts("core.js");

const API_ROOT = "http://127.0.0.1:8000";
const COMPLETIONS_URL = `${API_ROOT}/v1/chat/completions`;
const CACHE_STORAGE_KEY = "plamoPageTranslateCacheV1";
const CACHE_LIMIT = 500;
const cache = new Map();
const inFlight = new Map();
let persistTimer = null;

const cacheReady = chrome.storage.local.get(CACHE_STORAGE_KEY).then((stored) => {
  const entries = stored[CACHE_STORAGE_KEY];
  if (!Array.isArray(entries)) return;
  for (const pair of entries.slice(-CACHE_LIMIT)) {
    if (Array.isArray(pair) && pair.length === 2 &&
        typeof pair[0] === "string" && typeof pair[1] === "string") {
      cache.set(pair[0], pair[1]);
    }
  }
}).catch(() => {});

function remember(key, value) {
  if (key.length + value.length > 7000) return;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.local.set({ [CACHE_STORAGE_KEY]: [...cache] }).catch(() => {});
  }, 1200);
}

async function checkServer() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${API_ROOT}/health`, {
      method: "GET", signal: controller.signal, cache: "no-store"
    });
    return response.ok ? { ok: true } : {
      ok: false, error: `サーバーが準備中です (HTTP ${response.status})。`
    };
  } catch {
    return { ok: false, error: "127.0.0.1:8000 に接続できません。llama-serverを起動してください。" };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestTranslation(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(COMPLETIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PLaMoCore.makeRequest(text)),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`翻訳サーバーがHTTP ${response.status}を返しました。`);
    }
    return PLaMoCore.readTranslation(await response.json());
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("翻訳がタイムアウトしました（120秒）。");
    }
    if (error?.name === "TypeError" && /fetch/i.test(error.message)) {
      throw new Error("翻訳サーバーに接続できません。llama-serverを確認してください。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function translate(text) {
  if (typeof text !== "string" || !PLaMoCore.shouldTranslateText(text) || text.length > 1200) {
    throw new Error("翻訳できないテキストです。");
  }
  await cacheReady;
  const key = `ja\u0000plain\u0000${text}`;
  if (cache.has(key)) return cache.get(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = requestTranslation(text).then((result) => {
    remember(key, result);
    return result;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") {
    return false;
  }
  if (message.type === "CHECK_SERVER") {
    checkServer().then(sendResponse);
    return true;
  }
  if (message.type === "TRANSLATE_TEXT") {
    translate(message.text)
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  return false;
});
