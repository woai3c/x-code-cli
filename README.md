# X-Code CLI

[简体中文](./README.md) · [English](./README_EN.md)

**X-Code CLI** 是一款运行在终端中的 AI 编码助手。你可以用自然语言与代码库对话，让它帮你阅读、修改、调试和构建项目，而无需离开命令行。

它支持多种主流大模型（Claude、GPT、DeepSeek、Gemini、Qwen、Grok、GLM、Kimi 等），内置 13 个常用工具（文件读写、Shell 执行、代码搜索等），并提供权限控制、计划模式、上下文压缩、知识库等高级能力。

## 功能亮点

- **多模型支持**：内置 8 大主流厂商，也可自定义任意 OpenAI 兼容接口
- **13 个内置工具**：覆盖文件、Shell、搜索、网页抓取等日常开发场景
- **三级权限模型**：默认安全，写操作前会请求确认；`--trust` 一键放行
- **流式输出**：边生成边显示，无需等待完整响应
- **上下文压缩**：长对话自动压缩历史，避免超出 Token 限制
- **知识库系统**：7 层知识加载（项目规则、记忆、会话总结等）
- **计划模式**：复杂任务先出方案再执行，可随时审阅
- **斜杠命令**：`/help`、`/model`、`/usage`、`/plan` 等快捷指令
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

至少配置一个模型厂商的 API Key 即可使用：

| 环境变量                       | 厂商                    |
| ------------------------------ | ----------------------- |
| `ANTHROPIC_API_KEY`            | Anthropic（Claude）     |
| `OPENAI_API_KEY`               | OpenAI（GPT）           |
| `DEEPSEEK_API_KEY`             | DeepSeek                |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google（Gemini）        |
| `ALIBABA_API_KEY`              | 阿里通义（Qwen）        |
| `XAI_API_KEY`                  | xAI（Grok）             |
| `ZHIPU_API_KEY`                | 智谱（GLM）             |
| `MOONSHOT_API_KEY`             | Moonshot（Kimi）        |

### 网页搜索 Key（可选）

如需启用网页搜索（`web_search` 工具），从下面两个里**任选一个**配置即可：

| 环境变量          | 提供方                    |
| ----------------- | ------------------------- |
| `TAVILY_API_KEY`  | [Tavily](https://tavily.com) |
| `BRAVE_API_KEY`   | [Brave Search](https://brave.com/search/api/) |

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

| 命令            | 说明                              |
| --------------- | --------------------------------- |
| `/help`         | 查看所有可用命令                  |
| `/model [alias]` | 切换模型或查看可用模型列表        |
| `/usage`        | 查看 Token 用量（输入/输出/总计） |
| `/clear`        | 清空当前会话                      |
| `/compact`      | 手动压缩上下文                    |
| `/init`         | 初始化项目知识库                  |
| `/session save` | 保存当前会话（不退出）            |
| `/plan`         | 进入计划模式                      |
| `/exit`         | 保存会话并退出                    |

## 项目结构

```text
x-code-cli/
├── packages/
│   ├── core/        @x-code-cli/core    AI 引擎（无 UI 依赖）
│   │   └── src/
│   │       ├── agent/        Agent 循环、系统提示词、计划模式
│   │       ├── config/       模型配置、API Key 管理
│   │       ├── knowledge/    知识加载器、自动记忆、会话、项目扫描
│   │       ├── permissions/  三级权限系统
│   │       ├── providers/    AI SDK 厂商注册（8+ 个）
│   │       ├── tools/        13 个工具实现
│   │       └── types/        公开 TypeScript 接口
│   │
│   └── cli/         @x-code-cli/cli     终端界面
│       └── src/
│           ├── index.ts        CLI 入口
│           ├── app.tsx         Ink 应用根
│           └── ui/             React 组件、Hook、主题
│
└── .x-code/         项目知识库目录
    ├── memory/      自动生成的记忆
    ├── plans/       实现方案
    ├── rules/       自定义 Agent 规则
    ├── sessions/    会话总结
    └── local/       个人偏好（不入版本库）
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
