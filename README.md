# PLaMo Page Translate

**PLaMo 3 Translate 2Bで、ChromeのWebページをローカルGPU上で丸ごと日本語に翻訳する拡張機能（MVP）です。**

- ページ全体を翻訳：見出し、本文、ナビゲーション、ボタン、および`placeholder` / `title` / `alt` / `aria-label`を対象にします。
- HTMLを再生成せず、テキストノード・一部のテキスト属性だけを置換します。
- 表示中のテキストを優先して翻訳。最大2件並列、重複テキストはキャッシュ。
- 原文に戻せます。React等で後から追加されたDOMも`MutationObserver`で検出します。
- 翻訳対象のテキストは**外部翻訳APIに送らず、ローカルの`llama-server`だけに送信**します。
- Manifest V3 / Vanilla JavaScript / ビルド不要。モデル本体は配布物に含みません。

> **状態**: 動作確認用MVP。Node.jsでコードの自動テストは実施できますが、Chrome＋実モデルでの最終的な動作検証は利用者のWindows環境で必要です。

## 対象PC

Windows、RAM 64GB、NVIDIA GeForce RTX 4070 12GBを想定。まず2Bの **Q4_K_M（約1.81GB）** を使います。GPUに収まりやすい規模ですが、ページ単位の実速度はページのテキスト数、CUDA環境、GPU利用状況によって変動します。

## 1. llama.cpp（CUDA対応）を用意する

[llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) から最新の **Windows x64 CUDA用** `llama-server.exe` を含む配布物をダウンロードして展開します。必要に応じて、対応するCUDAランタイムDLLパッケージも同じフォルダーに配置します（リリースの説明を参照）。NVIDIAドライバーも更新してください。

例：`C:\llama.cpp\llama-server.exe`

> CPUビルドをダウンロードしてしまうとRTX 4070を利用できません。GPU対応ビルドを使ってください。

## 2. モデルをダウンロード

PowerShellを開き、このリポジトリのディレクトリで以下を実行します。Python 3.10以上が必要です。

```powershell
.\scripts\setup-model.ps1
```

次の2ファイルが`models/plamo-3-translate-2b-GGUF/`に保存されます。

- `plamo-3-translate-2b-Q4_K_M.gguf`
- `chat_template.jinja`（**必須**。GGUF埋め込みの旧テンプレートを使わないため）

PowerShellで`.ps1`スクリプトがブロックされる場合は、現在のプロセスだけ有効なポリシーを設定できます：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## 3. ローカル翻訳サーバーを起動

```powershell
.\scripts\start-server.ps1 -LlamaServer "C:\llama.cpp\llama-server.exe"
```

`http://127.0.0.1:8000/health`が200 OKを返せば準備完了です。起動スクリプトは以下の設定を指定します。

- **ローカル専用** `--host 127.0.0.1 --port 8000`
- `--alias plamo-3-translate`（拡張のAPIリクエストと一致）
- `--chat-template-file chat_template.jinja --no-prefill-assistant`
- `-ngl 99`（モデル層をGPUにオフロード）
- `-c 8192 -np 2`（コンテキスト長と並列スロット）

VRAMが足りない、またはCUDA関連のエラーが出る場合は、`-ContextSize 4096 -Parallel 1`も試せます。**このPowerShellウィンドウは翻訳中も開いたままにしてください。**

接続テスト（任意）：

```powershell
$body = @{
  model = 'plamo-3-translate'
  messages = @(@{ role = 'user'; content = 'Welcome to our website.' })
  chat_template_kwargs = @{ target_lang = 'ja'; form = 'plain' }
  temperature = 0
  max_tokens = 128
  stop = @('<|plamo:tag|>', '<|plamo:bos|>')
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/v1/chat/completions' `
  -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

## 4. Chromeに読み込む

1. Chromeで `chrome://extensions/` を開く。
2. 右上の **デベロッパーモード** をオンにする。
3. **パッケージ化されていない拡張機能を読み込む** をクリック。
4. このリポジトリの **`extension` フォルダー** を選択する（ルートではありません）。
5. 英語のWebページを開き、拡張のアイコンから **「ページ全体を翻訳」** を押す。
6. 元に戻したい場合は **「原文に戻す」** を押す。

