# yomiyasuMCP

[yomiyasu](https://github.com/nanaism/yomiyasu)をChatGPTの会話から使う、Cloudflare Workers用のリモートMCPサーバーです。ChatGPTが推敲し、MCPが指示書・参照資料・機械検査を提供します。AI APIキーは不要です。

## 構成

```text
ChatGPT → HTTPS /mcp → TypeScript Worker
                           ├─ 指示書・参照資料
                           ├─ レシートの署名・本文照合
                           └─ Service Binding → Python Worker（直接公開しない）
                                                    └─ 上流のlint・diff・資料照合
```

上流は **3.1.0 / db78b9bc5e868549b517a037df7a4d1c93edac23** に固定しています。`upstream.json`には取り込んだ42ファイルのSHA-256を記録しています。`npm run prepare:data`が改変を検出し、配信用データを生成します。起動時にGitHubから最新版を取得しません。

## ChatGPTから使う

公開済みの接続先は `https://yomiyasu-mcp.namiyama814.workers.dev/mcp` です。自分で配置する場合は、後述のデプロイ手順で表示されるURLに `/mcp` を付けます。

接続用の非公開プラグイン定義は `plugin/yomiyasu-mcp/`、作成済みZIPは `dist/yomiyasu-mcp.zip` にあります。今回のアカウント登録は、ワークスペースの「MCPを含むプラグインを利用する権限」がなく拒否されました。サーバーは稼働中ですが、ChatGPTの実会話での確認は未実施です。登録には、その権限がある環境または管理者による権限設定が必要です。

[OpenAIの接続手順](https://developers.openai.com/plugins/deploy/connect-chatgpt)に沿って登録します。アカウント・ワークスペースのポリシーにより、カスタムMCPの追加が制限される場合があります。

1. [ChatGPT Plugins](https://chatgpt.com/plugins)を開き、追加ボタンから **Add custom MCP server** を選びます。
2. 名前を `yomiyasu`、接続先を `https://<WorkerのURL>/mcp` にします。認証は「なし」です。
3. 内容を確認して **Create as a plugin** を選び、検出された5つのツールを確認します。
4. 新しい会話で `@` からyomiyasuを選び、次のように頼みます。

```text
次の文章をyomiyasuで推敲してください。
get_instructionsから始め、必要な参照資料、lint、check、verifyを使ってください。

（原文）
```

`verify`の`matches: true`を確認したあと、検査済みの本文を変更せずに提出する手順です。機械検査は意味保持や読みやすさの合格を示しません。

## ローカル開発

Node.js 22以降、Python 3.12以降、[uv](https://docs.astral.sh/uv/getting-started/installation/)が必要です。Python Workersの実行環境はpywranglerが準備します。

```sh
npm ci
cp .dev.vars.example .dev.vars
```

`openssl rand -hex 32`などで作ったランダムな値を、`.dev.vars`の`RECEIPT_SECRET`に設定してください。32バイト以上が必要です。`.dev.vars`はGit管理対象外です。

ターミナルを2つ使います。

```sh
# 1つ目: Python Worker（localhost:8788）
npm run dev:checker
```

```sh
# 2つ目: MCP Worker（localhost:8787）
npm run dev -- --port 8787
```

Wranglerの表示で `CHECKER` が `local [connected]` になっていることを確認します。

```sh
npm run typecheck
npm test
npm run test:integration
```

統合テストは実際のMCPクライアントから両Workerを呼び、初期化、5ツール、Python検査、引数検証、照合、並行呼び出しを検証します。`npm test`には上流CLIとの結果一致テストも含まれます。

## デプロイ

[Python Workers](https://developers.cloudflare.com/workers/languages/python/)と[CloudflareのMCPガイド](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)を利用しています。Python Workerを先に、同一Cloudflareアカウントに配置します。

```sh
npx wrangler login
# 複数アカウントがある場合は、配置するアカウントを指定します。
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
npm run deploy:checker
npm run deploy
npx wrangler secret put RECEIPT_SECRET
```

Secretには本番専用のランダムな値を入力します。未設定・32バイト未満の場合、`check`は検査前に失敗します。Secretを変更すると、変更前のレシートは検証できなくなります。Python Workerの `workers_dev` と `preview_urls` は無効です。

```sh
MCP_URL=https://<WorkerのURL>/mcp npm run test:integration
```

実デプロイを使った統合テストが通ったらChatGPTへ登録し、上の例文でツール選択と提出までの動作を確認してください。MCPクライアントのテストと、ChatGPTが実際に指示書に従うことの確認は別です。

## MCPツール

| ツール | 入力 | 出力 |
| --- | --- | --- |
| `get_instructions` | `{}` | 上流指示書、MCP用手順、参照資料ID、バージョン |
| `get_reference` | `id` | 指定した参照資料の全文 |
| `lint` | `text`、任意の`doc_type`・`reader` | 上流lintの結果 |
| `check` | `original`・`final`、任意の`materials`・`doc_type`・`reader`・`stance` | 原文と最終稿のlint、diff、資料照合、署名付き`receipt` |
| `verify` | `final`・`receipt` | `matches`と検査条件 |

`doc_type`: `pr`, `article`, `incident`, `proposal`, `minutes`, `manual`, `slides`, `essay`, `formal`, `promo`, `mail`, `paper`, `script`。
`reader`: `expert`, `informed`, `general`。`stance`: `勧め`, `決まり`, `説明`。指定しない値は省略します。`materials`は資料本文の配列で最大16件です。

検査・照合対象の本文合計はUTF-8で **128 KiB** までです。JSONエンベロープは1 MiB、ツールの結果は4 MiBまでです。上限超過・上流差分の詳細省略・検査失敗はエラーにし、レシートを発行しません。自動分割や結果の切り捨ては行いません。

レシートはHMAC-SHA-256で署名し、原文・最終稿・資料のハッシュ、検査条件、実行した検査、上流コミット、アダプター版を含めます。本文は含めません。改行・末尾改行・BOMを含め、渡された本文のUTF-8バイト列をそのまま照合します。レシートは検査の実施と本文一致を確認するためのもので、人の承認や推敲品質の証明には使いません。

## 元のCLIとの対応と制限

- `lint`は上流の`lint_text`、`check`は原文・最終稿の`lint_text`、`diff`、資料があるときの`ground`を呼びます。検査アルゴリズムは変更していません。
- `yomiyasu_check.py run/verify`は呼びません。CLIの状態フォルダ、履歴、再実行管理、フック、ローカル辞書、元ファイル更新は対象外です。
- MCPの`verify`は署名付きレシートを使う独自の本文照合です。CLIの記録や状態行を生成しません。
- CLIの読み込み時の改行・BOM正規化は行いません。直接関数に渡す内容はMCPの入力文字列そのものです。
- ChatGPTによる意味の確認、候補の判断、最終稿の提出はChatGPT側で実施します。本文だけを返す依頼でも、検査手順は同じです。

## データの扱い

認証はありません。URLを知る第三者も利用でき、Cloudflareの利用枠を消費します。検査時には原文、推敲後本文、指定された資料をCloudflareに送ります。

アプリケーションは本文をDB・KV・R2・ファイルへ保存せず、ログにも出しません。本文は検査中にメモリ上で扱います。Pythonの一時ファイルに置くのは公開済みの参照資料だけです。両WorkerのObservabilityは無効にしています。Cloudflareや利用するチャットサービス側のデータ取り扱いは、それぞれの設定・規約に従います。

## ライセンス

このリポジトリはMITです。上流のMITライセンスとUnicodeデータのライセンスは、それぞれ `checker/src/vendor/LICENSE` と `checker/src/vendor/UNICODE-LICENSE.txt` に同梱しています。固定した上流スナップショットは `checker/src/vendor/` にあります。
