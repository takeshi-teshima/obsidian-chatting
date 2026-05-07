# Obsidian Chatting

**Vault と対話する。どの端末でも。好きなモデルで。**

<p align="center">
  <img src="../../assets/screenshot-mobile.jpeg" alt="Obsidian Chatting on mobile" width="320">
</p>

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

---

## なぜ Obsidian Chatting か

Obsidian の AI プラグインの多くは重すぎます。最初の質問にたどり着く前に大量の設定をいじらされ、スマホでは動かず、AI を「ノートを実際に動かしてくれるアシスタント」ではなく「ただのチャット欄」として扱っています。

Obsidian Chatting はその逆を行きます。

- **モバイルファースト。** iOS、Android、デスクトップで同じ体験。
- **3 つのプロバイダ、好きなものを。** Anthropic API、OpenAI API、または ChatGPT アカウントでサインイン。
- **生まれつき agentic。** アシスタントはノートを読み、編集し、作成し、リネームします — 14 個の vault ネイティブツール、単なるチャットではありません。
- **シークレットはあなたのもの。** API キーと OAuth トークンは OS のキーチェーンに格納。`data.json` には絶対に書き込まれず、同期もされません。

## 3 つのプロバイダ

| プロバイダ | 認証 | 既定モデル | メモ |
|---|---|---|---|
| **Anthropic** | API キー | Claude Sonnet 4.6 | 適応的思考、ウェブ検索、プロンプトキャッシュ。 |
| **OpenAI** | API キー | Codex 5.3 | Responses API、推論、ウェブ検索。 |
| **ChatGPT OAuth** *(実験的)* | ChatGPT サインイン | Codex 5.3 | API キーの代わりに ChatGPT アカウントを使用。ChatGPT/Codex バックエンド経由。可用性とクォータは変更される可能性あり。 |

> **実験的プロバイダについて：** ChatGPT OAuth は ChatGPT/Codex バックエンド（`api.openai.com` ではない）と通信します。安定した利用のためには引き続き OpenAI API Key プロバイダを推奨します。設計メモは [docs/chatgpt-oauth-plan.md](../chatgpt-oauth-plan.md) を参照。

## Vault に対してできること

アシスタントは Obsidian Vault API と直結した 14 個のツールを持ちます。

- 任意のノート（または任意のファイル）を読む。
- ノートをピンポイントの find-and-replace、挿入、または全置換で編集する。
- ファイル名と内容を検索する。
- 推奨パス付きで新規ノートを作成する。
- ファイルをリネーム／移動する（リンクは自動で追従）。
- ファイルをゴミ箱へ移動する。
- Vault 構造を一覧する。
- エディタでファイルを開く。
- YAML フロントマターのプロパティを読み書きする。
- 任意のノートのバックリンクを取得する。
- ユーザーのロケールで現在の日時を取得する。
- 曖昧なときはこちらに質問し返す。

方針は「編集する前に読む／大きな書き換えより小さな修正を優先／一度確認したことは聞き直さない」です。

## 選択範囲スコープ

ノートでテキストを選択し、右クリックから **Send selection to Chat** を選びます。選択範囲は入力欄の上に pill として表示され、アシスタントはその範囲内だけを編集します。それ以外には触れません。

## インストール

### BRAT 経由

1. Community Plugins から [BRAT](https://github.com/TfTHacker/obsidian42-brat) をインストール。
2. **Add Beta plugin** → `o1xhack/obsidian-chatting` を入力。
3. Community Plugins で **Obsidian Chatting** を有効化。

現状サポートしているのはこのインストール経路のみです。Obsidian Community Plugins への提出はロードマップにあります。

## セットアップ

**設定 → Obsidian Chatting** を開き、プロバイダを選択：

- **Anthropic / OpenAI：** API キーを貼り付け。プラグインは [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) を介して OS のキーチェーンに保存します。
- **ChatGPT OAuth：** **Connect ChatGPT** をクリック。ダイアログに検証 URL とワンタイム code が表示されます。任意のブラウザで URL を開き、ChatGPT にサインインして code を入力、Obsidian に戻ります。トークンは自動更新されます。更新に失敗した場合は明示的な *「session expired, reconnect」* の通知が表示されます。

以上です。リボンアイコンまたはコマンドパレットからチャットを開けます。

## 設計原則

| 原則 | 意味 |
|---|---|
| **モバイルは後付けではない** | すべての変更をモバイル上で検証。streaming・Node 専用モジュール・localhost コールバックに依存しません。 |
| **3 つの堅実なプロバイダ、肥大化しない** | Anthropic + OpenAI で安定性、ChatGPT OAuth で API キー不要派をカバー。半端なプロバイダのバザールはやりません。 |
| **シークレットはキーチェーンへ** | API キーと OAuth 認証情報は Obsidian SecretStorage 経由。`data.json` には入らないため、他の端末に同期もされません。 |
| **Vault のインデックス化は行わない** | 上限つきの線形検索のみ。予測可能で、バックグラウンドジョブなし、モバイルでもメモリを圧迫しません。 |
| **会話は永続化** | チャット履歴は Obsidian 再起動後も残ります。ローカルの `chat-state.json` に保存され、同期されません。 |
| **モバイルでは右からスライドイン** | 右端から入るサイドバーで、下のドキュメントは見えたまま。 |

## 開発

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run dev    # Watch モード
npm run build  # 本番ビルド
```

テスト用 vault にシンボリックリンク：

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/obsidian-chatting
```

## ライセンス

[MIT](../../LICENSE)。元々は [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)（同じく MIT）から派生したもので、原版の著作権表示は `LICENSE` に保持されています。Obsidian Chatting は現在、独自のロードマップを持つ独立プロジェクトです。
