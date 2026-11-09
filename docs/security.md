# セキュリティ・データの取り扱い

この文書は現在の実装と設定の説明です。セキュリティ認証や、脆弱性が存在しないことの保証を示すものではありません。

## 翻訳データと通信

原文とページの文脈は、拡張のService Workerからオフスクリーンドキュメントへ渡し、同梱のwllamaとブラウザ内のモデルで処理します。翻訳本文を外部の翻訳APIへ送信する処理はありません。

| 通信先 | 用途 |
| --- | --- |
| Hugging Faceとモデル配信用ドメイン | GGUFモデルの取得・キャッシュ確認 |
| GitHub APIとリリース配信先 | Windows向け更新ツールによる最新版ZIPとチェックサムの取得 |

JavaScript・Worker・WASMは配布ZIPに同梱します。外部CDNから推論用コードを読み込む互換モードは無効化しています。モデルの取得先と設定は[engine.js](../extension/engine.js)、Chromeの接続先権限とCSPは[manifest.json](../extension/manifest.json)で確認できます。

## Chromeの権限

| 権限 | 用途 |
| --- | --- |
| `activeTab` / `scripting` | ユーザーが拡張を開いたタブの情報を取得し、翻訳用スクリプトを挿入 |
| `storage` | 原文・文脈・訳文のローカルキャッシュ |
| `offscreen` | ページ操作とは別の拡張ドキュメントで推論エンジンを動作させる |
| `unlimitedStorage` | 大きなモデルデータをブラウザ内へ保存 |
| Hugging Face関連のホスト権限 | モデル配布先からファイルを取得 |

`<all_urls>`、閲覧履歴APIの`history`、Cookie APIの`cookies`は要求していません。モデル配布先へのホスト権限は、翻訳対象ページへの一時アクセス権限とは別に宣言しています。

`activeTab`はユーザー操作で対象タブへの一時アクセスを許可するChromeの仕組みです。同じオリジン内の移動では権限が継続する場合があり、異なるオリジンへの移動やタブを閉じたときに失効します。[Chromeの公式説明](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)を参照してください。実際の挿入処理は[popup.js](../extension/popup.js)にあります。

## モデル出力の扱い

モデルの出力を`innerHTML`として挿入したり、JavaScriptとして実行したりしません。通常の訳文にはテキストノードと表示用属性を使用します。

リンク・強調を含む段落では、番号付きマーカーの過不足・重複・入れ子関係を検証し、元のDOM要素と新しいテキストノードだけで反映します。マーカーが壊れた訳文は適用しません。[content.js](../extension/content.js)と[実ブラウザの回帰テスト](../tests/paragraph.spec.mjs)で確認できます。

拡張ページのCSPはJavaScriptとWorkerの読み込み先を`self`に限定しています。`wasm-unsafe-eval`は同梱のWebAssemblyエンジンを実行するための設定です。

## 端末内の保存

- **モデル:** 拡張オリジンのOPFSに保存し、次回の準備で再利用します。
- **翻訳キャッシュ:** 原文・文脈を含むキーと訳文を`chrome.storage.local`へ最大600件保存します。上限を超えたものは順次除外します。ブラウザを閉じても保存されます。
- **原文復元用のDOM情報:** 翻訳中のページ内メモリで保持します。ページの再読み込みや終了でドキュメントが破棄されると失われます。
- **更新ツールの設定・バックアップ:** 固定配置先の`install.json`と`backups/`に保存します。設定には、同期対象として指定した旧Chrome登録先のパスも含まれます。

翻訳キャッシュを`chrome.storage.sync`へ同期する処理はありません。拡張独自の保存データ暗号化は実装していません。保存処理は[background.js](../extension/background.js)で確認できます。

## 更新ファイルの検証

Windows向け更新ツールは、GitHub ReleaseからZIPと`SHA256SUMS.txt`を取得し、SHA-256の一致、ZIPのパス、manifestの名前・形式・バージョン、必要なファイルの存在を確認してから配置します。既存版より古いバージョンへの置き換えも拒否します。

SHA-256の照合は、取得したZIPと公開チェックサムの一致を確認するものです。両方を同じGitHubリリースから取得するため、コード署名や独立した配布元認証の代わりにはなりません。

この更新ツールはChrome外のWindows PowerShellで動作します。管理者権限への昇格や、Chromeプロファイルの設定変更は行いません。インストール済み拡張の更新は、ユーザーがChromeで再読み込みした後に反映されます。

実装は[Update-PLaMo.ps1](../install/Update-PLaMo.ps1)、配布ZIPを使った確認は[Windows配置テスト](../scripts/test-install.ps1)にあります。
