(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const translateButton = $('translate');
  const restoreButton = $('restore');
  const prepareButton = $('prepare');
  const cpuButton = $('prepare-cpu');
  const testButton = $('test');
  let tabId = null;
  let canEditPage = false;
  let busy = false;
  let modelReady = false;
  let lastTestMessage = null;
  let testInProgress = false;

  function message(text) { $('message').textContent = text; }

  async function checkEngine() {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'ENGINE_STATUS' });
      const phase = state?.phase || 'error';
      const ready = phase === 'ready';
      modelReady = ready;
      $('server-dot').className = `dot ${ready ? 'online' : phase === 'error' ? 'offline' : 'checking'}`;
      const names = { idle: 'モデル未準備', downloading: 'モデル取得中', loading: 'GPUへ読み込み中', ready: 'モデル準備完了', error: 'モデルの読み込みに失敗' };
      const mode = state?.mode === 'cpu' ? 'CPU' : 'GPU';
      $('server-status').textContent = ready ? `モデル準備完了（${mode}）` : names[phase] || '状態確認中';
      $('model-message').textContent = state?.error || (ready && lastTestMessage) || state?.message || 'モデルの状態を取得できません。';
      const percent = state?.total > 0 ? Math.min(100, (state.loaded / state.total) * 100) : ready ? 100 : 0;
      $('download-bar').style.width = `${percent}%`;
      const preparing = phase === 'loading' || phase === 'downloading';
      prepareButton.disabled = preparing || testInProgress || (ready && mode === 'GPU');
      cpuButton.disabled = preparing || testInProgress || (ready && mode === 'CPU');
      cpuButton.textContent = ready && mode === 'CPU' ? 'CPU診断モード動作中' : 'CPU診断モードで準備（低速）';
      testButton.disabled = !ready || testInProgress;
      prepareButton.textContent = ready && mode === 'GPU' ? 'GPUモデル準備完了' : preparing ? 'モデル準備中…' : 'GPUモデルを準備';
      translateButton.disabled = !ready || !canEditPage || busy;
    } catch (error) {
      modelReady = false;
      $('server-dot').className = 'dot offline';
      $('server-status').textContent = '推論エンジン接続エラー';
      $('model-message').textContent = String(error?.message || error);
      translateButton.disabled = true;
    }
  }

  async function prepare(mode = 'gpu') {
    prepareButton.disabled = true;
    cpuButton.disabled = true;
    lastTestMessage = null;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ENGINE_PREPARE', mode });
      if (!result?.ok) throw new Error(result?.error || 'モデルを準備できません。');
    } catch (error) {
      $('model-message').textContent = String(error?.message || error);
    } finally { await checkEngine(); }
  }

  async function testEngine() {
    if (testInProgress || !modelReady) return;
    testInProgress = true;
    testButton.disabled = true;
    lastTestMessage = '短い文章「Hello, world!」を翻訳中…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ENGINE_TEST' });
      if (!result?.ok || !result.translation) throw new Error(result?.error || 'モデルから応答がありません。');
      lastTestMessage = 'テスト成功: Hello, world! → ' + result.translation;
    } catch (error) {
      lastTestMessage = 'テスト失敗: ' + String(error?.message || error);
    } finally {
      testInProgress = false;
      await checkEngine();
    }
  }

  function showStatus(status) {
    if (!status) return;
    const done = status.completed + status.failed + status.skipped;
    $('bar').style.width = `${status.total ? Math.min(100, 100 * done / status.total) : 0}%`;
    $('count').textContent = `${done} / ${status.total}`;
    $('phase').textContent = ({ idle: '待機中', translating: '翻訳中', translated: '翻訳完了', error: '翻訳エラー' })[status.phase] || '待機中';
    restoreButton.disabled = !canEditPage || busy || status.phase === 'idle';
    translateButton.disabled = !canEditPage || busy || !modelReady || status.phase === 'translating';
    translateButton.textContent = status.phase === 'translated' ? '追加の文章を翻訳' : 'ページ全体を翻訳';
    if (status.phase === 'error') message(status.lastError || '翻訳に失敗しました。');
    else if (status.phase === 'translating') message('表示中の文章から翻訳しています。タブの移動後も処理は続きます。');
    else if (status.phase === 'translated') message(`翻訳済み ${status.completed} 件、失敗 ${status.failed} 件${status.limited ? '（最大件数を超えたため一部省略）' : ''}`);
    else if (modelReady) message('翻訳ボタンでページ全体を日本語化できます。');
  }

  async function pageMessage(type) {
    if (tabId === null) throw new Error('翻訳できるページが開かれていません。');
    const result = await chrome.tabs.sendMessage(tabId, { type });
    if (!result?.ok) throw new Error(result?.error || 'ページに接続できません。');
    return result.status;
  }

  async function act(type) {
    if (busy || !canEditPage || (type === 'PAGE_TRANSLATE' && !modelReady)) return;
    busy = true;
    translateButton.disabled = true;
    restoreButton.disabled = true;
    try { showStatus(await pageMessage(type)); }
    catch (error) { message(String(error?.message || error)); }
    finally { busy = false; await poll(); }
  }

  async function poll() {
    if (busy || !canEditPage) return;
    try { showStatus(await pageMessage('PAGE_STATUS')); }
    catch { message('ページと接続できません。再読み込みしてからお試しください。'); }
  }

  async function init() {
    prepareButton.addEventListener('click', () => prepare('gpu'));
    cpuButton.addEventListener('click', () => prepare('cpu'));
    testButton.addEventListener('click', testEngine);
    $('retry-server').addEventListener('click', checkEngine);
    translateButton.addEventListener('click', () => act('PAGE_TRANSLATE'));
    restoreButton.addEventListener('click', () => act('PAGE_RESTORE'));
    void checkEngine();
    setInterval(checkEngine, 1300);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) {
        $('phase').textContent = '対象外のページ';
        message('Chrome内部ページは翻訳できません。通常のWebページを開いてください。');
        return;
      }
      tabId = tab.id;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['core.js', 'content.js'] });
      canEditPage = true;
      await poll();
      setInterval(poll, 750);
    } catch (error) {
      message(`ページに拡張機能を挿入できません: ${String(error?.message || error)}`);
    }
  }
  void init();
})();
