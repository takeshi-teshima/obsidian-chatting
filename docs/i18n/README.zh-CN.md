# Obsidian Chatting

**与你的库对话。任何设备。任何模型。**

<p align="center">
  <img src="../../assets/screenshot-mobile.jpeg" alt="Obsidian Chatting on mobile" width="320">
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  by <strong>Yuxiao (o1xhack)</strong> ·
  <a href="https://github.com/o1xhack">GitHub</a> ·
  <a href="https://app.o1xhack.com">app.o1xhack.com</a>
</p>

---

## 为什么是 Obsidian Chatting

Obsidian 上大多数 AI 插件都太重。问第一个问题之前要点一打设置，手机上动不动就崩，而且把 AI 当成一个聊天框而不是一个真正能动你笔记的助手。

Obsidian Chatting 反着来：

- **移动优先。** iOS、Android、桌面端体验完全一致。
- **三个 provider，自己挑。** Anthropic API、OpenAI API，或者直接用你的 ChatGPT 账号登录。
- **天生 agentic。** 助手可以读、改、建、重命名你的笔记 —— 14 个原生 vault 工具，不止是聊天。
- **密钥永远是你自己的。** API key 和 OAuth token 全部进操作系统钥匙串，绝不写进 `data.json`，绝不被同步。

## 三个 Provider

| Provider | 认证方式 | 默认模型 | 说明 |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | 自适应思考、网络搜索、prompt 缓存。 |
| **OpenAI** | API key | Codex 5.3 | Responses API、推理、网络搜索。 |
| **ChatGPT OAuth** *(实验性)* | 登录 ChatGPT | Codex 5.3 | 用你的 ChatGPT 账号代替 API key。走的是 ChatGPT/Codex 后端，可用性和配额会变化。 |

> **关于实验性 Provider：** ChatGPT OAuth 走的是 ChatGPT/Codex 后端（不是 `api.openai.com`）。OpenAI API Key 仍然是推荐的稳定路径。设计细节见 [docs/chatgpt-oauth-plan.md](../chatgpt-oauth-plan.md)。

## 它能为你的库做什么

助手挂在 Obsidian Vault API 上，一共 14 个工具：

- 读取任意笔记（或任意文件）。
- 编辑笔记 —— 精准的查找替换、插入、整段替换。
- 搜索文件名和内容。
- 创建新笔记，自动给出建议路径。
- 重命名或移动文件（链接自动更新）。
- 把文件移到回收站。
- 浏览库结构。
- 在编辑器里打开某个文件。
- 读写 YAML frontmatter 属性。
- 查找一个笔记的 backlinks。
- 拿到当前日期时间（你的时区和语言）。
- 不清楚的时候反过来问你。

策略是：先读再改、能小改就不大改、用户确认过的事不再问。

## 选区作用域

在笔记里选中一段文字，右键 → **Send selection to Chat**。选区会作为一个 pill 出现在输入框上方，助手只在选区内动手，剩下的内容一动不动。

## 安装

### 通过 BRAT

1. 从社区插件安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. **Add Beta plugin** → 输入 `o1xhack/obsidian-chatting`。
3. 在社区插件里启用 **Obsidian Chatting**。

目前只支持这一种安装路径。提交到 Obsidian 社区插件市场的事情已经在路线图上。

## 配置

打开 **设置 → Obsidian Chatting**，挑一个 provider：

- **Anthropic / OpenAI：** 粘贴 API key。插件会把它通过 [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) 存进操作系统钥匙串。
- **ChatGPT OAuth：** 点 **Connect ChatGPT**。弹窗里会显示一个验证地址和一个一次性 code。在任何浏览器里打开地址、登录、输入 code，回来就连上了。Token 会自动刷新；万一刷新失败，会给你一个明确的 *"session expired, reconnect"* 提示。

就这样。从侧边栏图标或命令面板打开聊天就行。

## 设计原则

| 原则 | 含义 |
|---|---|
| **移动端不是事后补丁** | 每一次改动都在手机上验证过。不用 streaming、不用 Node-only 模块、不用 localhost 回调。 |
| **三个靠谱 provider，不臃肿** | Anthropic + OpenAI 保稳定，ChatGPT OAuth 给那些不想配 API key 的人。不搞一堆半成品 provider 的市场。 |
| **密钥进钥匙串** | API key 和 OAuth 凭据都走 Obsidian SecretStorage。绝不进 `data.json`，所以也不会被 Obsidian Sync 同步到别的设备。 |
| **不做向量索引** | 线性搜索 + 上限保护。可预期、无后台任务、手机内存压力小。 |
| **会话会保留** | 聊天历史在 Obsidian 重启后还在。本地 `chat-state.json`，不同步。 |
| **手机上靠右滑入** | 从右边滑入侧栏，下面的文档不被遮挡。 |

## 开发

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run dev    # Watch mode
npm run build  # 生产构建
```

软链到测试 vault：

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/obsidian-chatting
```

## 许可证

[MIT](../../LICENSE)。最初衍生自 [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)（同为 MIT）—— 原版权信息已保留在 `LICENSE` 中以示致谢。Obsidian Chatting 现在是一个独立项目，有自己的路线图。
