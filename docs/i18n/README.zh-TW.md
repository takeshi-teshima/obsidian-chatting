# Obsidian Chatting

**與你的庫對話。任何裝置。任何模型。**

<p align="center">
  <img src="../../assets/screenshot-mobile.jpeg" alt="Obsidian Chatting on mobile" width="320">
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <strong>繁體中文</strong> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  by <strong>Yuxiao (o1xhack)</strong> ·
  <a href="https://github.com/o1xhack">GitHub</a> ·
  <a href="https://app.o1xhack.com">app.o1xhack.com</a>
</p>

---

## 為什麼是 Obsidian Chatting

Obsidian 上多數 AI 外掛都太重。問第一個問題之前要點一打設定，手機上動不動就出狀況，而且把 AI 當成一個聊天框，不是一個能真正動你筆記的助理。

Obsidian Chatting 反其道而行：

- **行動優先。** iOS、Android、桌面端體驗一致。
- **三個 Provider，自己選。** Anthropic API、OpenAI API，或直接用你的 ChatGPT 帳號登入。
- **天生 agentic。** 助理會讀、改、建、重新命名你的筆記 —— 14 個原生 vault 工具，不只是聊天。
- **密鑰永遠是你的。** API key 與 OAuth token 全部進作業系統鑰匙圈，絕不寫進 `data.json`，絕不被同步。

## 三個 Provider

| Provider | 認證方式 | 預設模型 | 備註 |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | 自適應思考、網路搜尋、prompt 快取。 |
| **OpenAI** | API key | Codex 5.3 | Responses API、推理、網路搜尋。 |
| **ChatGPT OAuth** *(實驗性)* | 登入 ChatGPT | Codex 5.3 | 以 ChatGPT 帳號代替 API key。走的是 ChatGPT/Codex 後端，可用性與配額可能變動。 |

> **關於實驗性 Provider：** ChatGPT OAuth 走的是 ChatGPT/Codex 後端（不是 `api.openai.com`）。OpenAI API Key 仍是推薦的穩定路徑。設計細節見 [docs/chatgpt-oauth-plan.md](../chatgpt-oauth-plan.md)。

## 它能為你的庫做什麼

助理掛在 Obsidian Vault API 上，共 14 個工具：

- 讀取任意筆記（或任意檔案）。
- 編輯筆記 —— 精準的尋找替換、插入、整段替換。
- 搜尋檔案名稱與內容。
- 建立新筆記，自動給出建議路徑。
- 重新命名或移動檔案（連結自動更新）。
- 把檔案丟進垃圾桶。
- 瀏覽庫結構。
- 在編輯器中開啟某個檔案。
- 讀寫 YAML frontmatter 屬性。
- 找出指向某筆記的所有 backlink。
- 取得當前日期時間（你的時區與語系）。
- 不清楚時反問你一句。

策略是：先讀再改、能小改不大改、使用者確認過的事不再問第二次。

## 選取作用域

在筆記中選一段文字，右鍵 → **Send selection to Chat**。選取會以 pill 形式出現在輸入框上方，助理只動選取裡的內容，其餘維持原樣。

## 安裝

### 透過 BRAT

1. 從社群外掛安裝 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. **Add Beta plugin** → 輸入 `o1xhack/obsidian-chatting`。
3. 在社群外掛中啟用 **Obsidian Chatting**。

目前僅支援這一條安裝路徑。送交至 Obsidian 社群外掛市場已列入路線圖。

## 設定

開啟 **設定 → Obsidian Chatting**，選一個 provider：

- **Anthropic / OpenAI：** 貼上 API key。外掛會透過 [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) 存進作業系統鑰匙圈。
- **ChatGPT OAuth：** 點 **Connect ChatGPT**。彈窗中會顯示一個驗證網址與一組一次性 code。任何瀏覽器開啟網址、登入、輸入 code，回到 Obsidian 即可。Token 會自動更新；若更新失敗會給你一條明確的 *「session expired, reconnect」* 提示。

完成。從側欄圖示或命令面板開啟聊天即可。

## 設計原則

| 原則 | 意思 |
|---|---|
| **行動端不是補丁** | 每一次改動都在手機上驗證。不靠 streaming、不靠 Node-only 模組、不靠 localhost callback。 |
| **三個靠譜 provider，不臃腫** | Anthropic + OpenAI 求穩定，ChatGPT OAuth 給不想設 API key 的人。不做半成品 provider 的市場。 |
| **密鑰進鑰匙圈** | API key 與 OAuth 憑證都走 Obsidian SecretStorage。絕不進 `data.json`，因此也不會被 Obsidian Sync 同步到其他裝置。 |
| **不做向量索引** | 線性搜尋加上限保護。可預期、無背景工作、手機記憶體壓力小。 |
| **會話自動保留** | 聊天紀錄在 Obsidian 重啟後仍在。本機 `chat-state.json`，不同步。 |
| **手機由右側滑入** | 從右邊滑入側欄，底下的文件不被遮擋。 |

## 開發

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run dev    # Watch mode
npm run build  # 正式建置
```

連結至測試 vault：

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/obsidian-chatting
```

## 授權

[MIT](../../LICENSE)。最初衍生自 [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)（同為 MIT）—— 原始版權資訊已保留於 `LICENSE` 中以示致謝。Obsidian Chatting 目前是一個獨立專案，擁有自己的路線圖。
