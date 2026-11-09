# 実機検証記録（v0.3.0）

検証日: 2026-11-09（日本時間）

## 環境と方法

- Windows / NVIDIA GeForce RTX 4070 12GB
- Playwright 1.65.0 / Chrome for Testing 158.0.8127.18
- PLaMo 3 Translate 2B GGUF Q4_K_M（1,807,203,040 bytes）
- wllama 3.13.0 / n_ctx=4096 / GPUモード n_gpu_layers=999

旧wllama 3.8.1ではモデルのロード後、最初の `get_result` が `std::bad_function_call` で失敗することを同じ環境・モデルで再現した。3.13.0に更新後は日本語への翻訳が成功した。ネイティブ側のどの変更が直接修正したかまでは切り分けていない。

ブラウザの別プロファイルに実際の拡張を読み込み、拡張アイコン操作でactiveTabを取得してcontent scriptを挿入した。推論と通信処理はモックに置き換えていない。翻訳結果のキャッシュを消してから検証し、モデルのOPFSキャッシュは再利用した。記事ページではポップアップの翻訳・復元ボタンも操作した。

## 確認した内容

| ページ | 確認事項 |
| --- | --- |
| ローカル: 記事 | 見出し・リンク・本文・属性・タイトルの翻訳、コードと日本語の維持、追加コンテンツ、原文復元 |
| ローカル: 長文 | 1,500文字を超える反復文、分割、生成上限に達した場合の再分割、復元 |
| ローカル: フォーム | placeholder/title/aria-label/altの翻訳、入力値・password・contenteditable・hidden・翻訳禁止要素の保護、既存クリック処理の維持 |
| ローカル: 多言語 | 英語・フランス語・ドイツ語・スペイン語から日本語、日本語原文の維持 |
| ローカル: 動的更新 | 既存ノードの書き換え、文章と入力欄の追加、新しい原文への復元、再翻訳 |
| ローカル: 取り消し | 処理中に復元し、遅れて返る訳文がページを上書きしないこと |
| [Example.com](https://example.com/) | ページ全体の翻訳とタイトル・本文の復元 |
| [CERN / The World Wide Web project](https://info.cern.ch/hypertext/WWW/TheProject.html) | リンクの多いHTMLページの翻訳と復元 |
| [IANA / Example Domains](https://www.iana.org/help/example-domains) | ナビゲーションと記事の翻訳、復元 |
| [MDN / HTML](https://developer.mozilla.org/en-US/docs/Glossary/HTML) | 多数の本文・ナビゲーション・属性の翻訳、復元 |

全ページで翻訳対象が実際に処理され、失敗件数が0であること、日本語が表示されることを確認した。ローカルページは復元後のDOMとタイトルを比較した。公開ページはタイトルとmain要素内の全文（mainがなければbody）を比較した。入力欄にChromiumが自動追加する空のstyle属性はDOM比較から除外している。

さらに、ネットワークを無効化してオフスクリーンドキュメントを閉じ、新しくモデルをロードして「The weather is nice today. → 今日はいい天気だ。」の推論が成功することを確認した。

## 自動テスト

`npm run check`、`npm test`（21件）、`npm run build`を実行。エンジンの起動・試訳失敗・旧ブラウザ・GPU不在・推論中のCPU/GPU切替・出力打ち切りの再分割は回帰テストに含めている。

実モデルのテストは `npm run test:e2e`、公開ページを含む場合は `E2E_LIVE=1`。CPUの短い確認では `E2E_MODE=cpu E2E_CASES=article` を使える（PowerShellでは各変数を `$env:` で設定）。JSONの結果とスクリーンショットは `test-results/` に出力する。

## 確認範囲の限界

上記は選んだ10ページ／ケースと、この端末での機能確認である。全Webサイトや他GPUでの互換性、訳の専門的な正確性を保証しない。iframe、Shadow DOM、内部ページは対象外。インライン要素で文章が分割される場合の不自然な訳は既知の制限として残る。外部サイトの内容やDOM構造は将来変わり得る。

## GPUモードの最終結果

| ページ | 翻訳件数 | 失敗件数 | 所要時間 |
| --- | ---: | ---: | ---: |
| /article | 12 | 0 | 5.1秒 |
| /long | 3 | 0 | 29.1秒 |
| /forms | 8 | 0 | 1.6秒 |
| /multilingual | 5 | 0 | 1.1秒 |
| /dynamic | 3 | 0 | 1.4秒 |
| /cancel | 取り消し | 0 | — |
| https://example.com/ | 8 | 0 | 4.7秒 |
| https://info.cern.ch/hypertext/WWW/TheProject.html | 44 | 0 | 8.8秒 |
| https://www.iana.org/help/example-domains | 44 | 0 | 9.3秒 |
| https://developer.mozilla.org/en-US/docs/Glossary/HTML | 754 | 0 | 130.2秒 |

所要時間はモデル準備後、翻訳操作から検証・スクリーンショット・復元までのテスト計測値です。動的更新の追加試験も含みます。初回モデルダウンロードとロードは含みません。
