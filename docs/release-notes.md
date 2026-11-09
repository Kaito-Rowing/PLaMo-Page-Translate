固定フォルダーへの配置と更新ツールを追加した版です。

1. **plamo-page-translate-webgpu.zip** を解凍し、**Update-PLaMo.cmd** を実行。
2. Chromeで `%LOCALAPPDATA%\PLaMoPageTranslate\extension` を一度登録。
3. 次回以降は `%LOCALAPPDATA%\PLaMoPageTranslate\Update-PLaMo.cmd` を実行し、拡張とページを再読み込み。

更新ファイルを検証し、前の版をバックアップします。Chromeのモデル保存領域は変更しません。

ポップアップの手動テストボタンを削除し、CPUモードの表記を整理しました。モデル準備時の自動確認は維持しています。未使用コードと重複テストを削除し、README・開発手順・変更履歴も整理しています。

単体テスト、実ChromiumのDOMテスト、Windows PowerShell 5.1での配置・更新テストをCIで実行し、成功したZIPを公開しています。

[使い方](https://github.com/Kaito-Rowing/PLaMo-Page-Translate#readme) / [変更履歴](https://github.com/Kaito-Rowing/PLaMo-Page-Translate/blob/main/CHANGELOG.md)

Chromeウェブストア配布ではないため、Chromeの再読み込みボタンだけでは最新版の取得は行われません。登録先を変更した場合、モデルの再取得が必要になる場合があります。専門用語・多義語の誤訳など、モデルによる訳の限界は残ります。
