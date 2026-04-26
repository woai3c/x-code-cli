# X-Code CLI

[简体中文](./README.md) · [English](./README.en.md)

**X-Code CLI** 是一款命令行 AI 编程助手。通过自然语言与代码库交互，完成阅读、修改、调试和构建等开发任务，无需离开终端。

X-Code CLI 支持主流大模型（Claude、GPT、DeepSeek、Gemini、Qwen、Grok、GLM、Kimi 等），内置 11 个常用工具（文件读写、Shell 执行、代码搜索等），并提供权限控制、上下文压缩、文件附件、知识库等能力。

## 功能特性

- **多模型支持**：内置 8 家主流厂商，并支持任意 OpenAI 兼容接口
- **11 个内置工具**：覆盖文件、Shell、搜索、网页抓取等常见开发场景
- **三级权限模型**：默认安全，写操作前请求确认；`--trust` 可跳过确认
- **流式输出**：边生成边显示，无需等待完整响应
- **上下文压缩**：长对话自动压缩历史；loop-guard 检测循环调用；prompt cache 复用前缀降低重复输入成本
- **知识库系统**：分层加载（全局 / 项目 AGENTS.md chain / 自动记忆 / 本地偏好 / 会话总结）
- **文件附件**：在提示词中以 `@path` 或裸绝对路径引用文件，自动识别 text / code / PDF / docx / xlsx / pptx / 图片
- **视觉子 agent**：DeepSeek 等纯文本模型可借用其他多模态厂商生成图片描述
- **斜杠命令**：`/help`、`/model`、`/thinking`、`/usage`、`/usage history` 等
- **统一思考模式开关**：`/thinking on|off` 将不同厂商各异的 thinking/reasoning 参数统一为单一开关
- **跨平台**：支持 Windows、macOS、Linux
- **非交互模式**：`--print` 配合管道输入，可嵌入脚本与 CI

## 安装

```bash
# 通过 npm 全局安装
npm install -g @x-code-cli/cli

# 或使用 pnpm / yarn
pnpm add -g @x-code-cli/cli
yarn global add @x-code-cli/cli
```

安装完成后，使用 `xc` 或 `x-code` 命令启动。

## 配置 API Key

