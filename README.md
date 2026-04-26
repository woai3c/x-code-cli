# X-Code CLI

[简体中文](./README.md) · [English](./README.en.md)

**X-Code CLI** 是一款运行在终端中的 AI 编码助手。你可以用自然语言与代码库对话，让它帮你阅读、修改、调试和构建项目，而无需离开命令行。

它支持多种主流大模型（Claude、GPT、DeepSeek、Gemini、Qwen、Grok、GLM、Kimi 等），内置 11 个常用工具（文件读写、Shell 执行、代码搜索等），并提供权限控制、上下文压缩、文件附件、知识库等高级能力。

## 功能亮点

- **多模型支持**：内置 8 大主流厂商，也可自定义任意 OpenAI 兼容接口
- **11 个内置工具**：覆盖文件、Shell、搜索、网页抓取等日常开发场景
- **三级权限模型**：默认安全，写操作前会请求确认；`--trust` 一键放行
- **流式输出**：边生成边显示，无需等待完整响应
- **上下文压缩**：长对话自动压缩历史；loop-guard 检测 doom-loop；prompt cache 复用前缀降低重复输入成本
- **知识库系统**：分层加载（全局 / 项目 AGENTS.md chain / 自动记忆 / 本地偏好 / 会话总结）
- **文件附件**：在提示词里写 `@path` 或裸绝对路径，自动识别 text / code / PDF / docx / xlsx / pptx / 图片
- **视觉子 agent**：DeepSeek 等纯文本模型自动借用其他多模态 provider 给图片打 caption，无感看图
- **斜杠命令**：`/help`、`/model`、`/thinking`、`/usage`、`/usage history` 等快捷指令
- **统一的思考模式开关**：`/thinking on|off` 一键切换，把 8 家厂商五花八门的 thinking/reasoning 参数收口成一个布尔值
- **跨平台**：支持 Windows、macOS、Linux
- **非交互模式**：`--print` 配合管道，可嵌入脚本和 CI

## 安装

```bash
# 通过 npm 全局安装
npm install -g @x-code-cli/cli

# 或使用 pnpm / yarn
pnpm add -g @x-code-cli/cli
yarn global add @x-code-cli/cli
```

安装完成后，你可以使用 `xc` 或 `x-code` 命令启动。

## 配置 API Key

