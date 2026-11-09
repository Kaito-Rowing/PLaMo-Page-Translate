# 開発・検証

Node.js 22を推奨します。依存関係はlockfileで固定しています。

```powershell
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:dom
npm run build
```

`dist/` が配布・Chrome登録用のフォルダーです。`extension/` を直接登録しても、推論用WASMと固定Workerがないため動作しません。

## 検証の役割

- `npm test`: テキスト処理、推論エンジンの起動・失敗・切替、メッセージとキャッシュ、生成Workerの構文とWASMを確認。
- `npm run test:dom`: 実Chromiumで、段落全体の翻訳要求、リンク・コード・イベント処理の保持、復元、書式欠落時の原文保持等を確認。推論は固定応答です。
- `npm run test:e2e`: 実モデルでページ操作から翻訳・復元・オフライン再ロードまで確認。初回に約1.81GBを取得し、GPUとディスク容量が必要です。通常のCIでは実行しません。
- `scripts/test-install.ps1`: 実際の配布ZIPで、新規配置、上書き、以前のChrome登録先との同期、バックアップ、不完全なZIPで既存版を壊さないことを確認。Windows PowerShell 5.1でも実行します。

旧ローカルサーバー用の未使用ヘルパーとそのテスト、自作DOMによる重複テスト、生成コードの文字列をなぞるだけのアサーションを削除しています。実モデルや実ブラウザで検証するケースを件数稼ぎのために増やしません。

## 実モデルの確認

```powershell
npm run build
npm run test:e2e
```

7種類のローカルページには、GitHub APIから取得したdsh-memory-dreamのREADME HTMLも含みます。`E2E_LIVE=1` ではExample.com、CERN、IANA、MDNも確認します。`E2E_MODE=cpu` でCPUを使えます。`E2E_CASES=article,forms` のように対象も絞れます。PowerShellでは `$env:E2E_CASES = 'article,forms'` の形式で設定してください。

モデルは `.e2e-profile/`、結果は `test-results/` に保存します。テスト開始時に翻訳結果のキャッシュは消しますが、モデルのOPFSキャッシュは再利用します。普段使うChromeのプロファイルは変更しません。

以前の実機記録: [v0.3.0](verification.md) / [v0.3.1](paragraph-translation.md)。件数は各版の測定結果であり、翻訳品質の採点ではありません。

## Windowsの配置・更新

配布ZIPの `Update-PLaMo.cmd` は、Windows PowerShellをそのプロセスだけの実行設定で起動します。システムの実行ポリシーは変更しません。

更新ツールは最新リリースのZIPとSHA256SUMSを取得し、展開したパッケージを検証してから `%LOCALAPPDATA%\PLaMoPageTranslate\extension` を置き換えます。前の版は `backups/` に残します。Chromeプロファイルやモデル保存領域は変更しません。

開発用にローカルZIPを配置する場合:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File install/Update-PLaMo.ps1 -PackagePath C:\path\to\plamo-page-translate-webgpu.zip
```

`-InstallRoot` は配置先の親フォルダー、`-AlsoUpdatePath` はすでにChromeに登録されたフォルダーの同期用です。同期先はローカルの `install.json` に保存し、次回も更新します。既存フォルダーのmanifest名を確認してから書き込みます。任意のChrome内部設定を書き換えたり、拡張を自動登録したりはしません。

## リリース

1. `package.json` と `extension/manifest.json` のバージョン、CHANGELOG、`docs/release-notes.md` を更新。
2. PRの検証・ビルド・Windows配置テストが成功してからmainへマージ。
3. `v0.4.0` のように、パッケージと同じ版のタグをpush。

タグのCIが再検証し、ZIPとSHA256SUMSをGitHub Releaseへ公開します。Windows配置テストに失敗した版は公開しません。モデルの重みとテスト専用ファイルは配布ZIPに含みません。
