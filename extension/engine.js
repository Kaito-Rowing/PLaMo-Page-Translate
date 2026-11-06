/* Offscreen document: the only place where PLaMo GGUF is downloaded or executed. */
import { Wllama } from '@wllama/wllama';

const MODEL_URL = 'https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/main/plamo-3-translate-2b-Q4_K_M.gguf';
const STOP = ['<|plamo:tag|>', '<|plamo:bos|>'];
let model;
let loading;
let chain = Promise.resolve();
const state = {
  phase: 'idle', loaded: 0, total: 0, webgpu: null,
  message: 'モデルを準備してください。', error: null
};

function report(phase, message) {
  state.phase = phase;
  state.message = message;
}
function status() {
  return { ok: state.phase !== 'error', ...state };
}
function prompt(text) {
  return '<|plamo:tag|>dataset<|plamo:msg|>translation'
    + '<|plamo:tag|>input<|plamo:msg|>' + text
    + '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>';
}
async function start() {
  if (model?.isModelLoaded()) return status();
  if (loading) return status();
  report('downloading', 'モデルの取得・キャッシュ確認中…（初回約1.8GB）');
  state.error = null;
  state.loaded = 0;
  state.total = 0;
  loading = (async () => {
    let instance;
    try {
      instance = new Wllama({ default: chrome.runtime.getURL('wllama/wllama.wasm') }, {
        allowOffline: true, parallelDownloads: 2, suppressNativeLog: true
      });
      // Chrome + RTX 4070: request GPU offload. Do not silently use CPU unless GPU is unavailable.
      state.webgpu = instance.isSupportWebGPU();
      if (!state.webgpu) throw new Error('WebGPUが使えません。Chromeのハードウェアアクセラレーションを有効にしてください。');
      await instance.loadModelFromUrl(MODEL_URL, {
        n_ctx: 4096, n_batch: 128, n_threads: 1, n_gpu_layers: 999,
        useCache: true,
        progressCallback: ({ loaded, total }) => {
          if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return;
          state.loaded = loaded;
          state.total = total;
          if (loaded >= total) report('loading', '取得完了。GPUへモデルをロードしています…');
          else report('downloading', `モデルをダウンロード中… ${Math.floor((loaded / total) * 100)}%`);
        }
      });
      model = instance;
      report('ready', 'WebGPUモデル準備完了。翻訳できます。');
    } catch (error) {
      state.error = String(error?.message || error);
      report('error', 'モデルの読み込みに失敗しました。');
      if (instance) try { await instance.exit(); } catch { /* best effort */ }
      model = undefined;
    } finally {
      loading = undefined;
    }
  })();
  // Do not await gigabytes of download in a chrome.runtime message channel.
  return status();
}
async function doTranslate(text) {
  if (state.phase !== 'ready' || !model?.isModelLoaded()) {
    throw new Error(state.error || 'モデルが準備できていません。「モデルを準備」を先に実行してください。');
  }
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > 1200) {
    throw new Error('無効な翻訳対象です。');
  }
  let response;
  try {
    response = await model.createCompletion({
      prompt: prompt(text), temperature: 0,
      max_tokens: Math.min(1600, Math.max(128, Math.ceil(text.length * 2))),
      stop: STOP, stream: false
    });
  } catch (error) {
    // A failed native inference may have left the WASM runtime in a bad state.
    // Stop promptly rather than attempting hundreds of doomed translations.
    state.error = '推論エンジンエラー: ' + String(error?.message || error);
    report('error', 'WebGPU推論に失敗しました。「モデルを準備」で再初期化してください。');
    const failed = model;
    model = undefined;
    try { await failed?.exit(); } catch { /* worker may already be dead */ }
    throw new Error(state.error + '（モデルを再準備してください。キャッシュは保持されます）');
  }
  if (response?.choices?.[0]?.finish_reason === 'length') throw new Error('訳文が途中で切れました。');
  const raw = response?.choices?.[0]?.text;
  if (typeof raw !== 'string') throw new Error('モデルの応答形式が不正です。');
  const translation = raw.split(/<\|plamo:(?:tag|bos)\|>/u, 1)[0].trim();
  if (!translation) throw new Error('翻訳結果が空でした。');
  return { ok: true, translation };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'PLAMO_ENGINE') return false;
  if (message.action === 'STATUS') { reply(status()); return false; }
  if (message.action === 'START') {
    // Acknowledge now. start() owns the long-lived background promise.
    start().then(reply).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (message.action === 'TRANSLATE') {
    // One inference at a time: wllama's server-context is loaded with n_parallel=1.
    const job = chain.then(() => doTranslate(message.text));
    chain = job.catch(() => {});
    job.then(reply).catch((e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  return false;
});
