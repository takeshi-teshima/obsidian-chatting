# Obsidian Chatting

> Obsidian の Vault に常駐する agentic な AI アシスタント。スマホ・タブレット・デスクトップで同じ体験。

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <strong>日本語</strong>
</p>

<p align="center">
  by <strong>Yuxiao (o1xhack)</strong> ·
  <a href="https://github.com/o1xhack">GitHub</a> ·
  <a href="https://app.o1xhack.com">app.o1xhack.com</a>
</p>

<p align="center">
  <img src="../../assets/screenshot-settings.png" alt="iPhone のプロバイダ設定画面" width="260">
  <img src="../../assets/screenshot-chat-cn.png" alt="ウェブ検索を使った中国語の回答" width="260">
  <img src="../../assets/screenshot-chat-en.png" alt="箇条書き付きの英語回答" width="260">
</p>

---

## ハイライト

- **3 つのプロバイダから選べる** —— Anthropic API、OpenAI API、または ChatGPT アカウントでサインイン。
- **14 個の vault ネイティブツール** —— 読み・編集・検索・作成・リネーム・frontmatter・backlinks まで対応。
- **モバイルでも妥協なし** —— streaming・Node 専用モジュール・localhost コールバックに依存しません。iOS と Android はデスクトップと同じ動作。
- **選択範囲スコープ** —— テキストを選択して送信すると、アシスタントは選択範囲内だけを編集。
- **シークレットは OS のキーチェーンへ** —— `data.json` には絶対に書き込まれず、他端末に同期もされません。

## 3 つのプロバイダ

| プロバイダ | 認証 | 既定モデル | メモ |
|---|---|---|---|
| **Anthropic** | API キー | Claude Sonnet 4.6 | 適応的思考、ウェブ検索、プロンプトキャッシュ。 |
| **OpenAI** | API キー | Codex 5.3 | Responses API、推論、ウェブ検索。 |
| **ChatGPT アカウント** | ChatGPT サインイン | GPT-5.5 | OpenAI API キーの代わりに ChatGPT プランを使用。 |

> **ChatGPT アカウントサインインについて。** このプロバイダは ChatGPT アカウントでサインインし、リクエストは ChatGPT/Codex バックエンド経由(`api.openai.com` ではない)で送られます。Codex が有効な ChatGPT プランが必要です。利用できるモデルは Codex CLI のカタログに準じます。

## アシスタントができること

アシスタントは Obsidian Vault API と直結した 14 個のツールを持ち、用途別にグループ分けされています:

**読み取り**
- `read_document`、`read_file` —— 任意のノートまたは任意のファイルを開く。
- `search_vault` —— ファイル名とノート内容を検索。
- `list_files` —— Vault 構造を一覧。
- `get_backlinks` —— 指定ノートを参照する全バックリンクを取得。
- `get_properties` —— YAML フロントマターを読み取り。
- `get_current_datetime` —— ユーザーロケールでの現在日時。

**書き込み**
- `edit_document` —— ピンポイントの find-and-replace、挿入、全置換。
- `create_file` —— 新規ノート作成(親フォルダは自動作成)。
- `set_properties` —— YAML フロントマターの安全な統合/削除。

**管理**
- `rename_file` —— ファイルのリネーム/移動。リンクは自動追従。
- `delete_file` —— ゴミ箱へ移動(ユーザーのゴミ箱設定を尊重)。
- `open_document` —— エディタでファイルを開く。
- `ask_user` —— 曖昧なときはこちらに質問し返す。

方針は「編集する前に読む / 大きな書き換えより小さな修正を優先 / 一度確認したことは聞き直さない」です。

## 選択範囲スコープ

ノートでテキストを選択し、右クリックから **Send selection to Chat** を選びます。選択範囲は入力欄の上に pill として表示され、アシスタントはその範囲内だけを編集します。それ以外には触れません。

## クイックスタート

**1. BRAT 経由でインストール**

Community Plugins から [BRAT](https://github.com/TfTHacker/obsidian42-brat) をインストールし、**Add Beta plugin** → `o1xhack/obsidian-chatting` を入力。Community Plugins で **Obsidian Chatting** を有効化。

**2. 「設定 → Obsidian Chatting」でプロバイダを選択**

- **Anthropic / OpenAI** —— API キーを貼り付け。[SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) 経由で OS のキーチェーンに保存されます。
- **ChatGPT アカウント** —— **Connect ChatGPT** をクリック。ダイアログに検証 URL とワンタイム code が表示されます。任意のブラウザで URL を開き、サインインして code を入力。トークンは自動更新されます。更新に失敗した場合は明示的な *「session expired, reconnect」* の通知が表示されます。

**3. チャットを開く**

リボンアイコンまたはコマンドパレットから開けます。

## 設計原則

| 原則 | 意味 |
|---|---|
| **モバイルは後付けではない** | すべての変更を iOS と Android で検証。streaming・Node 専用モジュール・localhost コールバックに依存しません。 |
| **3 つの堅実なプロバイダ** | Anthropic + OpenAI で安定性、ChatGPT アカウントで API キー不要派をカバー。半端なプロバイダのバザールはやりません。 |
| **シークレットはキーチェーンへ** | API キーと OAuth 認証情報は Obsidian SecretStorage 経由。`data.json` には入らないため、他の端末に同期もされません。 |
| **Vault のインデックス化は行わない** | 上限つきの線形検索のみ。予測可能で、バックグラウンドジョブなし、モバイルでもメモリを圧迫しません。 |
| **会話は永続化** | チャット履歴は Obsidian 再起動後も残ります。ローカルの `chat-state.json` に保存され、同期されません。 |
| **モバイルでは右からスライドイン** | 右端から入るサイドバーで、下のドキュメントは見えたまま。 |

## ロードマップ

順序は約束しませんが、視野には入っています:

- Obsidian Community Plugins への提出。
- 複数会話履歴 + アーカイブ/検索。
- プロバイダがサポートする画像添付。
- 上流で新しくリリースされたプロバイダモデルへの自動追従。

要望があれば issue を立ててください。

## 開発

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run dev    # Watch モード
npm run build  # 本番ビルド
```

テスト用 vault にシンボリックリンク:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/obsidian-chatting
```

## ライセンス

[MIT](../../LICENSE)。元々は [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)(同じく MIT)から派生したもので、原版の著作権表示は `LICENSE` に保持されています。Obsidian Chatting は現在、独自のロードマップを持つ独立プロジェクトです。
