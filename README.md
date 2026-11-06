# PLaMo Page Translate — Chrome拡張・ブラウザ内WebGPU版

**PLaMo 3 Translate 2B (GGUF Q4_K_M) をChrome拡張の中で動かし、英語などのWebページを日本語に翻訳する実験的なMVPです。** `llama-server`、CUDAの個別セットアップ、Pythonは必要ありません。

> **開発ステータス: v0.2.1 / プレビュー** — JavaScriptの自動テストは実施済みですが、RTX 4070でモデルを実際にロードして翻訳するE2E検証は未実施です。PLaMo 3とwllamaのWebGPU互換性は環境によって失敗する可能性があります。動かない場合はChrome拡張のエラー画面を共有してください。

## v0.2.1: WebGPU推論エラーの診断・回復

v0.2.0で「Invalid typed array length: 1163217991」が起きる場合、数値は
wllamaのGLUEバイナリヘッダー（0x45554c47）です。ネイティブ推論例外時に
C++がnullを返し、Workerが未更新のヘッダーを出力長と誤解する経路がありました。

v0.2.1では、nullポインタと出力長を検証して巨大な配列確保を防ぎ、
ネイティブ例外の診断情報をポップアップに表示します。モデルの推論が失敗した場合は
再初期化を案内します。**これは異常系の修正と診断強化であり、モデル・WebGPU固有の
根本的な推論失敗まで修正できたことを保証するものではありません。**

拡張を更新するには Actions の最新ビルドZIPを解凍して
`chrome://extensions/` から新しいフォルダーを読み込みます。
旧版は削除または無効化して重複起動を避けてください。
モデルデータは拡張IDが変わると再取得が必要になる場合があります。
v0.2.1でもエラーになる場合は**エラー全文**を送ってください。

## 主な機能

- 拡張ポップアップの **「モデルを準備」** を押すと、Hugging FaceからPLaMo 3 Translate **2B Q4_K_M（約1.81GB）** を取得。モデルはブラウザのOPFSにキャッシュされ、次回から再利用します。
- **「ページ全体を翻訳」** でテキストノードと一部の表示属性（見出し、ナビ、ボタン、placeholder/title/aria-label/alt等）を日本語に置換。HTMLタグは再生成しません。
- **「原文に戻す」**、可視領域の優先処理、進捗表示、翻訳結果のキャッシュ、DOMの動的更新の検出に対応します。
- モデルは**ローカルのWebGPU上で推論**。翻訳本文をクラウド翻訳APIへ送信しません。ただし**初回モデルダウンロードでHugging Faceへの通信が必要**です。
- 翻訳対象はユーザーがボタンを押した通常のHTTP/HTTPSページ。`chrome://`等のChrome内部ページ、ストア、iframe内のテキスト、Shadow DOM内の文字などは対象外です。

## 使い方（ビルド済みZIPを入手する場合）

1. GitHubの **Actions → Build and test browser-only extension** から最新の成功した実行を選び、Artifacts の `plamo-page-translate-webgpu` ZIPをダウンロードします（GitHubのサインインが必要な場合があります）。
2. ZIPを解凍します。**ビルド済みZIP**の直下に`manifest.json`と`wllama/`があることを確認してください。
3. Chromeの `chrome://extensions/` を開き、デベロッパーモードをONにします。
4. **「パッケージ化されていない拡張機能を読み込む」** をクリックし、解凍フォルダーを選択します。
5. 一般的な英語のWebページを開き、拡張アイコンから**「モデルを準備」** をクリック。モデルのダウンロードとGPUへのロードが完了するまで進捗を確認します。
6. **「ページ全体を翻訳」** をクリック。翻訳結果はページ内に反映されます。

**重要:** GitHubの **Code → Download ZIP** はソースコードです。そのまま`extension/`をChromeに登録しても、必要なWebGPUエンジンとWASMが含まれないため**動作しません**。Actionsのビルド成果物を使うか、以下のローカルビルドを実施してください。

## ソースからビルド（Windows）

Node.js 20以上が必要です。PowerShellでリポジトリを取得してから次を実行してください。

```powershell
npm install
npm run check
npm test
npm run build
```

生成された**`dist/`フォルダー**を`chrome://extensions/`から読み込みます（**`extension/`ではありません**）。変更を反映する場合は再ビルド・拡張の再読み込みを行ってください。

## 想定環境

- Windows + Chrome 124以降、WebGPUとハードウェアアクセラレーションを有効化
- NVIDIA RTX 4070 12GB + RAM 64GBは2Bモデルのサイズ上は十分ですが、VRAM使用量や実速度を保証するものではありません
- ブラウザにはモデル保存先として約2GB以上の空きディスク容量が必要です（推論時の追加VRAM/RAMも必要）

## アーキテクチャ

```text
Chrome拡張popup
 ├─ モデル準備・進捗の表示
 └─ ページ翻訳・原文復元
     ├─ content.js (TreeWalkerでDOMテキスト抽出・置換/復元)
     ├─ background.js (Service Worker / メッセージ・翻訳キャッシュ)
     └─ offscreen.html + engine.bundle.js (WebGPU推論・OPFSモデルキャッシュ)
          └─ wllama 3.8.1 (同梱の静的Worker + WebAssembly)
               └─ PLaMo 3 Translate 2B Q4_K_M (初回のみHFから取得)
```

Chrome Manifest V3のCSPでは動的な`blob:` Workerを生成できないため、ビルド時にwllama v3.8.1の`createWorker`を差し替え、`dist/wllama/`に固定Worker／WASMを生成します。`node scripts/build.mjs`を使わずに`extension/`直下を読み込むことはできません。wllamaが更新された場合はビルドスクリプトの互換性確認が必要です。

翻訳にはPLaMoのPFML3形式のraw completionを使用します。GPU初期化に失敗した場合は黙ってCPUに切り替えず、エラーを表示します。翻訳失敗時はページ上の原文を残します。

## 制限・注意

- **WebGPU上での実機動作は未検証です**。モデルがwllama同梱のllama.cppではサポートされない場合、WASM/llama.cppの更新が必要です。
- WebGPUとモデルのロードはオフスクリーンドキュメントで実行。Chromeが拡張を再起動すると再ロードが必要になる場合があります。モデルのキャッシュは保持されますが、ブラウザストレージ削除で失われます。
- モデルファイルの再配布はせず、公式のHugging Faceリポジトリからユーザー自身のブラウザで取得します。モデルの利用規約は[公式モデルカード](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF)を参照してください。
- 機密Webページに翻訳内容を残す処理ではなくても、Chrome拡張にはページへのアクセス権が必要です。外部APIには送信しませんがローカル翻訳結果は`chrome.storage.local`にキャッシュされます。
- 翻訳文字数はノードあたり分割処理・最大1200件に制限しています。ページが非常に大きい場合は全要素を処理できない場合があります。

## テスト

```bash
npm run check
npm test
npm run build
```

`npm test`はDOM操作とChromeメッセージルーティングをモックで検証します。GitHub Actionsは`dist/`をビルドし、ZIP成果物を生成します。実際のPLaMo GGUFを使った翻訳性能・Chrome実機のE2Eテストとは区別してください。

## 使用ソフトウェア

- [PLaMo 3 Translate 2B GGUF（Preferred Networks）](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF)
- [wllama（@wllama/wllama）](https://github.com/ngxson/wllama) — MIT License
- [esbuild](https://github.com/evanw/esbuild) — MIT License

リポジトリ内のアプリ本体は`LICENSE`を参照してください。依存ライブラリ／モデルの各ライセンスは別途適用されます。
