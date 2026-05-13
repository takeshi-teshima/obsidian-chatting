# Chatting with AI

[![最新版本](https://img.shields.io/github/v/release/o1xhack/obsidian-chatting?include_prereleases&label=release&color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![下載總數](https://img.shields.io/github/downloads/o1xhack/obsidian-chatting/total?color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![授權](https://img.shields.io/github/license/o1xhack/obsidian-chatting?color=7c3aed)](../../LICENSE)
[![Obsidian](https://img.shields.io/badge/obsidian-1.7.0%2B-7c3aed)](https://obsidian.md)

**一個 agentic 的 AI 助理,常駐你的 Obsidian 庫 —— 手機、平板、桌面體驗一致。**

> 🌐 [English](../../README.md) · [简体中文](README.zh-CN.md) · **繁體中文** · [日本語](README.ja.md)

<p align="center">
  <img src="../../assets/screenshot-settings.png" alt="iPhone 上的 Provider 設定頁" width="260">
  <img src="../../assets/screenshot-chat-cn.png" alt="連網搜尋後的中文回答" width="260">
  <img src="../../assets/screenshot-chat-en.png" alt="帶清單的英文回答" width="260">
</p>

---

## ✨ 為什麼用它?

- **三個 provider,自己選** —— Anthropic API、OpenAI API,或者直接用你的 ChatGPT 帳號登入。不做半成品 provider 的市場。
- **14 個 vault 原生工具** —— 讀、改、搜尋、建立、重新命名、frontmatter、backlinks 一應俱全。從想法到改動檔案,不用離開聊天框。
- **手機端不打折** —— 不靠 streaming、不依賴 Node-only 模組、不用 localhost callback。iOS 與 Android 與桌面表現一致。
- **選取作用域** —— 在筆記中選一段文字送進聊天,助理只在選取裡動手。
- **密鑰進作業系統鑰匙圈** —— 絕不寫進 `data.json`,不會被同步到其他裝置。

## 🎬 一句話,自己調一連串工具

你只問一次,助理自己決定該調哪些工具:

```
你: 把 /Books 下面所有缺少 `rating` 屬性的筆記都加上 `rating: ?`。

助理
  → search_vault("/Books")               → 12 個檔案
  → get_properties("Books/Sapiens.md")   → 已有 rating
  → get_properties("Books/Hail Mary.md") → 沒有 rating
  → set_properties("Books/Hail Mary.md", { rating: "?" })
  → ... (再來 5 次)

  搞定 —— 已為 6 個筆記加上 `rating: ?`:
  - Books/Hail Mary.md
  - Books/Klara and the Sun.md
  - ...
```

策略很簡單:先讀再改、能小改不大改、使用者確認過的事不再問第二次。

## 🎯 選取作用域

在任意筆記中選一段文字,右鍵 → **Send selection to Chat**。選取會以 pill 形式出現在輸入框上方,助理只在選取裡動手 —— 文件其餘部分一個位元組都不會變。

```
[ pill: "...開頭有點拖沓,而且..."  ✕ ]

你: 收緊一下 —— 別丟我的語氣
```

助理使用作用域到選取文字的尋找替換。選取以外的內容原封不動。

## 🛠️ 14 個 vault 原生工具

| 分組 | 工具 | 用途 |
|---|---|---|
| **讀取** | `read_document`、`read_file`、`search_vault`、`list_files`、`get_backlinks`、`get_properties`、`get_current_datetime` | 開啟任意筆記或檔案;依檔名與內容搜尋;瀏覽庫結構;查找 backlinks;讀取 YAML frontmatter;取得你時區下的當前時間。 |
| **寫入** | `edit_document`、`create_file`、`set_properties` | 精準尋找替換 / 插入 / 整段替換;建立新筆記(父目錄自動建立);安全合併或移除 YAML frontmatter。 |
| **管理** | `rename_file`、`delete_file`、`open_document`、`ask_user` | 重新命名或移動(連結自動更新);移到垃圾桶(遵守你的垃圾桶設定);在編輯器中開啟檔案;不清楚時反問你一句。 |

## ⚙️ 三個 Provider

| Provider | 認證方式 | 預設模型 | 備註 |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | 自適應思考、網路搜尋、prompt 快取。 |
| **OpenAI** | API key | Codex 5.3 | Responses API、推理、網路搜尋。 |
| **ChatGPT 帳號** | 登入 ChatGPT | GPT-5.5 | 以 ChatGPT 套餐代替 OpenAI API key。 |

> **關於 ChatGPT 帳號登入。** 這個 provider 以你的 ChatGPT 帳號登入,請求走的是 ChatGPT/Codex 後端(不是 `api.openai.com`),需要一份已開通 Codex 的 ChatGPT 套餐。可用模型對齊 Codex CLI 的目錄。

## 🚀 快速上手

1. 透過 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 安裝 → **Add Beta plugin** → 輸入 `o1xhack/obsidian-chatting`
2. 在社群外掛中啟用 **Chatting with AI**
3. **設定 → Chatting with AI** → 選 provider,貼上 API key(或點 **Connect ChatGPT**)
4. 從側欄圖示或命令面板開啟聊天

## 📦 安裝

<details>
<summary><b>BRAT(推薦)</b></summary>

BRAT 直接從 GitHub 安裝 beta 外掛,並自動跟進更新。

1. 從社群外掛安裝 [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. **命令面板 → BRAT: Add a beta plugin for testing**
3. 輸入 `o1xhack/obsidian-chatting`
4. 在社群外掛中啟用 **Chatting with AI**

</details>

<details>
<summary><b>手動安裝</b></summary>

1. 從 [最新發佈版本](https://github.com/o1xhack/obsidian-chatting/releases/latest) 下載 `main.js`、`manifest.json`、`styles.css`
2. 放入 `<vault>/.obsidian/plugins/chatting-with-ai/`
3. 重新啟動 Obsidian,在社群外掛中啟用 **Chatting with AI**

</details>

<details>
<summary><b>從原始碼建置</b></summary>

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run build
```

連結至測試 vault:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/chatting-with-ai
```

</details>

## 🧭 設計原則

| 原則 | 意思 |
|---|---|
| **行動端不是補丁** | 每一次改動都在 iOS 與 Android 上驗證。不靠 streaming、不靠 Node-only 模組、不靠 localhost callback。 |
| **三個靠譜 provider** | Anthropic + OpenAI 求穩定,ChatGPT 帳號給不想設 API key 的人。 |
| **密鑰進鑰匙圈** | API key 與 OAuth 憑證都走 Obsidian SecretStorage。絕不進 `data.json`,因此也不會被 Obsidian Sync 同步到其他裝置。 |
| **不做向量索引** | 線性搜尋加上限保護。可預期、無背景工作、手機記憶體壓力小。 |
| **會話自動保留** | 聊天紀錄在 Obsidian 重啟後仍在。本機 `chat-state.json`,不同步。 |
| **手機由右側滑入** | 從右邊滑入側欄,底下的文件不被遮擋。 |

## 🗺️ 路線圖

- [x] 三個 provider(Anthropic、OpenAI、ChatGPT 帳號)
- [x] 14 個 vault 原生工具
- [x] iOS / Android 體驗一致
- [x] 選取作用域
- [ ] 送交至 Obsidian 社群外掛市場
- [ ] 多會話紀錄 + 歸檔/搜尋
- [ ] Provider 支援的圖片附件
- [ ] 上游新發佈的 provider 模型自動跟進

有想法?直接開 issue。

## ❓ 常見問題

<details>
<summary><b>我的筆記會不會被上傳到別處?</b></summary>

只發送當前這一輪助理需要的內容。你提問時,助理決定該調哪些工具 —— `read_document`、`search_vault` 等等 —— 這些呼叫取得的內容(加上當前筆記的上下文)會送往你選的 provider。背景不會做任何上傳。**沒有向量索引。**

</details>

<details>
<summary><b>行動端真的能用嗎?</b></summary>

可以 —— 整個專案就是圍繞這個約束設計的。請求走 Obsidian 的 `requestUrl()`(手機 WebView 強制 CORS),不用 streaming、不用 Node-only 模組、OAuth 也不用 localhost callback。iOS 與 Android 跑的是和桌面完全相同的程式碼路徑。

</details>

<details>
<summary><b>用 ChatGPT 帳號登入是免費的嗎?</b></summary>

它沿用你既有的 ChatGPT 套餐(Plus、Pro、Team、Enterprise)—— 沒有額外計費。你需要一份已開通 Codex 的 ChatGPT 套餐。外掛不會呼叫 `api.openai.com`,而是呼叫 Codex CLI 使用的同一套後端。

</details>

<details>
<summary><b>能不能加上 X provider?</b></summary>

大概率不會 —— 把 provider 名單保持很小是個明確的取捨。兩家 API provider 涵蓋主要 API 生態,ChatGPT 帳號登入覆蓋「我只有一份 ChatGPT 套餐」的情境。再加更多就得在手機端驗證更多組合。

</details>

<details>
<summary><b>聊天紀錄存在哪?會同步嗎?</b></summary>

存在本機 `<vault>/.obsidian/plugins/chatting-with-ai/chat-state.json`。**Obsidian Sync 預設排除外掛資料檔**,不會被同步。API key 透過 SecretStorage 進作業系統鑰匙圈,同樣不同步。

</details>

## 🤝 參與貢獻

歡迎提 Issue 與 PR。在提 PR 之前請:

- 跑一遍 `npx tsc --noEmit` 與 `npm run svelte-check`
- 至少在一個行動端(iOS 或 Android)測一下 ——「行動端不打折」是認真的
- 改動較大的話,先開 Issue 對齊方向

## 🙏 致謝

最初衍生自 [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)(同為 MIT)—— 原始版權資訊已保留於 `LICENSE` 中。Chatting with AI 目前是一個獨立專案,擁有自己的路線圖 —— 主要的重寫包括 agent loop、行動端適配、ChatGPT 帳號登入,以及選取作用域功能。

## 📄 授權

[MIT](../../LICENSE)。

---

作者:[Yuxiao (o1xhack)](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