> **说明**：X-Code CLI 不内置任何免费模型，**必须配置至少一个厂商的 API Key 后方可使用**。请前往下方任一厂商注册并获取 API Key。
>
> **推荐 [DeepSeek](https://platform.deepseek.com/)**：价格低廉、国内访问稳定、代码能力满足日常开发需求，注册赠送初始额度，适合首次试用。

至少配置一个厂商的 API Key 即可使用：

| 环境变量                       | 厂商                | 注册地址                                                                    |
| ------------------------------ | ------------------- | --------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | Anthropic（Claude） | [console.anthropic.com](https://console.anthropic.com/)                     |
| `OPENAI_API_KEY`               | OpenAI（GPT）       | [platform.openai.com/api-keys](https://platform.openai.com/api-keys)        |
| `DEEPSEEK_API_KEY`             | DeepSeek            | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)    |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google（Gemini）    | [aistudio.google.com/apikey](https://aistudio.google.com/apikey)            |
| `ALIBABA_API_KEY`              | 阿里通义（Qwen）    | [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com/apiKey) |
| `XAI_API_KEY`                  | xAI（Grok）         | [console.x.ai](https://console.x.ai/)                                       |
| `ZHIPU_API_KEY`                | 智谱（GLM）         | [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys)             |
| `MOONSHOT_API_KEY`             | Moonshot（Kimi）    | [platform.moonshot.ai](https://platform.moonshot.ai/console/api-keys)       |

### 网页搜索 Key（可选）

启用网页搜索（`web_search` 工具）需要从下表中**任选一项**配置。两家服务均提供免费额度：

| 环境变量         | 提供方                                        | 免费额度                                                       | 注册门槛                  |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------- | ------------------------- |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com)                  | **每月 1,000 credits**（基础搜索 1 credit / 次，约 1,000 次/月） | 邮箱注册，**无需信用卡**  |
| `BRAVE_API_KEY`  | [Brave Search](https://brave.com/search/api/) | **每月 $5 免费额度**（Search 端点 $5 / 1,000 次，约 1,000 次/月） | 需绑定信用卡才能开通      |

> **推荐首次配置 Tavily**：注册流程简便，返回格式针对 LLM 场景优化（提供清洗后的摘要而非原始 SERP）。同时配置时优先使用 Tavily，未配置时自动回退至 Brave。
>
> 上述额度数据来源于官方文档（[Tavily](https://docs.tavily.com/documentation/api-credits)、[Brave](https://brave.com/search/api/)），实际配额以官方页面为准。

**配置方式**

将 API Key 设置为环境变量后，`xc` 可在任意目录下直接调用。以下示例使用 `ANTHROPIC_API_KEY`，请替换为实际使用的厂商变量名：

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
<summary>Windows PowerShell（用户级，永久生效）</summary>

```powershell
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', 'sk-ant-...', 'User')
# 重启 PowerShell 后生效
```

</details>

<details>
<summary>Windows CMD（用户级，永久生效）</summary>

```cmd
setx ANTHROPIC_API_KEY "sk-ant-..."
:: 重启 CMD 后生效
```

</details>

> 如需临时使用，可在当前会话执行 `export X=...`（bash）或 `$env:X = '...'`（PowerShell），终端关闭后失效。
>
> 项目级配置：在项目根目录放置 `.env` 文件，`xc` 会从当前目录向上逐层加载。

## 快速上手

```bash
# 进入项目目录
cd your-project

# 启动交互式会话
xc

# 直接附带提示词运行
xc "解释项目的整体架构"

# 指定模型
xc -m sonnet "重构 src/utils.ts 中的 formatDate 函数"

# 信任模式：跳过写操作确认
xc -t

# 非交互模式：输出结果后退出，适用于脚本调用
xc -p "为该仓库生成 CHANGELOG"
```

## 命令行参数

```text
xc [options] [prompt]

--model, -m <id>      指定模型（如 sonnet、deepseek、openai:gpt-4.1）
--trust, -t           信任模式：跳过写操作确认
--print, -p           非交互模式：输出结果后退出
--max-turns <n>       Agent 循环最大轮次（默认 100）
--version, -v         显示版本号
--help, -h            显示帮助信息
```

## 斜杠命令

| 命令                  | 说明                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| `/help`               | 查看所有可用命令                                                              |
| `/model [alias]`      | 切换模型或查看可用模型列表                                                    |
| `/thinking [on\|off]` | 启用 / 禁用思考模式（无参数时弹出选择器）                                     |
| `/usage`              | 查看本次会话 Token 用量（含缓存命中率）；`/usage history` 列出当前项目历史会话 |
| `/clear`              | 清空当前会话                                                                  |
| `/compact`            | 手动压缩上下文                                                                |
| `/init`               | 初始化项目知识库                                                              |
| `/session save`       | 保存当前会话（不退出）                                                        |
| `/exit`               | 保存会话并退出                                                                |

### 思考模式说明

X-Code CLI 支持的 8 家厂商对思考 / 推理模式的默认行为存在差异：

- **默认开启**：Gemini 2.5 Pro、Kimi K2.5
- **默认关闭**：Claude Sonnet、DeepSeek V4、Qwen Max（需显式开启以达到官方基准成绩）
- **不支持**：GPT-4.1、Grok 3、GLM-4-Plus 在所列模型 ID 下无对应特性

`/thinking` 命令将上述差异统一为单一开关：

- `/thinking`（无参数）：弹出交互式选择器，显示当前状态并支持方向键切换
- `/thinking on`：对所有支持该特性的模型启用思考模式（响应较慢，复杂问题表现更佳）
- `/thinking off`：对所有支持该特性的模型禁用思考模式（响应更快，成本更低）

配置持久化保存至 `~/.x-code/config.json`，重启后仍然生效；切换立即生效，自下一条消息起使用新模式。

## 文件附件

在提示词中引用文件路径，CLI 会自动将文件内容附加至请求中：

```bash
# @ 语法（显式附加）
> 解释 @D:\code\app\src\main.ts 中的 main 函数

# 裸绝对路径（需带扩展名）
> 总结 /home/me/report.pdf 的核心内容

# 支持图片、PDF、docx、xlsx、pptx 等格式
> 分析此截图中的异常：@D:\screenshots\bug.png
```

各模型支持情况：

| 类型               | Claude / GPT / Gemini / Grok / Kimi / Qwen / GLM | DeepSeek                |
| ------------------ | ------------------------------------------------ | ----------------------- |
| 文本 / 代码文件    | 直接内联                                         | 直接内联                |
| 文本型 PDF         | 本地抽取文本（节省 token）                       | 本地抽取文本            |
| 扫描型 PDF         | 作为 PDF 原生识别                                | 本地栅格化 + OCR        |
| docx / xlsx / pptx | 本地抽取文本                                     | 本地抽取文本            |
| 图片（png/jpg 等） | 多模态原生识别                                   | 视觉辅助模型 / OCR 兜底 |

**DeepSeek 图片识别 — 视觉辅助模型**：DeepSeek 官方 API 不支持多模态视觉输入。当用户附加图片时，CLI 按以下流程自动调用其他厂商的视觉模型生成描述：

1. 检测环境变量中是否配置了其他多模态厂商的 API Key（优先级顺序：Google → 智谱 → 阿里 → OpenAI → Anthropic → Moonshot → xAI）
2. 若已配置，则使用对应厂商的轻量视觉模型（如 `gemini-2.5-flash`、`glm-4v-flash`）生成图片描述
3. 将描述文本注入至发送给 DeepSeek 的消息中，使其能够获取图片信息
4. 终端输出 `⎿  Captioned image via google:gemini-2.5-flash` 标识所使用的辅助模型
5. 若未配置任何视觉厂商，则回退至本地 tesseract OCR（仅提取图片中的文本）

**建议** DeepSeek 用户额外注册一个免费视觉模型 Key，以获得更完整的图像理解能力：

- **Google Gemini**（`GOOGLE_GENERATIVE_AI_API_KEY`）：免费额度约 10 RPM / 250 RPD（实际配额以 [官方文档](https://ai.google.dev/gemini-api/docs/rate-limits) 为准），识别质量最佳，国内访问需代理。在 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 使用 Google 账号即可创建 Key
- **智谱 GLM-4V-Flash**（`ZHIPU_API_KEY`）：官方标注永久免费，满足个人日常使用，国内可直连。在 [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) 注册账号后创建 Key

**视觉辅助模型的能力边界**：

- 辅助模型仅返回**文字描述**，并非真正的多模态对话；DeepSeek 无法基于图片进行追问（例如询问"左上角按钮的颜色"无法识别）
- 复杂 UI 还原、像素级布局校验等场景下，文字描述可能丢失细节
- 此类场景建议通过 `/model` 切换至 Claude、Gemini、GLM-4V 等多模态模型直接处理

## 故障排查

如需调试或抓取运行日志，可在当前会话临时设置 `DEBUG_STDOUT=1` 环境变量启动。不同 shell 的语法不同，请按所用 shell 选择对应命令：

**bash / zsh / Git Bash**

```bash
DEBUG_STDOUT=1 xc
```

**fish**

```fish
env DEBUG_STDOUT=1 xc
```

**Windows PowerShell**

```powershell
$env:DEBUG_STDOUT=1; xc
```

**Windows CMD**

```cmd
set DEBUG_STDOUT=1 && xc
```

> 上述写法均为临时设置——仅当前命令生效，关闭终端后变量自动释放。如需在多次启动间保留，请参照前文「配置方式」章节做持久化配置。

日志保存在用户目录下：

- **路径**：`~/.x-code/logs/debug.log`（滚动备份为 `debug.log.1`）
- **大小限制**：单文件 10 MB，含滚动备份合计约 20 MB，超出后自动覆盖最早的备份
- **容量参考**：约 50 轮对话产生 5 MB 日志，单个活动文件即可完整保存；100 轮以上才会触发滚动
- **写入限制**：单条记录上限 1 KB（超出部分截断并标注），单个滚动周期至少容纳 20,000 条
- **查看方式**：使用 `tail -f ~/.x-code/logs/debug.log`，或附加至 Issue 中

日志文件仅在 `DEBUG_STDOUT=1` 启用时写入，默认状态下零开销。

## 项目结构

```text
x-code-cli/
├── packages/
│   ├── core/        @x-code-cli/core    AI 引擎（无 UI 依赖）
│   │   └── src/
│   │       ├── agent/        Agent 循环、系统提示词、文件附件、视觉子 agent、loop guard
│   │       ├── config/       模型配置、API Key 管理
│   │       ├── knowledge/    知识加载器、自动记忆、会话摘要与 token 用量
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
└── .x-code/         项目知识库目录（首次执行 /init 时创建）
    ├── memory/      AI 自动写入的记忆（auto.md）
    ├── sessions/    会话摘要与 token 用量
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

# 运行构建产物
node packages/cli/dist/cli.js

# 或从源码运行（先构建 core，再通过 tsx 直接执行 CLI 入口；不监听文件变更）
pnpm dev
```

> 修改源码后需重新执行 `pnpm build` 或 `pnpm dev` 才能看到改动。如需自动监听，可在 `packages/core` 下另开终端运行 `pnpm dev`（即 `tsc -b --watch`）。

## 反馈与贡献

欢迎通过 Issue 和 Pull Request 反馈：<https://github.com/woai3c/x-code-cli>

## License

[MIT](./LICENSE)