拡張のポップアップを閉じても、そのタブの翻訳は続きます。ページをリロードすると元の状態に戻り、再度翻訳操作が必要です。

## 振る舞い・技術仕様

```
Chrome popup
    ├─ タブに core.js + content.js をオンデマンド挿入（activeTab権限）
    └─ 翻訳開始・復元・進捗表示
Chrome content script（isolated world）
    ├─ DOMの可視テキストノード・指定属性を列挙
    ├─ 表示領域優先、1リクエスト最大900文字程度に分割
    ├─ 2並列で背景スクリプトに依頼
    └─ 原文保持、DOM更新監視、テキストを直接置換
Chrome service worker
    ├─ 原文＋訳文のLRU風キャッシュ（最大500件、storage.local）
    ├─ 同時・同一文リクエストをまとめる
    └─ localhost:8000 の llama-server へリクエスト
PLaMo 3 Translate 2B Q4_K_M (CUDA)
```

翻訳APIは公式の **Chat Completions** 形式で、`chat_template_kwargs: { target_lang: "ja", form: "plain" }`を渡します。モデルは原文の言語を自動判定します。英語以外も対応言語であれば翻訳対象です。

安全とプライバシーのため、外部Webページ側でなく**拡張のService Workerからのみ**localhostにアクセスし、通信先を`127.0.0.1:8000`に固定しています。アクセスするWebページは拡張アイコンを押したアクティブタブのみです。ネットワーク越しにサーバーを公開しないでください。ローカルサーバーは同じPC上の他のアプリケーションから利用できる場合があります。

### 現時点の制限

- **翻訳単位は個々のDOMテキストノード**です。文が`<strong>`など複数ノードに分かれると文脈が切れ、自然さが低下することがあります。
- クロスオリジンiframe、Chrome内部ページ、PDFビューアー、画像に焼き込まれた文字、CSS `::before` / `::after` は対象外です。Shadow DOMも初期版では対象外です。
- 一度に翻訳する対象は最大1,200件まで。過剰なページで意図しない大量生成を防ぐための制限です。
- SPAサイトのDOM再描画に追従しますが、一部のアプリケーションではフレームワーク側がテキストを再上書きしたり、翻訳の実施でレイアウトが変わったりする可能性があります。
- サイト側のCSSによっては、非表示状態でスキャンから除外した要素が後から表示されても、自動で翻訳されない場合があります。
- ページから抽出するのはテキストと一部属性だけです。`innerHTML`や`eval`は使わず、フォーム入力内容、スクリプト、コードブロック、`contenteditable`領域は翻訳しません。
- キャッシュは既定で`chrome.storage.local`に保存されます。閲覧したサイトの**翻訳対象文字列と訳文がローカル拡張領域に残ります**。共有PCや機密ページで使う場合は留意してください。消去したい場合は拡張データを削除します。

## 開発・テスト

Node.js 20以降（外部パッケージなし）。

```powershell
npm test
npm run check
```

手動テストには`tests/fixtures/demo.html`を使えます。リポジトリのルートで`python -m http.server 8765`を起動し、`http://127.0.0.1:8765/tests/fixtures/demo.html`を開いて翻訳を試してください。

## ライセンスとモデル出典

拡張のソースコードは **MIT License** です。モデルを同梱・再配布していません。PLaMo 3 Translate 2Bの重みは **PLaMo Community License** に従います。個人・学術など非商用利用では無償ですが、**商用利用では登録または別途契約が必要な場合があります**。利用目的に応じて公式ライセンスを確認してください。

- [PLaMo 3 Translate 2B GGUF公式README（日本語）](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/blob/main/README_ja.md)
- [PLaMo 3 Translate 2Bモデルファイル](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/tree/main)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)

## GitHubで新しいリポジトリにする

GitHub CLIにログイン済みなら、プロジェクトのルートで以下を実行します（公開リポジトリの例です）。非公開なら`--public`を`--private`に変更してください。

```powershell
git init
git add .
git commit -m "Initial Chrome extension for PLaMo 3 Translate 2B"
git branch -M main
gh repo create plamo-page-translate --public --source=. --remote=origin --push
```

GitHub CLIを使わない場合は、GitHub上で空のリポジトリを作り、上記ソースをアップロードしてください。`.gitignore`により`models/`の重みはGitHubに入りません。