> **必读**：X-Code CLI 没有内置免费模型，**未配置 API Key 将无法使用**。你需要自行到下方任意一家厂商注册账号并获取 API Key。
>
> **推荐 [DeepSeek](https://platform.deepseek.com/)**：价格便宜、国内访问稳定、代码能力足以覆盖日常开发，注册即送额度，是首次尝试本工具的最佳选择。

至少配置一个模型厂商的 API Key 即可使用：

| 环境变量                       | 厂商                | 注册地址                                                                  |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | Anthropic（Claude） | [console.anthropic.com](https://console.anthropic.com/)                   |
| `OPENAI_API_KEY`               | OpenAI（GPT）       | [platform.openai.com/api-keys](https://platform.openai.com/api-keys)      |
| `DEEPSEEK_API_KEY`             | DeepSeek            | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)  |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google（Gemini）    | [aistudio.google.com/apikey](https://aistudio.google.com/apikey)          |
| `ALIBABA_API_KEY`              | 阿里通义（Qwen）    | [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com/apiKey) |
| `XAI_API_KEY`                  | xAI（Grok）         | [console.x.ai](https://console.x.ai/)                                     |
| `ZHIPU_API_KEY`                | 智谱（GLM）         | [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys)           |
| `MOONSHOT_API_KEY`             | Moonshot（Kimi）    | [platform.moonshot.ai](https://platform.moonshot.ai/console/api-keys)     |

### 网页搜索 Key（可选）

如需启用网页搜索（`web_search` 工具），从下面两个里**任选一个**配置即可。**两家都有免费额度，不用花钱**：

| 环境变量         | 提供方                                        | 免费额度                                                   | 注册门槛                |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com)                  | **每月 1,000 credits**（基础搜索 1 credit/次，即 1000 次/月）  | 邮箱注册即可，**无需信用卡** |
| `BRAVE_API_KEY`  | [Brave Search](https://brave.com/search/api/) | **每月 $5 免费额度**（Search 端点 $5/1000 次，即 1000 次/月） | 需要绑定信用卡才能开通  |

> **首次配置推荐 Tavily** —— 注册更轻量，且专门为 LLM 优化过返回格式（已清洗的摘要，不是原始 SERP）。两个都配会优先走 Tavily，缺失时回退 Brave。
>
> 额度数据来自官方文档（[Tavily](https://docs.tavily.com/documentation/api-credits) / [Brave](https://brave.com/search/api/)），可能随时调整，以官方页面为准。

**如何配置 API Key**

把 Key 写入环境变量后，`xc` 在任何目录下都能直接使用。以 `ANTHROPIC_API_KEY` 为例，换成你实际使用的厂商变量名即可：

<details>
<summary>bash（Linux / Git Bash / WSL）</summary>

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.bashrc
source ~/.bashrc
```

</details>

<details>
<summary>zsh（macOS 默认）</summary>

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc
source ~/.zshrc
```

</details>

<details>
<summary>fish</summary>

```fish
set -Ux ANTHROPIC_API_KEY sk-ant-...
```

</details>

<details>
<summary>Windows PowerShell（用户级，永久）</summary>

```powershell
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', 'sk-ant-...', 'User')
# 重启 PowerShell 后生效
```

</details>

<details>
<summary>Windows CMD（用户级，永久）</summary>

```cmd
setx ANTHROPIC_API_KEY "sk-ant-..."
:: 重启 CMD 后生效
```

</details>

> 单次会话临时使用可以用 `export X=...`（当前 bash）、`$env:X = '...'`（当前 PowerShell），关闭终端就失效，适合临时调试。
>
> 项目级覆盖：在项目根目录放置 `.env` 文件，`xc` 会从当前目录向上逐层加载。

## 快速上手

```bash
# 进入你的项目目录
cd your-project

# 启动交互式会话
xc

# 直接带提示词运行
xc "解释这个项目的整体架构"

# 指定模型
xc -m sonnet "重构 src/utils.ts 中的 formatDate 函数"

# 信任模式（跳过写操作确认，适合熟悉的场景）
xc -t

# 非交互模式（输出后退出，适合脚本调用）
xc -p "为这个仓库生成一份 CHANGELOG"
```

## 命令行参数

```text
xc [options] [prompt]

--model, -m <id>      指定模型（如 sonnet、deepseek、openai:gpt-4.1）
--trust, -t           信任模式：跳过写操作确认
--print, -p           非交互模式：输出结果后退出
--max-turns <n>       Agent 循环最大轮次（默认 100）
--version, -v         显示版本号
--help, -h            显示帮助
```

## 斜杠命令

| 命令                | 说明                              |
| ------------------- | --------------------------------- |
| `/help`             | 查看所有可用命令                  |
| `/model [alias]`    | 切换模型或查看可用模型列表        |
| `/thinking [on\|off]` | 开启/关闭思考模式（无参数 = 弹出选择器） |
| `/usage`            | 查看本会话 Token 用量（含缓存命中），`/usage history` 列出当前项目的历史会话 |
| `/clear`            | 清空当前会话                      |
| `/compact`          | 手动压缩上下文                    |
| `/init`             | 初始化项目知识库                  |
| `/session save`     | 保存当前会话（不退出）            |
| `/exit`             | 保存会话并退出                    |

### 思考模式说明

我们支持的 8 家厂商对"思考/推理"的默认行为并不一致：Gemini 2.5 Pro、Kimi K2.5 默认就开思考；Claude Sonnet、DeepSeek V4、Qwen Max 默认关闭、需要显式开启才能拿到官方测评分数；GPT-4.1、Grok 3、GLM-4-Plus 在这几个模型 ID 上没有思考概念。

`/thinking` 命令把这些差异统一成一个开关：

- `/thinking`（无参数）→ 弹出交互式选择器，显示当前状态，可用方向键切换。
- `/thinking on` → 让所有支持的模型都打开思考模式（更慢但难题表现更好）。
- `/thinking off` → 让所有支持的模型都走非思考默认值（更快更便宜）。

设置会持久化到 `~/.x-code/config.json`，重启后保持；切换实时生效，下一条消息开始用新模式。

## 文件附件

在提示词里引用文件路径，CLI 会自动把内容送给模型：

```bash
# @ 语法，显式附加
> 看看 @D:\code\app\src\main.ts 里的 main 函数

# 裸绝对路径也能识别（需带扩展名）
> 总结一下 /home/me/report.pdf 的要点

# 图片、PDF、docx、xlsx、pptx 都支持
> 这张截图里哪里不对？@D:\screenshots\bug.png
```

各模型的支持情况：

| 类型                 | Claude / GPT / Gemini / Grok / Kimi / Qwen / GLM | DeepSeek          |
| -------------------- | ------------------------------------------------ | ----------------- |
| 文本代码文件         | 直接内联                                         | 直接内联          |
| 文本型 PDF           | 本地抽文本（省 token）                           | 本地抽文本        |
| 扫描型 PDF           | 作为 PDF 原生识别                                | 本地栅格化 + OCR  |
| docx / xlsx / pptx   | 本地抽文本                                       | 本地抽文本        |
| 图片 (png/jpg/...)   | 多模态原生识别                                   | 视觉辅助模型 / OCR 兜底 |

**DeepSeek 图片识别 — 自动调用视觉辅助模型**：DeepSeek 官方 API 不支持多模态视觉输入，但 CLI 会按下面的顺序自动找一个"视觉辅助模型"来帮它看图：

1. 检测你环境变量里**是否还配了其他多模态 provider 的 key**（按优先级：Google → 智谱 → 阿里 → OpenAI → Anthropic → Moonshot → xAI）
2. 找到的话，自动用这个 provider 调一个轻量视觉模型（如 `gemini-2.5-flash` / `glm-4v-flash`）生成图片描述
3. 把描述文字注入到发给 DeepSeek 的消息里，DeepSeek 全程无感地"看到"图
4. 终端会显示一行 `⎿  Captioned image via google:gemini-2.5-flash` 提示用了哪个辅助模型
5. 没配任何视觉 provider 时，回退到本地 tesseract OCR（只能取图中文字）

**强烈建议** DeepSeek 用户额外注册一个免费视觉模型 key,体验最丝滑：

- **Google Gemini**(`GOOGLE_GENERATIVE_AI_API_KEY`) — 免费档约 10 RPM / 250 RPD(实际配额以 [官方文档](https://ai.google.dev/gemini-api/docs/rate-limits) 为准,Google 偶有收紧),质量最好,需代理。在 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 登录 Google 账号即可创建 key
- **智谱 GLM-4V-Flash**(`ZHIPU_API_KEY`) — 智谱官方明确标注永久免费,个人日常使用够用,国内可直连。在 [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) 注册账号后创建 key

**视觉辅助模型的能力上限**(请知悉):

- 辅助模型给的是**一段文字描述**,不是真正的多模态对话 — DeepSeek 没法对图追问("左上角按钮什么颜色?"会失败)
- 复杂 UI 还原、像素级布局校验等任务,描述会丢细节
- 这类场景请直接 `/model` 切到 Claude / Gemini / GLM-4V 等多模态模型,在那里完成对话

## 排查问题

遇到 bug 想抓日志,加上 `DEBUG_STDOUT=1` 启动:

```bash
DEBUG_STDOUT=1 xc
```

日志写在全局目录下:

- **位置**: `~/.x-code/logs/debug.log`(以及滚动过的 `debug.log.1`)
- **大小上限**: 单文件 10MB,加滚动备份共 ~20MB,自动覆盖最旧的
- **容量参考**: 一次需求约 50 轮对话产生 ~5MB 日志,**单个 active 文件能完整装下**;100+ 轮才会触发滚动
- **行数保证**: 单条 entry 最长 1KB(超出截断并标注),滚动周期内**至少 2 万行**
- **查看**: `tail -f ~/.x-code/logs/debug.log` 或附到 Issue 里

只在 `DEBUG_STDOUT=1` 时才写文件,默认零开销。

## 项目结构

```text
x-code-cli/
├── packages/
│   ├── core/        @x-code-cli/core    AI 引擎（无 UI 依赖）
│   │   └── src/
│   │       ├── agent/        Agent 循环、系统提示词、文件附件、视觉子 agent、loop guard
│   │       ├── config/       模型配置、API Key 管理
│   │       ├── knowledge/    知识加载器、自动记忆、会话摘要 + token 用量
│   │       ├── permissions/  三级权限系统
│   │       ├── providers/    AI SDK 厂商注册、thinking 开关、cache control
│   │       ├── tools/        11 个工具实现
│   │       └── types/        公开 TypeScript 接口
│   │
│   └── cli/         @x-code-cli/cli     终端界面
│       └── src/
│           ├── index.ts        CLI 入口
│           ├── app.tsx         Ink 应用根
│           └── ui/             React 组件、Hook、主题
│
└── .x-code/         项目知识库目录（首次 /init 时创建）
    ├── memory/      AI 自动写入的记忆（auto.md）
    ├── sessions/    会话摘要 + token 用量
    └── local/       个人偏好（gitignored）
```

## 从源码运行

```bash
# 克隆仓库
git clone https://github.com/woai3c/x-code-cli.git
cd x-code-cli

# 安装依赖
pnpm install

# 构建
pnpm build

# 直接运行
node packages/cli/dist/cli.js

# 或开发模式（自动监听）
pnpm dev
```

## 反馈与贡献

欢迎提交 Issue 和 Pull Request：<https://github.com/woai3c/x-code-cli>

## License

[MIT](./LICENSE)
