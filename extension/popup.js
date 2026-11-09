(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let tabId = null;
  let canEditPage = false;
  let busy = false;
  let pageProblem = '';
  let prepareError = '';
  let engine = { phase: 'checking' };
  let page = { phase: 'idle', total: 0, completed: 0, failed: 0, skipped: 0 };

  function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
  function progress(id, bar, percent, known = true) {
    $(bar).style.width = `${percent}%`;
    if (known) $(id).setAttribute('aria-valuenow', String(Math.round(percent)));
    else $(id).removeAttribute('aria-valuenow');
    $(id).classList.toggle('indeterminate', !known);
  }
  function render() {
    const ready = engine.phase === 'ready';
    const preparing = ['downloading', 'loading', 'verifying'].includes(engine.phase);
    const translating = page.phase === 'translating';
    const mode = engine.mode === 'cpu' ? 'CPU' : 'GPU';
    document.body.dataset.enginePhase = prepareError ? 'error' : engine.phase;
    document.body.dataset.pagePhase = page.phase;
    const names = { checking: '確認中', idle: '未準備', downloading: 'ダウンロード中', loading: '読み込み中', verifying: '準備中', error: '準備できません' };
    text('server-status', prepareError ? '準備できません' : ready ? `${mode} · 準備完了` : names[engine.phase] || '確認中');
    $('server-dot').className = `dot ${prepareError ? 'offline' : ready ? 'online' : engine.phase === 'error' ? 'offline' : 'checking'}`;
    text('model-message', prepareError || engine.error || engine.message || 'モデルはPC内に保存し、次回から再利用します。');
    $('prepare').disabled = preparing || busy || translating || engine.phase === 'checking' || (ready && mode === 'GPU');
    $('prepare-cpu').disabled = preparing || busy || translating || engine.phase === 'checking' || (ready && mode === 'CPU');
    $('prepare').setAttribute('aria-pressed', String(ready && mode === 'GPU'));
    $('prepare-cpu').setAttribute('aria-pressed', String(ready && mode === 'CPU'));
    text('prepare', ready && mode === 'GPU' ? 'GPUを使用中' : 'GPUモデルを準備');
    text('prepare-cpu', ready && mode === 'CPU' ? 'CPUを使用中' : 'CPUモデルを準備');
    $('translate').disabled = !ready || !canEditPage || busy || translating;
    $('restore').disabled = !canEditPage || busy || page.phase === 'idle';
    text('translate-label', translating ? '翻訳しています…' : page.phase === 'translated' ? '追加の文章を翻訳' : 'ページ全体を翻訳');
    $('translate').setAttribute('aria-busy', String(translating));
    $('download-progress').hidden = !preparing;
    const knownDownload = engine.total > 0;
    const percent = knownDownload ? Math.min(100, 100 * engine.loaded / engine.total) : 0;
    progress('model-progress', 'download-bar', percent, knownDownload);
    text('download-label', knownDownload ? `${Math.floor(percent)}% · ${(engine.loaded / 1e9).toFixed(2)} / ${(engine.total / 1e9).toFixed(2)} GB` : 'モデルの保存状況を確認中…');
    const done = page.completed + page.failed + page.skipped;
    $('page-progress').hidden = page.phase === 'idle';
    text('count', `${done} / ${page.total}`);
    text('phase', ({ idle: '待機中', translating: '翻訳中', translated: page.failed ? '一部を翻訳できませんでした' : '翻訳完了', error: '翻訳を中断しました' })[page.phase] || '待機中');
    progress('translation-progress', 'bar', page.total ? Math.min(100, 100 * done / page.total) : 0);
    let message;
    if (pageProblem) message = pageProblem;
    else if (page.phase === 'error') message = page.lastError || '翻訳できませんでした。モデルを再準備してください。';
    else if (prepareError || engine.phase === 'error') message = 'モデル設定を確認し、もう一度準備してください。';
    else if (translating) message = '表示中の文章から順に翻訳しています。';
    else if (page.phase === 'translated') message = `翻訳済み ${page.completed} 件${page.failed ? `、失敗 ${page.failed} 件` : ''}${page.limited ? '（最大件数に達しました）' : ''}。原文へいつでも戻せます。`;
    else if (preparing) message = '準備が終わるまで、このままお待ちください。';
    else if (ready) message = '文章やリンクの書式を保って翻訳します。';
    else message = '下のモデルを準備すると、翻訳を始められます。';
    text('message', message);
    $('message').classList.toggle('error', !!pageProblem || !!prepareError || page.phase === 'error' || engine.phase === 'error');
  }
  async function checkEngine() {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'ENGINE_STATUS' });
      const next = state && typeof state.phase === 'string' ? state : { phase: 'error', error: state?.error || 'モデルの状態を取得できません。' };
      if (next.phase === 'ready') prepareError = '';
      if (next.phase !== engine.phase) $('engine-details').open = next.phase !== 'ready';
      engine = next;
    } catch (error) {
      engine = { phase: 'error', error: String(error?.message || error) };
      $('engine-details').open = true;
    }
    render();
  }
  async function prepare(mode) {
    if (busy || page.phase === 'translating') return;
    busy = true;
    prepareError = '';
    render();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ENGINE_PREPARE', mode });
      if (!result?.ok) throw new Error(result?.error || 'モデルを準備できません。');
    } catch (error) {
      prepareError = String(error?.message || error);
      $('engine-details').open = true;
    } finally { busy = false; await checkEngine(); }
  }
  async function pageMessage(type) {
    const result = await chrome.tabs.sendMessage(tabId, { type });
    if (!result?.ok) throw new Error(result?.error || 'ページに接続できません。');
    page = result.status;
    pageProblem = '';
  }
  async function poll() {
    if (busy || !canEditPage) return;
    try { await pageMessage('PAGE_STATUS'); }
    catch { pageProblem = 'ページを再読み込みしてから、拡張を開き直してください。'; }
    render();
  }
  async function act(type) {
    if (busy || !canEditPage || (type === 'PAGE_TRANSLATE' && (engine.phase !== 'ready' || page.phase === 'translating'))) return;
    busy = true;
    render();
    try { await pageMessage(type); }
    catch (error) { pageProblem = String(error?.message || error); }
    finally { busy = false; render(); }
  }
  async function init() {
    $('prepare').addEventListener('click', () => prepare('gpu'));
    $('prepare-cpu').addEventListener('click', () => prepare('cpu'));
    $('retry-server').addEventListener('click', checkEngine);
    $('translate').addEventListener('click', () => act('PAGE_TRANSLATE'));
    $('restore').addEventListener('click', () => act('PAGE_RESTORE'));
    render();
    void checkEngine();
    setInterval(checkEngine, 1300);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) {
        text('page-host', '対象外のページ'); text('page-title', '通常のWebページでご利用ください');
        pageProblem = 'このページは翻訳できません。通常のWebページを開いてください。';
        render(); return;
      }
      tabId = tab.id;
      text('page-host', new URL(tab.url).hostname);
      text('page-title', tab.title || '開いているページ');
      $('page-title').title = tab.title || tab.url;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['core.js', 'content.js'] });
      canEditPage = true;
      await poll();
      setInterval(poll, 750);
    } catch (error) { pageProblem = `ページに接続できません: ${String(error?.message || error)}`; render(); }
  }
  void init();
})();
