# PLaMo Page Translate

Webページを、PC内の **PLaMo 3 Translate 2B / GGUF Q4_K_M** で日本語にするChrome拡張です。WebGPUで推論し、GPUが使えない場合はCPUモードも選べます。Python、CUDA、ローカルサーバーの準備は不要です。

**v0.3.0** では、旧版で最初の推論時に発生した `std::bad_function_call` を実機で再現し、wllamaを3.8.1から3.13.0へ更新して解消しました。モデルの読み込み後に実際の日本語翻訳を試し、成功してから「準備完了」を表示します。

## インストール

1. [Releases](https://github.com/Kaito-Rowing/PLaMo-Page-Translate/releases/latest) から **`plamo-page-translate-webgpu.zip`** をダウンロードして解凍します。
2. Chromeの `chrome://extensions/` を開き、右上の **デベロッパーモード** をONにします。
3. **「パッケージ化されていない拡張機能を読み込む」** で、`manifest.json` がある解凍フォルダーを選びます。
4. 普通のWebページを開き、拡張アイコンから **「GPUモデルを準備」** を押します。初回は約1.81GBを取得します。
5. 日本語への試訳が成功して **「モデル準備完了」** と表示されたら、**「ページ全体を翻訳」** を押します。
6. **「原文に戻す」** で翻訳を取り消せます。処理中の取り消しにも対応しています。

**更新時:** 同じ解凍フォルダーへ新しいZIPの内容を上書きし、拡張一覧の再読み込みを押してください。別フォルダーに登録すると拡張IDが変わり、モデルの再取得が必要になる場合があります。旧版を重複して有効にしないでください。

GitHubの **Code → Download ZIP はソースコード**です。そのままでは推論用WASMが入っていないため動作しません。ReleaseのZIP、[Actions](https://github.com/Kaito-Rowing/PLaMo-Page-Translate/actions) の成果物、または下記のビルドを使ってください。

## 必要な環境

- **Chrome 137以降（最新版推奨）**。WASM Memory64と[JSPI](https://v8.dev/blog/jspi)を使用します。旧版READMEのChrome 124という記載は誤りでした。
- GPUモードではWebGPUとハードウェアアクセラレーションが必要です。
- モデル保存用に約2GB以上の空きディスク容量と、推論用の追加RAM／VRAMが必要です。
- 実機検証はWindows、RTX 4070 12GB、Chrome for Testing 158で実施しています。他のGPU・OSでの速度や動作は未検証です。

## できること

- 見出し、本文、リンク、ボタンと、placeholder/title/aria-label/alt等の属性を翻訳します。HTML自体を生成し直さないので、ページのイベント処理を維持します。
- 表示領域を優先し、追加された文章やサイトによる文章の書き換えも検出します。
- 原文復元、翻訳結果のローカルキャッシュ、進捗表示に対応します。
- 長文は分割します。生成上限で訳文が切れた場合は、さらに短く分けて再試行します。途中の訳文はページに反映しません。
- モデルをOPFSに保存します。一度取得すれば、ネットワークなしでモデルを再読み込みして翻訳できます。

## 対象外・制限

- `chrome://`等の内部ページ、Chromeウェブストア、PDFビューアー、iframe、Shadow DOM内の文章は対象外です。
- コードブロック、編集中の文章、入力済みフォーム値、非表示要素、`translate="no"`、`.notranslate`は変更しません。
- 1回のセッションで最大1200件です。非表示から表示に変わった文章は、翻訳ボタンをもう一度押して再走査できます。
- DOMのテキストノードごとに翻訳するため、文の途中にリンクや強調タグがある場合は訳のつながりが不自然になることがあります。訳の正確性を保証するものではありません。
- タブを閉じる・ページを再読み込みすると、そのページの翻訳と復元情報は消えます。拡張やブラウザの再起動後はモデルを再準備してください。ダウンロード済みモデルは再利用します。

## 困ったとき

- **WebGPUが使えない:** Chromeを更新し、設定のハードウェアアクセラレーションを確認してください。**「CPU診断モードで準備」**でも翻訳できますが、GPUより遅くなります。
- **モデル準備／翻訳に失敗する:** エラー全文を確認し、モデルの準備をやり直します。モデルのキャッシュは削除しません。
- **更新後も `std::bad_function_call` が出る:** v0.3.0のZIPを使い、拡張一覧で再読み込みしたこと、旧版が無効になっていることを確認してください。
- **ページに接続できない:** 通常のHTTP/HTTPSページを開き、ページと拡張を再読み込みしてください。

## ソースからビルド

Node.js 22以上を推奨します（ビルド自体は20以上）。

```powershell
npm ci
npm run check
npm test
npm run build
```

生成した **`dist/`** をChromeへ登録します。`extension/` はソース用です。

依存バージョンは `package-lock.json` で固定しています。GitHub Actionsでも同じ手順で検証・ビルドします。

## 実モデルを使ったブラウザテスト

```powershell
npx playwright install chromium
npm run build
npm run test:e2e
```

初回は実際のPLaMoモデルを約1.81GB取得します。GPU、通信、空きディスクが必要です。普段のブラウザとは別の `.e2e-profile/` にキャッシュし、結果とスクリーンショットを `test-results/` に保存します。`npm test` や通常のCIはモデルをダウンロードしません。

公開サイトも含める場合:

```powershell
$env:E2E_LIVE = '1'
npm run test:e2e
```

CPUモードを検証する場合は `$env:E2E_MODE = 'cpu'` を設定します。テストは翻訳結果のキャッシュを消してから開始するため、ページの翻訳もそのモードで推論します。モデルのOPFSキャッシュは保持します。

テストは実際の拡張アイコン操作で `activeTab` 権限を取得し、拡張のポップアップ、Service Worker、オフスクリーンドキュメント、固定Worker、WASMを通して翻訳します。記事・長文・フォーム・多言語・動的更新・処理取り消しに加え、`E2E_LIVE=1` ではExample.com、CERN、IANA、MDNを確認します。最後にネットワークを切り、モデルの再ロードと試訳を確認します。

[検証結果](docs/verification.md)に環境・件数・確認範囲を記載しています。

## 構成

```text
popup.html / popup.js
  └ background.js  メッセージ転送・翻訳キャッシュ
      ├ content.js + core.js  テキスト抽出・DOM反映・復元
      └ offscreen.html + engine.bundle.js
          └ wllama 3.13.0 / 固定Worker / WebAssembly
              └ PLaMo 3 Translate 2B Q4_K_M / OPFS
```

Manifest V3のCSPで禁止される `blob:` Workerを避けるため、ビルド時にwllamaのWorker生成処理を固定ファイルへ差し替えます。ネイティブエラー時の不正なGLUE応答も検証します。依存更新で構造が変わった場合、ビルドを停止する設計です。外部CDNから実行コードを取る互換モードは無効にしています。

## データとライセンス

翻訳本文は外部APIへ送信しません。初回のモデル取得時にはHugging Faceへ通信します。翻訳結果は `chrome.storage.local`、モデルはOPFSに保存します。ページへのアクセスは、ユーザーが拡張を開いたタブに対する `activeTab` を使います。

アプリ本体は[MIT License](LICENSE)、[wllama](https://github.com/ngxson/wllama)もMIT Licenseです。ビルド成果物にライセンスを同梱します。モデルの重みはZIPに含みません。[公式モデルカード](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF)とPLaMo Community Licenseに従って利用してください。
