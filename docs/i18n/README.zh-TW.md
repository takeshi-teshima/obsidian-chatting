# Obsidian Chatting

> 一個 agentic 的 AI 助理,常駐你的 Obsidian 庫——手機、平板、桌面體驗一致。

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

<p align="center">
  <img src="../../assets/screenshot-settings.png" alt="iPhone 上的 Provider 設定頁" width="260">
  <img src="../../assets/screenshot-chat-cn.png" alt="連網搜尋後的中文回答" width="260">
  <img src="../../assets/screenshot-chat-en.png" alt="帶清單的英文回答" width="260">
</p>

---

## 亮點

- **三個 provider,自己選** —— Anthropic API、OpenAI API,或者直接用你的 ChatGPT 帳號登入。
- **14 個 vault 原生工具** —— 讀、改、搜尋、建立、重新命名、frontmatter、backlinks 一應俱全。
- **手機端不打折** —— 不靠 streaming、不依賴 Node-only 模組、不用 localhost callback。iOS 與 Android 與桌面表現一致。
- **選取作用域** —— 選取一段文字送進聊天,助理只在選取裡動手。
- **密鑰進作業系統鑰匙圈** —— 絕不寫進 `data.json`,不會被同步到其他裝置。

## 三個 Provider

| Provider | 認證方式 | 預設模型 | 備註 |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | 自適應思考、網路搜尋、prompt 快取。 |
| **OpenAI** | API key | Codex 5.3 | Responses API、推理、網路搜尋。 |
| **ChatGPT 帳號** | 登入 ChatGPT | GPT-5.5 | 以 ChatGPT 套餐代替 OpenAI API key。 |

> **關於 ChatGPT 帳號登入。** 這個 provider 以你的 ChatGPT 帳號登入,請求走的是 ChatGPT/Codex 後端(不是 `api.openai.com`),需要一份已開通 Codex 的 ChatGPT 套餐。可用模型對齊 Codex CLI 的目錄。

## 助理能做什麼

助理掛在 Obsidian Vault API 上,共 14 個工具,依用途分組:

**讀取**
- `read_document`、`read_file` —— 開啟任意筆記或任意檔案。
- `search_vault` —— 搜尋檔案名稱與筆記內容。
- `list_files` —— 瀏覽庫結構。
- `get_backlinks` —— 找出指向某筆記的所有 backlink。
- `get_properties` —— 讀取 YAML frontmatter。
- `get_current_datetime` —— 取得你時區下的當前時間。

**寫入**
- `edit_document` —— 精準尋找替換、插入、整段替換。
- `create_file` —— 建立新筆記(父目錄會自動建立)。
- `set_properties` —— 安全合併/移除 YAML frontmatter。

**管理**
- `rename_file` —— 重新命名或移動檔案,連結自動更新。
- `delete_file` —— 移到垃圾桶(遵守你的垃圾桶設定)。
- `open_document` —— 在編輯器中開啟某個檔案。
- `ask_user` —— 不清楚時反問你一句。

策略是:先讀再改、能小改不大改、使用者確認過的事不再問第二次。

## 選取作用域

在筆記中選一段文字,右鍵 → **Send selection to Chat**。選取會以 pill 形式出現在輸入框上方,助理只動選取裡的內容,其餘維持原樣。

## 快速上手

**1. 透過 BRAT 安裝**

從社群外掛安裝 [BRAT](https://github.com/TfTHacker/obsidian42-brat),然後 **Add Beta plugin** → 輸入 `o1xhack/obsidian-chatting`,在社群外掛中啟用 **Obsidian Chatting**。

**2. 在「設定 → Obsidian Chatting」選 provider**

- **Anthropic / OpenAI** —— 貼上 API key。會透過 [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) 存進作業系統鑰匙圈。
- **ChatGPT 帳號** —— 點 **Connect ChatGPT**。彈窗中會顯示一個驗證網址與一組一次性 code。任何瀏覽器開啟網址、登入、輸入 code 即可。Token 會自動更新;若更新失敗會給你一條明確的 *「session expired, reconnect」* 提示。

**3. 開啟聊天**

從側欄圖示或命令面板開啟即可。

## 設計原則

| 原則 | 意思 |
|---|---|
| **行動端不是補丁** | 每一次改動都在 iOS 與 Android 上驗證。不靠 streaming、不靠 Node-only 模組、不靠 localhost callback。 |
| **三個靠譜 provider** | Anthropic + OpenAI 求穩定,ChatGPT 帳號給不想設 API key 的人。不做半成品 provider 的市場。 |
| **密鑰進鑰匙圈** | API key 與 OAuth 憑證都走 Obsidian SecretStorage。絕不進 `data.json`,因此也不會被 Obsidian Sync 同步到其他裝置。 |
| **不做向量索引** | 線性搜尋加上限保護。可預期、無背景工作、手機記憶體壓力小。 |
| **會話自動保留** | 聊天紀錄在 Obsidian 重啟後仍在。本機 `chat-state.json`,不同步。 |
| **手機由右側滑入** | 從右邊滑入側欄,底下的文件不被遮擋。 |

## 路線圖

不保證順序,但都在視野裡:

- 送交至 Obsidian 社群外掛市場。
- 多會話紀錄 + 歸檔/搜尋。
- Provider 支援的圖片附件。
- 上游新發佈的 provider 模型自動跟進。

有想法?直接開 issue。

## 開發

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run dev    # Watch mode
npm run build  # 正式建置
```

連結至測試 vault:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/obsidian-chatting
```

## 授權

[MIT](../../LICENSE)。最初衍生自 [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)(同為 MIT)—— 原始版權資訊已保留於 `LICENSE` 中以示致謝。Obsidian Chatting 目前是一個獨立專案,擁有自己的路線圖。
