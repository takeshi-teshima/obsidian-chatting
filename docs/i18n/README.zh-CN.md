# Obsidian Chatting

> 一个 agentic 的 AI 助手，常驻你的 Obsidian 库——手机、平板、桌面体验一致。

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

<p align="center">
  <img src="../../assets/screenshot-settings.png" alt="iPhone 上的 Provider 设置页" width="260">
  <img src="../../assets/screenshot-chat-cn.png" alt="联网搜索后的中文回答" width="260">
  <img src="../../assets/screenshot-chat-en.png" alt="带列表的英文回答" width="260">
</p>

---

## 亮点

- **三个 provider，自己挑** —— Anthropic API、OpenAI API，或者直接用你的 ChatGPT 账号登录。
- **14 个 vault 原生工具** —— 读、改、搜索、创建、重命名、frontmatter、backlinks 全都覆盖。
- **手机端不打折** —— 不靠 streaming、不依赖 Node-only 模块、不用 localhost 回调。iOS 和 Android 与桌面表现一致。
- **选区作用域** —— 选中一段文字发到聊天里,助手只在选区内动手。
- **密钥进操作系统钥匙串** —— 绝不写进 `data.json`,不会被同步到别的设备。

## 三个 Provider

| Provider | 认证方式 | 默认模型 | 说明 |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | 自适应思考、网络搜索、prompt 缓存。 |
| **OpenAI** | API key | Codex 5.3 | Responses API、推理、网络搜索。 |
| **ChatGPT 账号** | 登录 ChatGPT | GPT-5.5 | 用你的 ChatGPT 套餐代替 OpenAI API key。 |

> **关于 ChatGPT 账号登录。** 这个 provider 用你的 ChatGPT 账号登录,请求走的是 ChatGPT/Codex 后端(不是 `api.openai.com`),需要一份开通了 Codex 的 ChatGPT 套餐。可用模型对齐 Codex CLI 的目录。

## 助手能做什么

助手挂在 Obsidian Vault API 上,共 14 个工具,按用途分组:

**读取**
- `read_document`、`read_file` —— 打开任意笔记或任意文件。
- `search_vault` —— 搜索文件名和笔记内容。
- `list_files` —— 浏览库结构。
- `get_backlinks` —— 找出指向某笔记的所有 backlinks。
- `get_properties` —— 读取 YAML frontmatter。
- `get_current_datetime` —— 拿到你时区下的当前时间。

**写入**
- `edit_document` —— 精准查找替换、插入、整段替换。
- `create_file` —— 创建新笔记(父目录会自动创建)。
- `set_properties` —— 安全合并/移除 YAML frontmatter。

**管理**
- `rename_file` —— 重命名或移动文件,链接自动更新。
- `delete_file` —— 移到回收站(尊重你的回收站设置)。
- `open_document` —— 在编辑器里打开某个文件。
- `ask_user` —— 不清楚的时候反过来问你。

策略是:先读再改、能小改就不大改、用户确认过的事不再问。

## 选区作用域

在笔记里选中一段文字,右键 → **Send selection to Chat**。选区会作为一个 pill 出现在输入框上方,助手只在选区内动手,剩下的内容一动不动。

## 快速上手

**1. 通过 BRAT 安装**

从社区插件安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat),然后 **Add Beta plugin** → 输入 `o1xhack/obsidian-chatting`,在社区插件里启用 **Obsidian Chatting**。

**2. 在「设置 → Obsidian Chatting」选 provider**

- **Anthropic / OpenAI** —— 粘贴 API key。会通过 [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) 存进操作系统钥匙串。
- **ChatGPT 账号** —— 点 **Connect ChatGPT**。弹窗里会显示一个验证地址和一个一次性 code。在任何浏览器里打开地址、登录、输入 code 即可。Token 会自动刷新;万一刷新失败,会给你一条明确的 *"session expired, reconnect"* 提示。

**3. 打开聊天**

从侧边栏图标或命令面板打开。

## 设计原则

| 原则 | 含义 |
|---|---|
| **移动端不是事后补丁** | 每一次改动都在 iOS 和 Android 上验证过。不用 streaming、不用 Node-only 模块、不用 localhost 回调。 |
| **三个靠谱 provider** | Anthropic + OpenAI 保稳定,ChatGPT 账号给那些不想配 API key 的人。不搞一堆半成品 provider 的市场。 |
| **密钥进钥匙串** | API key 和 OAuth 凭据都走 Obsidian SecretStorage。绝不进 `data.json`,所以也不会被 Obsidian Sync 同步到别的设备。 |
| **不做向量索引** | 线性搜索 + 上限保护。可预期、无后台任务、手机内存压力小。 |
| **会话会保留** | 聊天历史在 Obsidian 重启后还在。本地 `chat-state.json`,不同步。 |
| **手机上靠右滑入** | 从右边滑入侧栏,下面的文档不被遮挡。 |

## 路线图

不保证顺序,但都在视野里:

- 提交到 Obsidian 社区插件市场。
- 多会话历史 + 归档/搜索。
- Provider 支持的图片附件。
- 自动跟进上游新发布的 provider 模型。

有想法?直接开 issue。

## 开发

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run dev    # Watch mode
npm run build  # 生产构建
```

软链到测试 vault:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/obsidian-chatting
```

## 许可证

[MIT](../../LICENSE)。最初衍生自 [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)(同为 MIT)—— 原版权信息已保留在 `LICENSE` 中以示致谢。Obsidian Chatting 现在是一个独立项目,有自己的路线图。
