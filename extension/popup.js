(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const translateButton = $("translate");
  const restoreButton = $("restore");
  let tabId = null;
  let available = false;
  let busy = false;

  function setMessage(text) { $("message").textContent = text; }
  function setServer(ok, message) {
    $("server-dot").className = `dot ${ok === null ? "checking" : ok ? "online" : "offline"}`;
    $("server-status").textContent = ok === null ? "接続確認中…" : ok ? "翻訳サーバーに接続済み" : "サーバー未接続";
    if (!ok && message) setMessage(message);
  }

  async function checkServer() {
    setServer(null);
    try {
      const response = await chrome.runtime.sendMessage({ type: "CHECK_SERVER" });
      setServer(response?.ok === true, response?.error);
    } catch {
      setServer(false, "バックグラウンド処理に接続できません。");
    }
  }

  function showStatus(status) {
    if (!status) return;
    const processed = status.completed + status.failed + status.skipped;
    const percent = status.total > 0 ? Math.min(100, (processed / status.total) * 100) : 0;
    $("bar").style.width = `${percent}%`;
    $("count").textContent = `${processed} / ${status.total}`;
    const labels = { idle: "待機中", translating: "翻訳中", translated: "翻訳完了", error: "翻訳を中断" };
    $("phase").textContent = labels[status.phase] || "待機中";
    restoreButton.disabled = !available || status.phase === "idle" || busy;
    translateButton.disabled = !available || busy || status.phase === "translating";
    translateButton.textContent = status.phase === "translated" ? "追加された文章も翻訳" : "ページ全体を翻訳";

    if (status.phase === "error") setMessage(status.lastError || "翻訳中にエラーが発生しました。");
    else if (status.phase === "translating") setMessage("表示中のテキストから順に翻訳しています。ページを閉じても処理は続きます。");
    else if (status.phase === "translated") {
      const suffix = status.limited ? "（翻訳対象が多いため、一部を省略しました）" : "";
      setMessage(`翻訳済み ${status.completed} 件 / エラー ${status.failed} 件 ${suffix}`);
    } else if (available) setMessage("翻訳ボタンでページ本文やボタンなどを日本語にします。");
  }

  async function pageMessage(type) {
    if (tabId === null) throw new Error("アクティブなタブがありません。");
    const response = await chrome.tabs.sendMessage(tabId, { type });
    if (!response?.ok) throw new Error(response?.error || "ページへの通信に失敗しました。");
    return response.status;
  }

  async function act(type) {
    if (!available || busy) return;
    busy = true;
    translateButton.disabled = true;
    restoreButton.disabled = true;
    try { showStatus(await pageMessage(type)); }
    catch (error) { setMessage(String(error.message || error)); }
    finally { busy = false; await poll(); }
  }

  async function poll() {
    if (!available || busy) return;
    try { showStatus(await pageMessage("PAGE_STATUS")); }
    catch { setMessage("ページとの接続が切れました。ページを再読み込みしてお試しください。"); }
  }

  async function initialize() {
    translateButton.disabled = true;
    restoreButton.disabled = true;
    $("retry-server").addEventListener("click", checkServer);
    translateButton.addEventListener("click", () => act("PAGE_TRANSLATE"));
    restoreButton.addEventListener("click", () => act("PAGE_RESTORE"));
    void checkServer();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
        $("phase").textContent = "対象外のページ";
        setMessage("Chromeの設定画面・新しいタブなどは翻訳できません。通常のWebページを開いてください。");
        return;
      }
      tabId = tab.id;
      await chrome.scripting.executeScript({ target: { tabId }, files: ["core.js", "content.js"] });
      available = true;
      await poll();
      setInterval(poll, 650);
    } catch (error) {
      setMessage(`このページには拡張機能を挿入できません: ${error.message || error}`);
    }
  }
  void initialize();
})();
