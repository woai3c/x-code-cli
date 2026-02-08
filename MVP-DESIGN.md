# X-Code CLI — MVP 设计方案

## 一、项目概述

X-Code CLI 是一个终端 AI 编程助手，通过自然语言与用户交互，能够读写文件、执行命令、搜索代码，自主完成编程任务。

**MVP 目标**：实现一个可用的 Agent Loop，支持基础工具（读文件、写文件、执行命令），能完成一个真实的编程任务。

---

## 二、技术栈

| 类别 | 选型 | 版本 | 说明 |
|------|------|------|------|
| 语言 | TypeScript | 5.7+ | 严格模式，ESM |
| 运行时 | Node.js | 20.19+ | Ink 6 要求，ESLint 10 / yargs 18 要求 ≥20.19 |
| TUI 框架 | Ink | 6.6+ | React for CLI，ESM-only |
| UI 库 | React | 19+ | Ink 6 的 peer dependency |
| AI 接入 | Vercel AI SDK | 6.0+ | 统一 LLM 接口，流式 + 工具调用 |
| AI 模型 | 多模型 | @ai-sdk/* | 8 家内置（Anthropic / OpenAI / Google / xAI / DeepSeek / Qwen / 智谱 / Moonshot）+ 自定义 |
| Schema | Zod | 3.25+ | 工具参数校验（AI SDK 6 要求 ≥3.25.76） |
| 构建 | esbuild | 0.27+ | 打包为单文件 |
| 测试 | Vitest | 4.0+ | 单元 + 集成测试 |
| 参数解析 | yargs | 18+ | CLI 参数处理 |

---

## 三、项目结构

采用 **pnpm monorepo** 架构，将项目拆分为两个包：

- **`@x-code/core`**：Agent 逻辑层（AI SDK、工具、权限）—— 与 UI 无关，未来可复用于 VSCode 插件 / SDK
- **`@x-code/cli`**：TUI 表现层（Ink/React、yargs、用户交互）—— 依赖 core

**依赖关系**：

```
@x-code/cli  →  @x-code/core (workspace:*)
                    ↓
              ai, @ai-sdk/*, zod, globby, execa, @tavily/core, ...
```

**目录结构**：

```
x-code-cli/
├── packages/
│   ├── cli/                        # TUI 表现层
│   │   ├── src/
│   │   │   ├── index.ts            # CLI 入口（shebang + 参数解析）
│   │   │   ├── app.tsx             # Ink render 入口
│   │   │   ├── ui/
│   │   │   │   ├── components/
│   │   │   │   │   ├── App.tsx          # 根组件
│   │   │   │   │   ├── MessageList.tsx  # 消息历史（Static）
│   │   │   │   │   ├── StreamingText.tsx # 流式输出渲染
│   │   │   │   │   ├── ToolCall.tsx     # 工具调用展示
│   │   │   │   │   ├── ChatInput.tsx    # 用户输入框
│   │   │   │   │   ├── Spinner.tsx      # 加载动画
│   │   │   │   │   ├── Permission.tsx   # 权限确认 UI（含 diff 预览）
│   │   │   │   │   ├── ShellOutput.tsx  # Shell 命令实时输出
│   │   │   │   │   ├── StatusBar.tsx    # 底部状态栏（模型/token/费用）
│   │   │   │   │   ├── SelectOptions.tsx # askUser 多选交互
│   │   │   │   │   └── SetupWizard.tsx  # 首次使用引导
│   │   │   │   └── hooks/
│   │   │   │       └── use-agent.ts     # Agent 状态管理 Hook
│   │   │   └── config/
│   │   │       └── index.ts             # 配置管理（API Key 等）
│   │   ├── tests/
│   │   │   └── ui/
│   │   │       └── app.test.tsx
│   │   ├── esbuild.config.js       # 构建配置（打包为单文件）
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   │
│   └── core/                       # Agent 逻辑层（UI 无关）
│       ├── src/
│       │   ├── index.ts            # 公共 API 导出（barrel exports）
│       │   ├── agent/
│       │   │   ├── loop.ts         # Agent Loop 核心逻辑
│       │   │   ├── system-prompt.ts # System Prompt 管理
│       │   │   ├── plan-mode.ts    # Plan Mode 逻辑（提示注入/移除 + 计划文件管理）
│       │   │   └── messages.ts     # 消息类型定义与管理
│       │   ├── tools/
│       │   │   ├── index.ts        # 工具注册表（统一导出）
│       │   │   ├── read-file.ts    # 读文件
│       │   │   ├── write-file.ts   # 写文件
│       │   │   ├── edit.ts         # 精确字符串替换
│       │   │   ├── shell.ts        # 跨平台命令执行
│       │   │   ├── shell-utils.ts  # Shell 检测与抽象层
│       │   │   ├── glob.ts         # 文件搜索
│       │   │   ├── grep.ts         # 内容搜索
│       │   │   ├── list-dir.ts     # 目录列表
│       │   │   ├── web-search.ts   # 网页搜索
│       │   │   ├── web-fetch.ts    # 网页抓取
│       │   │   ├── ask-user.ts     # 交互式询问
│       │   │   ├── save-knowledge.ts # 知识持久化（CRUD）
│       │   │   ├── enter-plan-mode.ts # 进入计划模式
│       │   │   └── exit-plan-mode.ts  # 退出计划模式
│       │   ├── permissions/
│       │   │   └── index.ts        # 权限检查逻辑
│       │   ├── providers/
│       │   │   └── registry.ts     # AI SDK Provider Registry（多模型）
│       │   ├── config/
│       │   │   └── index.ts        # 配置加载（环境变量、配置文件）
│       │   ├── knowledge/
│       │   │   ├── loader.ts       # 知识加载器（分层加载、路径匹配）
│       │   │   ├── auto-memory.ts  # AutoMemory 类（CRUD + 冲突检测 + 淘汰）
│       │   │   ├── session.ts      # 会话记忆（自动摘要 + 跨会话延续）
│       │   │   └── hooks.ts        # 启动时项目扫描
│       │   └── types/
│       │       └── index.ts        # 公共类型定义
│       ├── tests/
│       │   ├── agent/
│       │   │   └── loop.test.ts
│       │   └── tools/
│       │       ├── read-file.test.ts
│       │       ├── write-file.test.ts
│       │       └── shell.test.ts
│       ├── package.json
│       ├── tsconfig.json
│       └── vitest.config.ts
│
├── .husky/pre-commit               # Git 提交前自动运行 lint-staged
├── .vscode/
│   ├── settings.json               # 保存时自动格式化 + ESLint 修复
│   └── extensions.json             # 推荐安装的扩展
├── .prettierrc                     # Prettier 配置
├── .prettierignore
├── eslint.config.mjs               # ESLint flat config
├── pnpm-workspace.yaml             # pnpm 工作区配置
├── package.json                    # 根包（private，共享 scripts + devDeps）
├── tsconfig.base.json              # 共享 TypeScript 配置
├── tsconfig.json                   # 项目引用根配置
├── .env.example                    # 环境变量示例
├── .gitignore
├── LICENSE
└── MVP-DESIGN.md
```

---

## 四、核心架构

### 4.1 整体流程

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────┐
│              Agent Loop                      │
│                                              │
│  ┌──────────┐    ┌───────────┐              │
│  │ streamText│───▶│ LLM 响应  │              │
│  │ (AI SDK) │    │(流式文本 + │              │
│  └──────────┘    │ 工具调用)  │              │
│                  └─────┬─────┘              │
│                        │                     │
│               finishReason?                  │
│              /            \                  │
│         'stop'        'tool-calls'           │
│           │               │                  │
│      输出结果         ┌───┴────┐             │
│      退出循环         │ 权限检查 │             │
│                      └───┬────┘             │
│                    允许 / 拒绝               │
│                     │       │                │
│                 执行工具  返回拒绝消息         │
│                     │       │                │
│                 结果反馈给 LLM               │
│                     │                        │
│                 继续循环 ◀──────────────────│
└─────────────────────────────────────────────┘
  │
  ▼
终端输出（Ink 渲染）
```

### 4.2 Agent Loop（核心）

**文件**: `packages/core/src/agent/loop.ts`

Agent Loop 是整个工具的灵魂。采用手动循环模式（非 ToolLoopAgent），以获得对权限检查和 UI 更新的完全控制。

**伪代码**:

```typescript
async function agentLoop(userMessage, callbacks) {
  messages.push({ role: 'user', content: userMessage })

  while (true) {
    // 上下文压缩检查：超过阈值时压缩旧消息
    if (estimateTokens(messages) > TOKEN_BUDGET * 0.8) {
      const summary = await compressMessages(messages, model)
      await saveSessionSummary(summary)          // 同时保存会话摘要
      callbacks.onContextCompressed(summary)
    }

    const result = streamText({
      model: registry.languageModel(modelId),
      system: SYSTEM_PROMPT,
      messages: messages,
      tools: toolRegistry,
    })

    // 逐 chunk 流式输出，驱动 UI 更新
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        callbacks.onTextDelta(chunk.text)
      }
      if (chunk.type === 'tool-call') {
        callbacks.onToolCall(chunk.toolName, chunk.input)
      }
    }

    // 收集完整响应 + 统计 token 用量
    const response = await result.response
    messages.push(...response.messages)
    tokenUsage.add(await result.usage)            // 累计 token 消耗
    callbacks.onUsageUpdate(tokenUsage)

    if ((await result.finishReason) === 'tool-calls') {
      for (const toolCall of await result.toolCalls) {
        const approved = await checkPermission(toolCall, callbacks.onAskPermission)
        const output = approved
          ? await executeTool(toolCall, callbacks)  // 传入 callbacks 用于流式输出
          : 'Permission denied by user.'
        messages.push(toolResultMessage(toolCall, output))
      }
      continue
    }

    break
  }
}
```

**关键设计决策**:

- **手动循环**而非 `ToolLoopAgent`：需要在工具执行前插入权限检查
- **callbacks 模式**：Loop 不直接操作 UI，通过回调通知状态变化
- **消息累积 + 自动压缩**：消息持续追加，超过 token 预算 80% 时自动压缩旧消息
- **token 用量追踪**：每轮累计 `inputTokens` + `outputTokens`，通过 callback 推送给 UI

#### 上下文压缩

对话 3-5 轮后，消息中包含大量工具调用结果（一个文件读取可能上千 token），不压缩会很快超出模型上下文窗口。

**压缩策略**：

```typescript
async function compressMessages(messages: Message[], model): Promise<Message[]> {
  // 1. 保留最近 N 条消息不压缩（保持当前工作上下文）
  const recent = messages.slice(-KEEP_RECENT)
  const old = messages.slice(0, -KEEP_RECENT)

  // 2. 用模型对旧消息生成摘要（一次额外的 LLM 调用）
  const { text: summary } = await generateText({
    model,
    messages: [
      { role: 'system', content: 'Summarize the following conversation concisely, preserving key decisions, file changes, and context needed to continue.' },
      ...old,
    ],
  })

  // 3. 用摘要替换旧消息
  return [
    { role: 'user', content: `[Previous conversation summary]\n${summary}` },
    ...recent,
  ]
}
```

**触发条件**：`estimateTokens(messages) > TOKEN_BUDGET * 0.8`

- `TOKEN_BUDGET` 根据模型的上下文窗口设置（如 Claude Sonnet: 200k，GPT-4o: 128k）
- `estimateTokens` 使用字符数粗估（`text.length / 4` 作为近似值，不需要精确 tokenizer）
- 压缩时同时触发**会话记忆保存**（10.8 节），一石二鸟

#### Token 用量统计

每轮 LLM 调用后累计 token 消耗，用户可随时查看：

```typescript
interface TokenUsage {
  inputTokens: number        // 输入 token 总数（AI SDK v6 命名）
  outputTokens: number       // 输出 token 总数（AI SDK v6 命名）
  totalTokens: number        // 合计
  estimatedCost: number      // 估算费用（基于模型单价）
}
```

**UI 展示**：在终端底部状态栏显示，或通过 `/usage` 命令查看：

```
> /usage
  本次会话: 12,450 prompt + 3,200 completion = 15,650 tokens
  估算费用: $0.08 (anthropic:claude-sonnet-4-5)
```

### 4.3 工具系统

**文件**: `packages/core/src/tools/*.ts`

参考 Claude Code、Gemini CLI、Cursor 等主流 Agent 的内置工具体系，MVP 采用分层设计，所有工具**开箱即用**，无需用户配置：

#### 工具分层

**第一层：核心工具** — 基础文件操作与命令执行

| 工具 | 功能 | 权限级别 |
|------|------|---------|
| `readFile` | 读取文件内容，支持行号范围 | 自动允许 |
| `writeFile` | 创建或覆盖文件 | 需确认 |
| `edit` | 精确字符串替换（比整文件覆写更安全、省 token） | 需确认 |
| `shell` | 执行命令（跨平台：Windows → PowerShell，Unix → bash） | 需确认（只读命令自动允许） |
| `glob` | 按 pattern 搜索文件路径 | 自动允许 |
| `grep` | 按正则搜索文件内容（底层用 ripgrep，通过 `@vscode/ripgrep` 包） | 自动允许 |
| `listDir` | 列出目录内容（比 shell ls 对 LLM 更友好） | 自动允许 |

**第二层：信息获取工具** — 网络搜索与页面抓取

| 工具 | 功能 | 权限级别 |
|------|------|---------|
| `webSearch` | 网页搜索（查文档、查错误信息） | 自动允许 |
| `webFetch` | 抓取网页内容并提取信息 | 自动允许 |

**webSearch API 选型 — Tavily**：

竞品搜索方案对比：

| 竞品 | 搜索方案 |
|------|---------|
| Gemini CLI | Google Search Grounding（自家 API） |
| Claude Code | Brave Search（Anthropic 服务端封装，$10/1000次） |
| OpenCode | Exa AI |
| Cline | 自建后端 |
| Roo Code | 无内置，MCP 接入 Tavily / Brave |
| Aider | 无搜索功能 |

竞品基本都是用各自绑定的搜索方案，没有统一标准。**Tavily** 是开源生态中最常见的选择（LangChain 默认集成、Roo Code MCP 推荐），返回格式对 LLM 友好，且提供免费额度（1000 次/月）。

**默认行为**：使用 Tavily（`@tavily/core`），无需配置 `TAVILY_API_KEY` 也可运行 — 搜索工具正常注册，调用时如果没有 Key 则返回错误提示让用户配置。

```typescript
async function webSearch(query: string): Promise<SearchResult> {
  if (!process.env.TAVILY_API_KEY) {
    return { error: '需要配置 TAVILY_API_KEY 才能使用搜索。免费注册：https://tavily.com（1000 次/月）' }
  }
  const client = new TavilyClient({ apiKey: process.env.TAVILY_API_KEY })
  const response = await client.search(query, { maxResults: 5 })
  return { results: response.results.map(r => ({ title: r.title, url: r.url, content: r.content })) }
}
```

webFetch 不需要任何 API Key，直接 HTTP 请求 + HTML 转 Markdown（使用 `cheerio` 解析 HTML + `turndown` 转 Markdown）。

**第三层：交互与知识工具** — Agent 与用户的结构化交互 + 持久化知识

| 工具 | 功能 | 权限级别 |
|------|------|---------|
| `askUser` | 向用户提出多选题，获取偏好或澄清需求 | 自动允许 |
| `saveKnowledge` | 持久化项目/全局知识（新增、修改、删除） | 自动允许 |

> **注意**：工具名从 `bash` 改为 `shell`，这是跨平台支持的关键设计决策（详见第 6.9 节）。

#### 工具定义模式（使用 AI SDK `tool()` + Zod）

```typescript
// packages/core/src/tools/read-file.ts
import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs/promises'

export const readFile = tool({
  description: 'Read the contents of a file at the given path. Returns the file content with line numbers.',
  parameters: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    offset: z.number().optional().describe('Start line (1-based)'),
    limit: z.number().optional().describe('Max lines to read'),
  }),
  execute: async ({ filePath, offset, limit }) => {
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.split('\n')
    const start = (offset ?? 1) - 1
    const end = limit ? start + limit : lines.length
    const sliced = lines.slice(start, end)
    const numbered = sliced.map((line, i) => `${start + i + 1}\t${line}`)
    return numbered.join('\n')
  },
})
```

```typescript
// packages/core/src/tools/shell.ts — 跨平台命令执行
import { tool } from 'ai'
import { z } from 'zod'

export const shell = tool({
  description: 'Execute a shell command and return stdout/stderr. Commands should be compatible with the current platform shell.',
  parameters: z.object({
    command: z.string().describe('The command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
  }),
  // 不提供 execute —— 在 agent loop 中手动执行（因为需要权限检查 + 跨平台 shell 选择 + 流式输出）
})

// Shell 执行器：流式输出 + 跨平台
async function executeShell(command: string, timeout: number, callbacks): Promise<string> {
  const { executable, args } = getShellConfig()
  const proc = execa(executable, [...args, command], { timeout })

  // 实时流式输出 stdout/stderr（用户能看到 npm install 的进度）
  proc.stdout?.on('data', (chunk) => callbacks.onShellOutput?.(chunk.toString()))
  proc.stderr?.on('data', (chunk) => callbacks.onShellOutput?.(chunk.toString()))

  const { stdout, stderr, exitCode } = await proc
  return `exit code: ${exitCode}\n${stdout}\n${stderr}`.trim()
}
```

```typescript
// packages/core/src/tools/ask-user.ts — 交互式询问
import { tool } from 'ai'
import { z } from 'zod'

export const askUser = tool({
  description: 'Ask the user a clarifying question with multiple-choice options. Use when you need user input to decide between approaches.',
  parameters: z.object({
    question: z.string().describe('The question to ask'),
    options: z.array(z.object({
      label: z.string().describe('Option label (1-5 words)'),
      description: z.string().describe('What this option means'),
    })).min(2).max(4).describe('Choices (an "Other" option is auto-appended)'),
  }),
  // 不提供 execute —— 通过回调触发 UI 渲染
})
```

```typescript
// packages/core/src/tools/index.ts
export const toolRegistry = {
  readFile, writeFile, edit, shell, glob, grep, listDir,
  webSearch, webFetch,
  askUser, saveKnowledge,
  enterPlanMode, exitPlanMode,
}
```

#### 工具结果截断

工具返回的结果可能非常大（grep 搜到数千行、readFile 读大文件），直接塞进消息会撑爆上下文。所有工具结果在返回给模型前做截断处理：

```typescript
const MAX_TOOL_RESULT_CHARS = 30000  // ~7500 tokens

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2)
  const truncatedLines = result.slice(half, -half).split('\n').length
  return result.slice(0, half)
    + `\n\n... [truncated ${truncatedLines} lines] ...\n\n`
    + result.slice(-half)
}
```

保留首尾各一半，中间截断并提示被截断的行数，让模型知道结果不完整、可用 offset/limit 再读。

#### 关于 `execute` 的设计选择

- **读操作工具**（readFile, glob, grep, listDir, webSearch, webFetch）直接提供 `execute`，AI SDK 自动执行
- **写操作和命令执行**（writeFile, edit, shell）**不提供** `execute`，在 Agent Loop 中手动处理，以便插入权限检查
- **交互工具**（askUser）**不提供** `execute`，通过回调触发 UI 渲染并等待用户响应
- **知识工具**（saveKnowledge）直接提供 `execute`，自动执行（内部处理知识 CRUD + 冲突检测）
- **计划工具**（enterPlanMode, exitPlanMode）**不提供** `execute`，在 Agent Loop 中手动处理（注入/移除 plan mode 提示 + 用户审核流程）

#### `askUser` 工具的交互流程

当 AI 需要用户做选择时（如技术选型、多种方案选择），会调用 `askUser` 工具：

```
AI 调用 askUser({
  question: "数据库用哪个方案？",
  options: [
    { label: "PostgreSQL", description: "关系型，适合复杂查询" },
    { label: "SQLite", description: "轻量级，无需服务器" },
    { label: "MongoDB", description: "文档型，Schema 灵活" }
  ]
})

┌──────────────────────────────────────────┐
│  ? 数据库用哪个方案？                       │
│    > PostgreSQL — 关系型，适合复杂查询       │
│      SQLite — 轻量级，无需服务器             │
│      MongoDB — 文档型，Schema 灵活          │
│      其他（自定义输入）                      │
│                                          │
│  ↑↓ 移动  Enter 确认                      │
└──────────────────────────────────────────┘

用户选择 "PostgreSQL" → 结果返回给 AI → AI 继续执行
```

**UI 实现**：使用自定义 Ink 组件（`<SelectOptions>`），基于 `useInput` hook 实现上下箭头导航 + Enter 确认。不使用 `@clack/prompts` 或 `enquirer`（它们会与 Ink 的 stdin 管理冲突）。

### 4.4 权限系统

**文件**: `packages/core/src/permissions/index.ts`

#### 三级权限模型

```
always-allow  → 自动放行（读操作）
ask           → 弹出确认（写操作、命令执行）
deny          → 直接拒绝（危险操作）
```

**规则设计**:

```typescript
type PermissionLevel = 'always-allow' | 'ask' | 'deny'

const rules = {
  readFile:  () => 'always-allow',
  glob:      () => 'always-allow',
  grep:      () => 'always-allow',
  listDir:   () => 'always-allow',
  webSearch: () => 'always-allow',
  webFetch:  () => 'always-allow',
  askUser:        () => 'always-allow',
  saveKnowledge:  () => 'always-allow',
  edit:           () => 'ask',
  writeFile: () => 'ask',
  shell:     (input) => {
    const cmd = input.command
    // 拆分子命令（处理管道、&&、;、|| 等组合命令）
    const subCommands = splitShellCommands(cmd)  // 按 |, &&, ;, || 拆分

    // 任一子命令危险 → 整条拒绝
    if (subCommands.some(isDestructive)) return 'deny'
    // 全部子命令只读 → 自动允许
    if (subCommands.every(isReadOnly)) return 'always-allow'
    // 其他 → 需确认
    return 'ask'
  },
}

/** 只读命令白名单 */
function isReadOnly(cmd: string): boolean {
  return /^\s*(ls|pwd|cat|head|tail|wc|echo|which|type|file|stat|du|df|env|printenv|git\s+(status|log|diff|branch|show|remote|tag))/.test(cmd.trim())
}

/** 危险命令黑名单 — 对每个子命令分别检查 */
function isDestructive(cmd: string): boolean {
  const c = cmd.trim()
  return /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/.test(c)
    || /\bsudo\b/.test(c)
    || /\bmkfs\b/.test(c)
    || /\bdd\s+if=/.test(c)
    || /\b(chmod|chown)\s+.*\//.test(c)  // 递归权限修改
    || />\s*\/dev\/sd/.test(c)           // 写入磁盘设备
    || /\bformat\b/.test(c)             // Windows format
    || /\bRemove-Item\s+.*-Recurse/.test(c) // PowerShell 递归删除
}
}
```

#### `--trust` / `-t` 信任模式

启动时传入 `--trust`（简写 `-t`）可跳过所有 `ask` 级别的确认，适合自动化脚本或信任 Agent 的场景：

```bash
xc -t "帮我重构这个模块"    # 所有写操作自动放行
xc --trust "修复所有 lint 错误"
```

**行为对比**：

| 权限级别 | 默认模式 | `--trust` 模式 |
|---------|---------|---------------|
| `always-allow` | 自动放行 | 自动放行 |
| `ask` | 弹出 Y/N 确认 | **自动放行** |
| `deny` | 直接拒绝 | **仍然拒绝** |

`deny` 级别永远不会被跳过（`rm -rf /`、`sudo`、`mkfs` 等破坏性命令），即使在 trust 模式下也会被拦截。

**实现方式**：在 Agent Loop 的权限检查中注入 `trustMode` 标志：

```typescript
async function checkPermission(toolCall, trustMode, onAskPermission) {
  const level = rules[toolCall.toolName](toolCall.input)
  if (level === 'deny') return false
  if (level === 'always-allow' || trustMode) return true
  return onAskPermission(toolCall)  // 弹出 UI 确认
}
```

### 4.5 UI 组件

**文件**: `packages/cli/src/ui/components/*.tsx`

基于 Ink 的组件树：

```
<App>
├── <MessageList>          # 已完成的消息（Static，不重渲染）
│   ├── <UserMessage>      #   用户消息（蓝色）
│   ├── <AssistantMessage>  #   AI 回复（绿色）
│   └── <ToolCall>         #   工具调用记录
├── <StreamingText>         # 当前正在流式输出的文本
├── <ShellOutput>          # Shell 命令实时输出（流式）
├── <Permission>           # 权限确认弹窗（Y/N + diff 预览）
├── <SelectOptions>        # askUser 工具的多选交互 UI
├── <Spinner>              # "Thinking..." 加载状态
├── <SetupWizard>          # 首次使用引导（选择提供商、输入 Key、选择模型）
├── <StatusBar>            # 底部状态栏（模型 / token / 费用）
└── <ChatInput>            # 用户输入框
```

**关键组件说明**:

**`<MessageList>`** — 使用 Ink 的 `<Static items={messages}>` 渲染已完成的消息。Static 组件的特性是：渲染后永不重渲染，性能极好，适合长对话。

**`<StreamingText>`** — 接收 `streamingText` 状态，每次 text-delta 触发 setState 重渲染。Ink 会 diff 终端输出，只更新变化部分。

**`<Permission>`** — 当工具需要权限确认时显示。展示工具名 + 参数 + **变更预览**，等待用户按 Y/N。使用 Ink 的 `useInput` hook 捕获键盘输入。在 `--trust` 模式下此组件不渲染。

对不同工具展示不同预览：
- **edit 工具**：显示 diff（红色旧文本 → 绿色新文本），让用户看到"具体改了什么"
- **writeFile 工具**：如果是覆盖已有文件，显示 diff；如果是新建文件，显示文件内容摘要
- **shell 工具**：显示完整命令 + 权限级别标识（只读/写入/危险）

**`<SelectOptions>`** — 当 AI 调用 `askUser` 工具时显示。自定义 Ink 组件，基于 `useInput` 实现上下箭头导航 + Enter 确认。自动追加"其他"选项支持自由输入。不使用 `@clack/prompts`（与 Ink 的 stdin 管理冲突）。

**`<SetupWizard>`** — 首次使用时渲染。引导用户选择提供商 → 输入 API Key → 选择默认模型。配置完成后切换到正常对话界面。

**`<ShellOutput>`** — Shell 工具执行时的实时输出展示。逐行渲染 stdout/stderr，让用户看到 `npm install`、`pnpm build` 等长命令的实时进度，而非等执行完才一次性展示。

**`<StatusBar>`** — 终端底部状态栏，显示：当前模型名、本次会话 token 消耗和估算费用、当前工作目录。使用 Ink 的 `<Box position="absolute" bottom={0}>` 固定在底部。

**`<ChatInput>`** — 多行文本输入。使用 Ink 的 `useInput` hook，Enter 提交，Ctrl+C 退出。

**大文本粘贴预览**：当用户粘贴超过阈值的文本时，输入框不展示全部内容，而是显示截断预览 + 字符数提示，按 Enter 发送时才将完整内容发送给模型。

```typescript
const PASTE_PREVIEW_THRESHOLD = 500 // 字符数阈值
const PASTE_PREVIEW_LINES = 3       // 预览显示的最大行数

// ChatInput 内部状态
interface InputState {
  rawText: string          // 用户输入的完整原始文本
  isPasteTruncated: boolean // 是否处于截断预览模式
}

// 检测粘贴：单次输入超过阈值视为粘贴
function isPasteInput(input: string): boolean {
  return input.length > PASTE_PREVIEW_THRESHOLD
}

// 生成预览文本
function getPreviewText(raw: string): string {
  const lines = raw.split('\n')
  const previewLines = lines.slice(0, PASTE_PREVIEW_LINES)
  const preview = previewLines.join('\n')
  const remaining = raw.length - preview.length
  if (remaining > 0) {
    return preview + `\n... (${raw.length} characters)`
  }
  return raw
}
```

**交互流程**：
1. 用户粘贴大段文本 → 检测到 `isPasteInput` → 设置 `isPasteTruncated = true`
2. 输入框显示：前 3 行 + `... (12345 characters)` 灰色提示
3. 用户可以继续正常输入/编辑（追加内容到 `rawText` 末尾）
4. 按 Enter 发送 → 使用 `rawText` 完整内容发送，同时在消息历史中展示完整内容
5. 发送后重置 `isPasteTruncated = false`

### 4.6 状态管理

**文件**: `packages/cli/src/ui/hooks/use-agent.ts`

使用 React Hook 管理全部 Agent 状态：

```typescript
interface AgentState {
  messages: DisplayMessage[]     // 已完成的消息列表（驱动 Static）
  streamingText: string          // 当前流式文本
  isLoading: boolean             // 是否等待 LLM 响应
  pendingPermission: {           // 待确认的权限请求
    toolName: string
    input: Record<string, unknown>
    resolve: (approved: boolean) => void
  } | null
  pendingQuestion: {             // 待回答的 askUser 请求
    question: string
    options: { label: string; description: string }[]
    resolve: (answer: string) => void
  } | null
}
```

数据流方向：

```
用户输入
  → useAgent.submit(text)
    → agentLoop(text, callbacks)
      → callbacks.onTextDelta      → setState({ streamingText })    → UI 重渲染
      → callbacks.onToolCall       → setState({ ... })              → UI 展示工具调用
      → callbacks.onAskPermission  → setState({ pendingPermission }) → UI 弹出 Y/N 确认
      → callbacks.onAskUser        → setState({ pendingQuestion })   → UI 弹出多选题
    → loop 结束
      → setState({ messages: [..., finalMessage], isLoading: false })
```

### 4.7 Plan Mode（计划模式）

**文件**: `packages/core/src/agent/plan-mode.ts`

复杂任务直接执行容易跑偏——先探索代码库、写计划、用户审核通过后再执行，效率更高。所有主流竞品（Claude Code、Cursor、Codex CLI、Gemini CLI）都有 Plan Mode。

#### 工作流程

```
用户输入复杂需求（或输入 /plan）
  │
  ▼
模型判断复杂度 ──── 简单任务 → 直接执行
  │
  复杂任务
  │
  ▼
模型调用 enterPlanMode 工具 → 用户同意 → 进入 Plan Mode
  │
  │  系统注入 Plan Mode 提示：
  │  "Plan mode is active. 只能使用只读工具，不能执行任何写操作。"
  │
  │  模型使用 readFile/glob/grep 探索代码库
  │  模型写计划到 .x-code/plans/{id}.md
  │
  ▼
模型调用 exitPlanMode 工具 → 系统读取计划文件展示给用户
  │
  ▼
用户审核计划 → 同意 → 移除 Plan Mode 提示 → 模型按计划执行
             → 拒绝 → 模型修改计划 / 用户手动调整
```

#### 实现方式

**核心：两个工具 + 一段 System Prompt overlay**

```typescript
// packages/core/src/tools/plan-mode.ts
export const enterPlanMode = tool({
  description: `Enter plan mode for exploring the codebase and designing an implementation plan.
Use proactively for non-trivial tasks: new features, multi-file changes, architectural decisions, unclear requirements.
Skip for: single-line fixes, obvious bugs, specific user instructions.`,
  parameters: z.object({}),
  // 不提供 execute — 在 Agent Loop 中处理（注入 plan mode 提示 + 等待用户同意）
})

export const exitPlanMode = tool({
  description: 'Signal that the plan is complete and ready for user review. The system will read the plan file and present it to the user.',
  parameters: z.object({}),
  // 不提供 execute — 在 Agent Loop 中处理（读取计划文件 + 展示给用户）
})
```

**Plan Mode 提示注入**（plan mode 激活期间，追加到每条消息）：

```
Plan mode is active. You MUST NOT make any edits to project code, execute write commands, or make any changes to user files.
Only use read-only tools: readFile, glob, grep, listDir, webSearch, webFetch.
The ONLY exception: use writeFile to save your plan to .x-code/plans/{plan-id}.md.
When the plan is ready, call exitPlanMode.
```

**关键设计决策**：
- **工具不实际移除**：只通过 prompt 约束行为，实现简单，与 Claude Code 做法一致
- **计划存文件**：写到 `.x-code/plans/` 目录，方便用户查看/编辑/复用
- **模型可主动触发**：System Prompt 指导模型对复杂任务主动调用 `enterPlanMode`，但需用户同意
- **用户也可手动触发**：`/plan` 命令或 `Shift+Tab` 快捷键

---

## 五、System Prompt

**文件**: `packages/core/src/agent/system-prompt.ts`

MVP 的 System Prompt 精简但完整，**关键在于注入平台和 shell 类型**，让模型生成与当前环境兼容的命令：

```
You are X-Code, an AI coding assistant running in the user's terminal.

## Capabilities
You have access to these tools:
- readFile: Read file contents with line numbers
- writeFile: Create or overwrite files
- edit: Replace specific strings in files (preferred over writeFile for modifications)
- shell: Execute commands in the current platform's shell
- glob: Find files by pattern (preferred over shell ls/find)
- grep: Search file contents by regex (preferred over shell grep)
- listDir: List directory contents
- webSearch: Search the web for information
- webFetch: Fetch and extract content from URLs
- askUser: Ask the user clarifying questions with choices
- saveKnowledge: Save project/user knowledge facts to persistent memory
- enterPlanMode: Enter plan mode to explore codebase and design implementation plan before coding
- exitPlanMode: Signal that plan is complete and ready for user review

## Planning
For non-trivial tasks (new features, multi-file changes, architectural decisions, unclear requirements), call enterPlanMode BEFORE writing any code. This lets the user review your approach first. Skip planning for simple fixes, single-line changes, or when the user gives very specific instructions.

## Rules

### File Operations
- ALWAYS read a file before modifying it
- Prefer edit (string replacement) over writeFile when modifying existing files — it's safer and costs fewer tokens
- Prefer editing existing files over creating new files — avoid file bloat
- Use absolute paths for all file operations
- Do NOT create files unless absolutely necessary for the task
- Do NOT add comments, docstrings, or type annotations to code you didn't change

### Command Execution
- Generate commands compatible with the current shell ({shell})
- Use platform-appropriate path separators and syntax
- Do NOT execute destructive commands (rm -rf, format, drop table) unless explicitly asked
- Prefer dedicated tools over shell commands: use glob instead of find/ls, grep instead of grep/rg, readFile instead of cat

### Interaction
- When uncertain between multiple approaches, use askUser to let the user choose
- Keep responses concise — focus on what changed and why
- Use markdown formatting with language-tagged code blocks

### Security
- NEVER output API keys, passwords, or secrets in responses
- NEVER generate code with known security vulnerabilities (injection, XSS, etc.)
- NEVER commit .env files or credential files
- If you notice insecure code, fix it or warn the user

## Auto Memory Guidelines
When you discover the following, call saveKnowledge to record:
- User explicitly tells you about tech stack changes (frameworks, toolchain, language versions)
- User expresses preferences (code style, reply language, work habits)
- You discover project conventions during task execution (naming rules, dir structure, test strategy)
- You find existing knowledge contradicts the current codebase (delete outdated knowledge)
Do NOT create memories for temporary, one-off information.

## Environment
- Platform: {platform}
- Shell: {shell}
- Working Directory: {cwd}
```

运行时动态填充的变量：

| 变量 | 来源 | 示例 |
|------|------|------|
| `{platform}` | `process.platform` | `win32` / `darwin` / `linux` |
| `{shell}` | 平台检测 | `powershell` / `bash` / `zsh` |
| `{cwd}` | `process.cwd()` | `/Users/xxx/project` |

**注入 shell 类型是跨平台支持的核心** — 模型看到 `Shell: powershell` 时会生成 PowerShell 命令，看到 `Shell: bash` 时生成 bash 命令。

**项目知识注入**：System Prompt 末尾会追加从 `.x-code/` 加载的项目知识（详见第十节），包括分层知识、自动记忆、会话摘要。规则按 4 种模式（Always / Path Match / Agent Requested / Manual）选择性加载。

---

## 六、多模型支持与配置管理

**文件**: `packages/core/src/config/`、`packages/cli/src/config/`

### 6.1 设计原则

- **开箱多模型**：基于 Vercel AI SDK Provider Registry，内置 Anthropic / OpenAI / Google / xAI / DeepSeek / 通义千问 / 智谱 / Moonshot 八家提供商
- **首次引导**：没有 API Key 时不直接报错退出，而是启动交互式引导流程
- **简单优先**：环境变量 → CLI 参数 → 配置文件，三层递进
- **自定义扩展**：支持任何 OpenAI 兼容的 API 端点，用户可自行接入未内置的模型

### 6.2 支持的模型提供商

| 提供商 | SDK 包 | 环境变量 | 模型示例 |
|--------|--------|---------|---------|
| Anthropic | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` | claude-sonnet-4-5, claude-opus-4-6 |
| OpenAI | `@ai-sdk/openai` | `OPENAI_API_KEY` | gpt-4.1, o3 |
| Google | `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` | gemini-2.5-pro |
| xAI | `@ai-sdk/xai` | `XAI_API_KEY` | grok-3 |
| DeepSeek | `@ai-sdk/deepseek` | `DEEPSEEK_API_KEY` | deepseek-chat, deepseek-reasoner |
| Alibaba Qwen（通义千问） | `@ai-sdk/alibaba` | `ALIBABA_API_KEY` | qwen-max, qwen-plus |
| Zhipu AI（智谱 GLM） | `zhipu-ai-provider` | `ZHIPU_API_KEY` | glm-4-plus, glm-4-flash |
| Moonshot AI（Kimi） | `@ai-sdk/moonshotai` | `MOONSHOT_API_KEY` | kimi-k2.5, moonshot-v1-128k |

**自定义 OpenAI 兼容提供商**：

对于未内置的模型提供商（如火山引擎豆包、百度文心一言），用户可通过配置 OpenAI 兼容端点接入：

| 环境变量 | 说明 |
|---------|------|
| `OPENAI_COMPATIBLE_API_KEY` | 自定义提供商的 API Key |
| `OPENAI_COMPATIBLE_BASE_URL` | 自定义提供商的 API 端点（如 `https://ark.cn-beijing.volces.com/api/v3`） |
| `OPENAI_COMPATIBLE_MODEL` | 要使用的模型名（如 `doubao-1.5-pro`） |

示例：接入火山引擎豆包
```bash
export OPENAI_COMPATIBLE_API_KEY="your-ark-api-key"
export OPENAI_COMPATIBLE_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
xc --model custom:doubao-1.5-pro
```

### 6.3 模型选择（优先级从高到低）

1. **CLI 参数**：`xc --model anthropic:claude-sonnet-4-5`
2. **环境变量**：`X_CODE_MODEL=anthropic:claude-sonnet-4-5`
3. **用户配置文件**：`~/.xcode/config.json` 中的 `model` 字段
4. **智能默认**：扫描已配置的 API Key，按以下顺序选择第一个可用的提供商：
   - `ANTHROPIC_API_KEY` → `anthropic:claude-sonnet-4-5`
   - `OPENAI_API_KEY` → `openai:gpt-4.1`
   - `DEEPSEEK_API_KEY` → `deepseek:deepseek-chat`
   - `ALIBABA_API_KEY` → `alibaba:qwen-max`
   - `GOOGLE_GENERATIVE_AI_API_KEY` → `google:gemini-2.5-pro`
   - 其他已配置的提供商...
   - 全部未配置 → 启动引导流程

**模型 ID 格式**：`提供商:模型名`，如 `anthropic:claude-sonnet-4-5`、`openai:gpt-4.1`

**内置别名**（可直接使用，无需写完整 ID）：

| 别名 | 解析为 | 说明 |
|------|--------|------|
| `sonnet` | `anthropic:claude-sonnet-4-5` | 默认推荐 |
| `opus` | `anthropic:claude-opus-4-6` | 最强 |
| `haiku` | `anthropic:claude-haiku-4-5` | 最快 |
| `gpt4` | `openai:gpt-4.1` | OpenAI 主力 |
| `gemini` | `google:gemini-2.5-pro` | Google 主力 |
| `deepseek` | `deepseek:deepseek-chat` | DeepSeek V3 |
| `r1` | `deepseek:deepseek-reasoner` | DeepSeek R1 推理模型 |
| `qwen` | `alibaba:qwen-max` | 通义千问 |
| `glm` | `zhipu:glm-4-plus` | 智谱 GLM |
| `kimi` | `moonshotai:kimi-k2.5` | Moonshot Kimi |

使用示例：`xc --model sonnet` 或 `xc --model deepseek` 或 `xc --model openai:gpt-4.1`

### 6.4 Provider Registry 实现

基于 AI SDK 的 `createProviderRegistry`，运行时根据可用 API Key 动态注册：

```typescript
import { createProviderRegistry } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { google } from '@ai-sdk/google'
import { xai } from '@ai-sdk/xai'
import { deepseek } from '@ai-sdk/deepseek'
import { createAlibaba } from '@ai-sdk/alibaba'
import { moonshotai } from '@ai-sdk/moonshotai'
import { zhipu } from 'zhipu-ai-provider'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export function createModelRegistry() {
  const providers: Record<string, any> = {}

  // 内置提供商 — 按环境变量动态注册
  if (process.env.ANTHROPIC_API_KEY) providers.anthropic = anthropic
  if (process.env.OPENAI_API_KEY) providers.openai = createOpenAI()
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) providers.google = google
  if (process.env.XAI_API_KEY) providers.xai = xai
  if (process.env.DEEPSEEK_API_KEY) providers.deepseek = deepseek
  if (process.env.ALIBABA_API_KEY) providers.alibaba = createAlibaba({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  })
  if (process.env.ZHIPU_API_KEY) providers.zhipu = zhipu
  if (process.env.MOONSHOT_API_KEY) providers.moonshotai = moonshotai

  // 自定义 OpenAI 兼容提供商
  if (process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_BASE_URL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
      baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
    })
  }

  return createProviderRegistry(providers)
}

// 使用示例：
// registry.languageModel('anthropic:claude-sonnet-4-5')
// registry.languageModel('deepseek:deepseek-chat')
// registry.languageModel('alibaba:qwen-max')
// registry.languageModel('custom:doubao-1.5-pro')
```

### 6.5 首次使用引导

当启动时没有检测到任何 API Key 时，不直接退出，而是启动交互式引导（使用 Ink 组件渲染）：

```
$ xc

  ┌ Welcome to X-Code! ─────────────────────────┐
  │                                               │
  │  未检测到 API Key，请先配置一个模型提供商。       │
  │                                               │
  │  ? 选择提供商:                                  │
  │    > Anthropic (Claude)                         │
  │      OpenAI (GPT)                              │
  │      Google (Gemini)                           │
  │      xAI (Grok)                                │
  │      DeepSeek                                  │
  │      Alibaba Qwen（通义千问）                    │
  │      Zhipu AI（智谱 GLM）                       │
  │      Moonshot AI（Kimi）                        │
  │      自定义 OpenAI 兼容 API                     │
  │                                               │
  │  ? 输入你的 DeepSeek API Key:                   │
  │    > sk-***                                    │
  │    获取地址: https://platform.deepseek.com      │
  │                                               │
  │  ? 选择默认模型:                                │
  │    > deepseek-chat (推荐)                       │
  │      deepseek-reasoner                         │
  │                                               │
  │  ✓ 配置已保存到 ~/.xcode/config.json            │
  │    提示: 也可通过环境变量 DEEPSEEK_API_KEY 配置   │
  │                                               │
  └───────────────────────────────────────────────┘

  Ready! 输入你的第一个问题开始...
```

引导流程逻辑：

1. 检测环境变量中是否有任何已知的 API Key（按顺序扫描所有支持的环境变量）
2. 如果有 → 自动选择该提供商，直接进入对话
3. 如果没有 → 启动引导 UI：选择提供商 → 输入 Key → 选择模型 → 保存配置
4. Key 保存到 `~/.xcode/config.json`（文件权限 600），不写入环境变量
5. 选择"自定义 OpenAI 兼容 API"→ 额外要求输入 API 端点 URL + 模型名

**各提供商 API Key 获取地址**：

| 提供商 | 获取地址 |
|--------|---------|
| Anthropic | https://console.anthropic.com/ |
| OpenAI | https://platform.openai.com/api-keys |
| Google | https://aistudio.google.com/apikey |
| xAI | https://console.x.ai/ |
| DeepSeek | https://platform.deepseek.com/api_keys |
| 通义千问 | https://dashscope.console.aliyun.com/apiKey |
| 智谱 AI | https://open.bigmodel.cn/usercenter/apikeys |
| Moonshot | https://platform.moonshot.ai/console/api-keys |

### 6.6 配置文件格式

```json
// ~/.xcode/config.json
{
  "model": "deepseek",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-xxx" },
    "openai": { "apiKey": "sk-xxx" },
    "deepseek": { "apiKey": "sk-xxx" },
    "alibaba": { "apiKey": "sk-xxx", "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    "zhipu": { "apiKey": "xxx.xxx" },
    "moonshotai": { "apiKey": "sk-xxx" },
    "custom": {
      "apiKey": "your-key",
      "baseURL": "https://ark.cn-beijing.volces.com/api/v3",
      "name": "doubao"
    }
  }
}
```

**安全注意**：配置文件中的 API Key 仅作为环境变量不方便时的备选方案。推荐优先使用环境变量。

**完整环境变量清单**：

| 环境变量 | 说明 | 必填 |
|---------|------|:---:|
| `ANTHROPIC_API_KEY` | Anthropic Claude API Key | 按需 |
| `OPENAI_API_KEY` | OpenAI GPT API Key | 按需 |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini API Key | 按需 |
| `XAI_API_KEY` | xAI Grok API Key | 按需 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 按需 |
| `ALIBABA_API_KEY` | 通义千问 / DashScope API Key | 按需 |
| `ZHIPU_API_KEY` | 智谱 GLM API Key | 按需 |
| `MOONSHOT_API_KEY` | Moonshot / Kimi API Key | 按需 |
| `OPENAI_COMPATIBLE_API_KEY` | 自定义 OpenAI 兼容提供商 Key | 按需 |
| `OPENAI_COMPATIBLE_BASE_URL` | 自定义提供商 API 端点 | 与上面配套 |
| `OPENAI_COMPATIBLE_MODEL` | 自定义提供商模型名 | 与上面配套 |
| `X_CODE_MODEL` | 默认使用的模型（如 `deepseek:deepseek-chat`） | 可选 |
| `TAVILY_API_KEY` | Tavily 搜索 API Key（免费 1000 次/月，https://tavily.com） | 可选 |

> 至少需要配置 **一个** 模型提供商的 API Key 才能使用。

### 6.7 内置斜杠命令

对话中可使用以下内置命令：

| 命令 | 功能 | 说明 |
|------|------|------|
| `/help` | 显示所有可用命令 | |
| `/model [name]` | 切换模型 / 查看可用模型 | `/model opus`、`/model deepseek` |
| `/plan` | 进入 Plan Mode | 只读探索 + 生成实施计划，需用户审核通过后执行（详见 4.7） |
| `/compact` | 手动触发上下文压缩 | 不等自动阈值，立即压缩旧消息 |
| `/usage` | 查看 token 用量和费用 | 本次会话的累计统计 |
| `/clear` | 清空对话历史 | 不退出程序，重新开始新对话（保留知识上下文） |
| `/init` | 初始化项目知识 | 分析项目结构，生成 `.x-code/knowledge.md` 等 |
| `/session save` | 手动保存会话摘要 | 不退出程序，保存当前进度 |
| `/exit` | 退出（等同 Ctrl+C） | 自动保存会话摘要后退出 |

### 6.8 CLI 参数

```bash
xc [options] [prompt]

# 基本使用
xc                              # 进入交互模式
xc "帮我修复这个 bug"            # 带初始提示进入交互模式
xc -p "解释这段代码"             # 非交互模式：执行完直接退出（适合脚本/CI）
cat error.log | xc "分析这个错误" # 管道输入：stdin 内容作为上下文

# 选项
--model, -m <id>                # 指定模型（如 sonnet、deepseek、openai:gpt-4.1）
--trust, -t                     # 信任模式：跳过写操作确认（deny 级别仍拦截）
--print, -p                     # 非交互模式：输出结果后退出，不进入交互循环
--max-turns <n>                 # 最大 Agent 循环轮次（默认 100，防止死循环）
--version, -v                   # 显示版本号
--help, -h                      # 显示帮助信息
```

**非交互模式（`--print` / `-p`）**：

适用于脚本、CI/CD、管道串联等场景。执行完 prompt 对应的任务后直接输出结果并退出，不进入交互式对话：

```bash
# 在 CI 中自动修复 lint 错误
xc -t -p "修复所有 eslint 错误"

# 管道：把文件内容传给 AI 分析
cat src/utils.ts | xc -p "这个文件有什么 bug"

# 脚本串联
xc -p "生成 CHANGELOG" > CHANGELOG.md
```

**最大轮次限制（`--max-turns`）**：

防止 Agent 陷入死循环（如反复执行失败的命令），默认 100 轮。到达上限后停止循环并提示用户。

### 6.9 跨平台设计（Windows / macOS / Linux）

X-Code CLI 的目标是原生支持所有主流平台，**不要求 Windows 用户安装 WSL**。

#### 为什么 Claude Code 需要 WSL，而我们不需要

Claude Code 的工具叫 `bash`，模型只会生成 bash 语法（heredoc、管道、`$()`），这些在 PowerShell/CMD 里无法运行，所以 Windows 上必须有 bash 运行时。

X-Code CLI 的工具叫 `shell`，运行时检测平台选择原生 shell，并在 System Prompt 中注入 shell 类型，让模型生成对应语法的命令。

#### 跨平台 Shell 抽象层

```typescript
// packages/core/src/tools/shell-utils.ts
import os from 'node:os'

export type ShellType = 'powershell' | 'bash' | 'zsh'

export function getShellConfig(): { executable: string; args: string[]; type: ShellType } {
  if (os.platform() === 'win32') {
    return { executable: 'powershell.exe', args: ['-NoProfile', '-Command'], type: 'powershell' }
  }
  const userShell = process.env.SHELL ?? '/bin/bash'
  const type = userShell.endsWith('zsh') ? 'zsh' : 'bash'
  return { executable: userShell, args: ['-c'], type }
}
```

#### 各层跨平台要点

| 层面 | 设计决策 |
|------|---------|
| **工具命名** | `shell`（非 `bash`），语义上不绑定特定 shell |
| **命令执行** | 运行时检测：Windows → PowerShell，macOS/Linux → bash/zsh |
| **System Prompt** | 注入 `{shell}` 变量，模型据此生成对应语法的命令 |
| **路径处理** | 全部用 Node.js `path` 模块（自动处理 `\` vs `/`） |
| **进程管理** | 使用 `execa` 库（跨平台进程管理，自动处理信号/编码） |
| **危险命令检测** | PowerShell 和 bash 分别维护检测规则 |
| **文件操作** | 使用 `node:fs` API，不依赖 shell 命令 |
| **沙盒** | MVP 不实现，后续可分平台实现 |

#### 已知挑战

Gemini CLI 的跨平台经验表明以下问题需要注意：
- PowerShell 的引号规则与 bash 差异巨大（单引号/双引号/转义）
- Windows 路径中的 `\` 可能被 shell 解释为转义符
- 部分 npm 包（如 `node-pty`）在 Windows 上需要预编译二进制
- 文件权限模型（Unix `chmod 600` vs Windows ACL）不同

### 6.10 错误恢复策略

**文件**: `packages/core/src/agent/loop.ts`（集成在 Agent Loop 中）

| 错误类型 | 恢复策略 | 说明 |
|---------|---------|------|
| **API 限流 (429)** | 指数退避重试（1s → 2s → 4s，最多 3 次） | AI SDK 内置 `maxRetries` 参数 |
| **API 认证失败 (401)** | 提示用户检查 Key，提供重新配置入口 | 不重试，直接提示 |
| **网络超时** | 重试 1 次，失败后提示 | 保留当前对话状态，不丢失上下文 |
| **模型不可用 (503)** | 提示用户切换备用模型 (`/model`) | 如果用户配置了多个 provider，建议切换 |
| **工具执行超时** | 返回超时提示给模型，模型决定下一步 | shell 默认 30s 超时，可通过参数调整 |
| **工具执行错误** | 将 stderr 返回给模型，模型自主修正 | 不中断循环，让模型看到错误并调整 |
| **上下文超限** | 触发压缩（4.2 节），压缩后继续 | 如果压缩后仍超限，提示用户开启新会话 |
| **Ctrl+C** | 中断当前操作，保存会话摘要后退出 | 不丢弃已完成的工作 |

```typescript
// AI SDK 内置重试配置
const result = streamText({
  model: registry.languageModel(modelId),
  maxRetries: 3,                    // API 限流/网络错误自动重试
  abortSignal: controller.signal,   // Ctrl+C 中断支持
  ...
})
```

---

## 七、构建与分发

### 构建流程

Monorepo 下有两种构建产物：

- **`@x-code/core`**：TypeScript 编译（`tsc`），输出 `packages/core/dist/`，供 cli 包引用
- **`@x-code/cli`**：esbuild 打包为单文件 `packages/cli/dist/cli.js`，包含 shebang，可直接执行

### esbuild 配置

**文件**: `packages/cli/esbuild.config.js`

```javascript
// 关键配置项
{
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli.js',
  jsx: 'automatic',         // React 19 自动 JSX
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node\n'  // CLI shebang
        + ESM_POLYFILLS           // __dirname/__filename polyfill
  },
}
```

### 根包 scripts（pnpm workspace）

```json
{
  "build": "pnpm -r run build",
  "dev": "pnpm --filter @x-code/cli run dev",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "eslint .",
  "lint:fix": "eslint . --fix",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "typecheck": "tsc -b",
  "ci": "pnpm typecheck && pnpm lint && pnpm test && pnpm build"
}
```

### Node.js 版本要求

根 `package.json` 和 `packages/cli/package.json` 中设置 `engines` 字段：

```json
{
  "engines": { "node": ">=20.19.0" }
}
```

ESLint 10、yargs 18 等依赖要求 Node ≥20.19.0。启动时如果检测到低版本 Node，输出明确提示并退出。

### 分发方式（MVP）

本地开发：`pnpm build && node packages/cli/dist/cli.js`
全局链接：`cd packages/cli && pnpm link --global` → 使用 `x-code` 或 `xc` 命令

---

## 八、测试策略

### Vitest 配置

每个包有独立的 `vitest.config.ts`，根目录通过 workspace 模式统一运行：

**文件**: `packages/core/vitest.config.ts`（示例）

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
})
```

**文件**: `packages/cli/vitest.config.ts`（示例）

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
```

### MVP 测试范围

| 模块 | 测试内容 | 优先级 |
|------|---------|--------|
| `tools/read-file` | 正常读取、行号范围、文件不存在 | P0 |
| `tools/write-file` | 正常写入、路径不存在 | P0 |
| `tools/shell` | 命令执行、超时、stderr、流式输出 | P0 |
| `tools/glob` | pattern 匹配 | P1 |
| `tools/grep` | 正则搜索、无结果 | P1 |
| `permissions` | 规则匹配、allow/ask/deny | P0 |
| `agent/loop` | mock LLM 响应，验证循环逻辑 | P1 |
| `ui/App` | ink-testing-library 渲染测试 | P2 |

### Mock 策略

- **LLM API**：mock `streamText` 返回预定义的流式响应
- **文件系统**：使用 `memfs` 或 `vi.mock('fs')`
- **子进程**：`vi.mock('execa')`

---

## 九、MVP 功能边界

### 包含（v0.1）

- [x] 基本对话能力（用户输入 → LLM 回复）
- [x] 流式文本输出
- [x] 13 个内置工具（readFile / writeFile / edit / shell / glob / grep / listDir / webSearch / webFetch / askUser / saveKnowledge / enterPlanMode / exitPlanMode）
- [x] 权限确认（写操作、命令执行前询问）+ `--trust` / `-t` 信任模式
- [x] Agent Loop（工具调用 → 结果反馈 → 继续推理）
- [x] 多模型支持（Anthropic / OpenAI / Google / xAI / DeepSeek / 通义千问 / 智谱 / Moonshot + 自定义 OpenAI 兼容，通过 AI SDK Provider Registry）
- [x] 首次使用引导（交互式选择提供商、输入 Key、选择模型）
- [x] 跨平台支持（Windows 原生 PowerShell / macOS / Linux，不依赖 WSL）
- [x] 交互式询问（AI 可向用户提出多选题，获取偏好）
- [x] 项目知识系统（`.x-code/` 目录，手动知识 + 自动提炼 + 4 种规则加载模式）
- [x] 知识验证与淘汰（90 天 TTL + 启动校验 + 模型主动清理）
- [x] 会话记忆（自动摘要 + 跨会话延续）
- [x] `xc init` 初始化命令（自动分析项目，预填充知识文件）
- [x] 上下文压缩（token 超阈值时自动压缩旧消息，支持长对话）
- [x] Shell 流式输出（长命令实时显示进度，如 npm install）
- [x] Token 用量统计（累计消耗 + 估算费用，`/usage` 命令查看）
- [x] 权限 diff 预览（edit/writeFile 确认时显示变更内容）
- [x] 错误恢复（API 限流重试、网络超时恢复、工具错误自修正）
- [x] Ctrl+C 优雅退出（保存会话摘要后退出）
- [x] Plan Mode（复杂任务先计划再执行，模型可主动触发，用户审核后执行）
- [x] 内置斜杠命令（/help、/model、/plan、/compact、/usage、/clear、/init、/exit）
- [x] 非交互模式（`--print` / 管道输入，适合脚本和 CI/CD）
- [x] 工具结果截断（防止大文件/大搜索结果撑爆上下文）
- [x] 最大轮次限制（`--max-turns`，防止 Agent 死循环）
- [x] 大文本粘贴预览（粘贴大段文本时只显示前 3 行 + 字符数，发送时才用完整内容）

### 不包含（后续迭代）

#### 第一优先：MCP 协议支持（v0.2）

MCP（Model Context Protocol）是 Anthropic 提出的开放协议，让 AI 工具动态连接外部服务。所有主流竞品（Claude Code、Cursor、Windsurf、Codex CLI、Gemini CLI、Cline、Roo Code）都已支持。

**为什么优先级最高**：没有 MCP，用户无法连接 GitHub、数据库、Jira 等外部工具，功能上与竞品差距最大。

**实现方案**：

```
X-Code（MCP 客户端）
    │
    ├── stdio ──→ 本地 MCP Server（子进程，如 Git、文件系统、数据库）
    │
    └── HTTP ──→ 远程 MCP Server（网络服务，如 GitHub API、Sentry）
```

- **协议**：JSON-RPC 2.0，支持 stdio + Streamable HTTP 两种传输
- **配置**：项目级 `.x-code/mcp.json` + 全局 `~/.xcode/mcp.json`
- **发现**：启动时连接所有配置的 MCP Server，握手协商能力，获取可用工具列表
- **注入**：MCP 工具与内置工具合并注册到 Agent Loop，模型统一调用
- **权限**：MCP 工具默认走 `ask` 级别，`--trust` 模式下自动放行
- **管理命令**：`xc mcp add <name> -- <command>`、`xc mcp list`、`xc mcp remove`

```json
// .x-code/mcp.json（项目级，可 git 追踪）
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "DATABASE_URL": "${DATABASE_URL}" }
    }
  }
}
```

**与内置工具的关系**：内置工具（readFile、shell 等）仍然是原生实现（性能更好），不走 MCP 协议。MCP 是给用户**扩展额外能力**的通道。

#### 第二优先：Skills 系统（v0.3）

Skills 是 Anthropic 发布的开放标准（agentskills.io），目前已被 Claude Code、Codex CLI、Cursor、Windsurf、Gemini CLI、Copilot、Roo Code 等 25+ 工具采纳。

**Skills vs Memory vs MCP 的关系**：

```
Memory（记忆）= 声明式知识 — "这个项目用 pnpm"
Skills（技能）= 过程式知识 — "怎么做一次 code review"
MCP  （连接）= 工具能力   — "连接 GitHub 创建 PR"
```

三者互补：MCP 提供**能力**，Skills 教 AI **怎么用**这些能力，Memory 提供**上下文**。

**实现方案**：

```
.x-code/skills/            # 项目级 Skills（git 追踪）
├── commit/
│   └── SKILL.md           # /commit 命令
├── review-pr/
│   ├── SKILL.md           # /review-pr 命令
│   └── references/
│       └── checklist.md   # 参考文档
└── deploy/
    ├── SKILL.md           # 部署操作手册
    └── scripts/
        └── check-env.sh   # 部署前检查脚本

~/.xcode/skills/           # 全局 Skills（所有项目可用）
└── code-style/
    └── SKILL.md
```

- **标准格式**：遵循 Agent Skills 开放标准（SKILL.md + YAML frontmatter）
- **渐进式加载**：启动时只加载 name + description（~100 token/skill），模型按需加载完整内容
- **触发方式**：用户手动 `/skill-name` 或模型根据 description 自动匹配
- **跨工具兼容**：同一套 skills 在 Claude Code、Cursor、Gemini CLI 等工具中也能用
- **内置 Skills**：预装几个常用 skill（如 `/commit`、`/init`）

```yaml
# .x-code/skills/commit/SKILL.md
---
name: commit
description: Create a well-formatted git commit following project conventions.
  Use when the user asks to commit changes or after completing a task.
---

## Instructions
1. Run `git diff --staged` to see staged changes
2. If nothing staged, run `git add -p` to interactively stage
3. Categorize changes: feat / fix / refactor / docs / test
4. Write commit message: `<type>(<scope>): <summary>`
5. Create the commit
```

#### 后续迭代清单

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | **MCP 协议** | 外部工具连接（GitHub、数据库、Jira 等），stdio + HTTP |
| P1 | **Skills 系统** | 可复用操作手册，遵循开放标准 |
| P1 | **Subagent（子 Agent）** | 独立上下文的子 LLM 实例。内置 Explore（只读，用便宜模型搜索代码库）和 General（全工具）子 Agent，支持自定义子 Agent（YAML frontmatter），支持并行执行。通过 `task` 工具在主 Agent 中调用 |
| P1 | **任务追踪** | todoWrite 工具，进度管理，复杂任务自动拆解为 checklist |
| P1 | **对话历史浏览** | `xc --resume` 继续上次会话、`/sessions` 查看历史会话列表、选择历史会话继续 |
| P2 | **费用预算限制** | `--max-cost 1.0` 控制单次会话最大花费，超出自动暂停 |
| P2 | **Git 集成** | 内置 git 操作（不依赖 shell 调用） |
| P2 | **图片/PDF 支持** | 多模态输入（截图分析、文档阅读） |
| P2 | **浏览器自动化** | Playwright 集成（截图、交互测试） |
| P3 | **插件系统** | 第三方扩展框架 |
| P3 | **VSCode 扩展** | 复用 @x-code/core，IDE 内使用 |

---

## 十、项目知识系统

AI 使用得越多，对项目理解越深 — 技术选型、代码约定、构建命令、业务上下文等知识应该被持久化，下次启动时自动加载为上下文。

### 10.1 设计原则

- **手动核心 + 自动补充**：团队手写的规范是基础，AI 自动提炼的知识是补充
- **与项目绑定**：知识存在项目的 `.x-code/` 目录中，跟随项目 git 仓库
- **分层加载**：全局偏好 → 项目知识 → 路径规则 → 自动记忆 → 本地偏好
- **大小可控**：自动记忆有行数限制，防止上下文膨胀
- **知识会过时**：有验证与淘汰机制，避免知识库无限膨胀、过时知识误导模型
- **跨会话延续**：会话摘要自动持久化，下次启动时恢复上下文，不丢失工作进度

### 10.2 存储结构

```
项目根目录/
├── .x-code/
│   ├── knowledge.md           # 核心项目知识（团队共享，git 追踪）
│   ├── rules/                 # 按模块/路径拆分的细粒度规则
│   │   ├── api.md             # paths: ["src/api/**"]
│   │   ├── testing.md         # paths: ["**/*.test.ts"]
│   │   └── ...
│   ├── memory/                # AI 自动提炼的知识
│   │   └── auto.md            # 自动累积的项目事实（建议 git 追踪）
│   ├── plans/                 # Plan Mode 生成的计划文件（可选 git 追踪）
│   │   └── {plan-id}.md      # 实施计划（markdown）
│   ├── sessions/              # 会话记忆（自动生成，gitignore）
│   │   ├── latest.json        # 最近一次会话摘要（启动时加载）
│   │   └── {session-id}.json  # 历史会话摘要（按需查看）
│   └── local/                 # 个人本地配置（自动 gitignore）
│       └── preferences.md     # 个人偏好
│
~/.xcode/
├── knowledge.md               # 全局个人知识（所有项目共用，手动编写）
├── memory/
│   └── auto.md                # 全局自动记忆（用户偏好，AI 自动提炼）
└── config.json                # 全局配置（API Key、默认模型等）
```

### 10.3 各层职责

| 层级 | 文件 | 编写者 | Git | 加载时机 |
|------|------|--------|-----|---------|
| 全局偏好 | `~/.xcode/knowledge.md` | 用户手动 | N/A | 始终加载 |
| 全局自动记忆 | `~/.xcode/memory/auto.md` | **AI 自动** | N/A | 前 200 行加载 |
| 项目知识 | `.x-code/knowledge.md` | 团队手动 / `xc init` 预填充 | 追踪 | 始终加载 |
| 路径规则 | `.x-code/rules/*.md` | 团队手动 | 追踪 | 按 paths 条件加载 |
| 项目自动记忆 | `.x-code/memory/auto.md` | **AI 自动** | 建议追踪 | 前 200 行加载 |
| 会话记忆 | `.x-code/sessions/latest.json` | **系统自动** | 忽略 | 仅最近一次会话 |
| 本地偏好 | `.x-code/local/preferences.md` | 用户手动 | 忽略 | 始终加载 |

自动记忆分两个维度：
- **项目自动记忆**（`.x-code/memory/auto.md`）— 项目级事实（技术栈、构建命令、代码约定），跟随仓库
- **全局自动记忆**（`~/.xcode/memory/auto.md`）— 用户级偏好（代码风格、交互习惯），跨项目生效

### 10.4 知识内容分类

**最有价值的六类知识**（按价值排序）：

| 类别 | 示例 | 来源 |
|------|------|------|
| **构建/测试命令** | `pnpm vitest run`、`pnpm build` | 自动提炼 |
| **技术选型** | "用 pnpm 不用 npm"、"用 Vitest 不用 Jest" | 手动 + 自动 |
| **架构地图** | 目录结构、模块关系、关键文件 | 手动 + `xc init` 生成 |
| **代码约定** | "组件用 PascalCase"、"用 named export" | 手动 |
| **注意事项** | "不要改 `generated/` 目录"、"API Key 在 .env" | 手动 + 自动 |
| **业务上下文** | "这是一个电商后台"、"用户体系基于 RBAC" | 手动 |

### 10.5 `.x-code/knowledge.md` 示例

```markdown
# 项目知识

## 概述
X-Code CLI 是一个终端 AI 编程助手，pnpm monorepo，包含 @x-code/core 和 @x-code/cli 两个包。

## 技术栈
- 语言: TypeScript 5.7+, 严格模式, ESM
- 运行时: Node.js 20.19+
- TUI: Ink 6 + React 19
- AI: Vercel AI SDK 6
- 测试: Vitest 4
- 构建: esbuild

## 常用命令
- 安装依赖: `pnpm install`
- 构建: `pnpm build`
- 测试: `pnpm test`
- 类型检查: `pnpm typecheck`
- Lint: `pnpm lint`

## 代码约定
- 组件用 PascalCase, 文件用 kebab-case
- 优先用 named export
- 使用 Prettier 格式化, 不加分号, 单引号

## 注意事项
- 不要手动修改 `dist/` 目录下的文件
- `.x-code/local/` 不要提交到 git
```

### 10.6 规则系统（多模式加载）

`.x-code/rules/` 下的规则文件支持 **4 种加载模式**，通过 frontmatter 控制：

| 模式 | frontmatter | 加载时机 | 适用场景 |
|------|-------------|---------|---------|
| **Always** | `alwaysApply: true` | 始终加载 | 全局代码风格、安全规范 |
| **Path Match** | `paths: [glob]` | 操作匹配路径的文件时 | 模块/目录特定约定 |
| **Agent Requested** | `description: "..."` | 模型根据描述判断是否需要 | 特定任务的指导（如数据库迁移、性能优化） |
| **Manual** | 无 frontmatter | 用户在对话中 `@rule-name` 引用 | 低频使用的参考规则 |

**示例**：

```markdown
---
paths: ["packages/core/src/tools/**"]
---
# 工具开发约定

- 每个工具一个文件，放在 `packages/core/src/tools/` 下
- 工具参数用 Zod schema 定义
- 读操作提供 execute，写操作不提供（在 agent loop 中手动执行）
- 每个工具必须有对应的测试文件
```

```markdown
---
paths: ["**/*.test.ts", "**/*.test.tsx"]
---
# 测试约定

- 使用 Vitest, 开启 globals
- Mock 文件系统用 memfs
- Mock LLM 用 vi.mock('ai')
- 测试文件放在对应包的 tests/ 目录下
```

```markdown
---
description: "数据库 schema 变更、迁移文件编写、ORM 配置相关的任务"
---
# 数据库迁移约定

- 迁移文件使用时间戳命名: `YYYYMMDDHHMMSS_description.ts`
- 每次迁移必须包含 up 和 down
- 不要在迁移中使用 raw SQL，用 ORM 的 schema builder
```

**加载逻辑**：

1. **Always** 规则：启动时全部加载到上下文
2. **Path Match** 规则：AI 读取或修改文件时，扫描 `paths` 字段，匹配的追加到上下文
3. **Agent Requested** 规则：启动时将所有规则的文件名和 `description` 列表发给模型，模型在需要时请求加载具体规则内容
4. **Manual** 规则：仅在用户对话中 `@rule-name` 引用时加载

### 10.7 自动知识提炼

#### 核心机制：模型通过 `saveKnowledge` 工具自主提炼（主力）

知识提炼的**主力是模型自己**。在正常对话过程中，模型根据用户的需求和执行结果自主判断是否需要记录知识，通过调用 `saveKnowledge` 工具完成。不需要额外的 LLM 调用 — 模型本来就在对话中，调用工具是自然行为。

**模型能提炼的知识范围**（这些只有模型能理解，程序做不到）：

- 代码约定："这个项目用 PascalCase 命名组件"
- 架构模式："API 层统一用 RESTful 命名"
- 用户偏好："用户偏好函数式而非 OOP"
- 技术选型："用户选择了 PostgreSQL 而非 SQLite"
- 业务上下文："这是一个电商后台，用户体系基于 RBAC"
- 过时知识清理："项目从 Jest 迁移到了 Vitest，旧知识需要删除"

**`saveKnowledge` 工具定义**：

```typescript
// packages/core/src/tools/save-knowledge.ts
export const saveKnowledge = tool({
  description: 'Save, update, or delete a project/user knowledge fact in persistent memory. Use when you discover project conventions, user preferences, or important facts worth remembering for future sessions.',
  parameters: z.object({
    action: z.enum(['add', 'delete']).describe('add = create or update (auto-replaces conflicting old fact), delete = remove outdated fact'),
    key: z.string().describe('A short unique identifier for this fact, e.g. "包管理器", "测试框架", "构建命令". Same key = same fact, used for conflict detection'),
    fact: z.string().describe('The fact value, e.g. "pnpm (workspace 模式)", "Vitest 3", "pnpm build"'),
    scope: z.enum(['project', 'global']).describe('project = this repo (.x-code/), global = all repos (~/.xcode/)'),
    category: z.enum(['tech-stack', 'commands', 'conventions', 'preferences', 'context']),
  }),
})
```

**对话中的自然调用示例**：

```
用户: "我们把测试框架从 Jest 换成 Vitest 了"
AI:
  1. 调用 saveKnowledge({ action:'add', key:'测试框架', fact:'Vitest 3', scope:'project', category:'tech-stack' })
     → AutoMemory 检测到 key='测试框架' 已存在（旧值 "Jest"）→ 自动替换
  2. 调用 saveKnowledge({ action:'delete', key:'Jest 测试命令', fact:'npx jest', scope:'project', category:'commands' })
     → 删除旧的 Jest 命令记录
  3. 回复用户："好的，已更新项目知识。后续会使用 Vitest 相关的命令和配置。"
```

```
用户: "以后回复我都用中文，代码注释也用中文"
AI:
  1. 调用 saveKnowledge({ action:'add', key:'语言偏好', fact:'中文回复和中文代码注释', scope:'global', category:'preferences' })
     → 写入全局自动记忆，所有项目生效
  2. 回复："好的，已记住。以后所有项目都会用中文回复和注释。"
```

#### 辅助机制：启动时项目扫描（补充）

除了模型主动提炼，启动时还会运行一次**项目扫描**，读取配置文件中的基础信息作为初始上下文。这不是真正的"知识提炼"，只是**读配置文件的字段值塞进上下文**，让模型从第一轮对话就知道项目的基本情况，不需要自己去发现。

```typescript
// packages/core/src/knowledge/hooks.ts

/** 启动时扫描项目配置文件，写入基础事实 */
export async function scanProject(projectRoot: string, memory: AutoMemory) {
  // 读 lock 文件 → 包管理器
  if (await fileExists(join(projectRoot, 'pnpm-lock.yaml'))) {
    memory.add({ fact: '包管理器: pnpm', category: 'tech-stack', date: today() })
  }

  // 读 package.json → scripts 命令、依赖框架
  const pkg = await readJsonSafe(join(projectRoot, 'package.json'))
  if (pkg?.scripts?.test) {
    memory.add({ fact: `测试命令: ${pkg.scripts.test}`, category: 'commands', date: today() })
  }
  if (pkg?.scripts?.build) {
    memory.add({ fact: `构建命令: ${pkg.scripts.build}`, category: 'commands', date: today() })
  }

  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  if (deps?.react) memory.add({ fact: `UI 框架: React ${deps.react}`, category: 'tech-stack', date: today() })
  if (deps?.vitest) memory.add({ fact: `测试框架: Vitest`, category: 'tech-stack', date: today() })
}
```

**扫描能做的事情很有限**，只有这些"一眼就能看出来"的配置信息：

| 扫描的文件 | 提取的信息 |
|-----------|-----------|
| `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` | 包管理器类型 |
| `package.json` scripts | 构建、测试、lint 命令 |
| `package.json` dependencies | 主要框架和版本 |
| `tsconfig.json` | TypeScript 配置（严格模式、ESM 等） |
| `.eslintrc` / `prettierrc` | 代码风格工具 |

**它做不到**理解代码含义、发现架构模式、学习用户习惯 — 这些全部依赖模型通过 `saveKnowledge` 工具在对话中完成。

#### 主次关系总结

```
知识提炼 ─┬─ 模型 saveKnowledge 工具（主力，约 80%）
          │   ├── 理解代码约定、架构模式
          │   ├── 学习用户偏好和习惯
          │   ├── 记录业务上下文
          │   └── 清理过时知识（新旧冲突时删除旧的）
          │
          └─ 启动时项目扫描（补充，约 20%）
              ├── 读配置文件字段值（包管理器、框架、命令）
              └── 让模型从第一轮就知道项目基本情况
```

#### 知识 CRUD（新增 / 修改 / 删除）

自动记忆不是只追加的日志，而是一个可维护的知识库。新知识可能与旧知识冲突，需要处理：

| 操作 | 触发方 | 示例 |
|------|--------|------|
| **新增** | 模型调用 `saveKnowledge(action:'add')` 或项目扫描 | key="包管理器", fact="pnpm (workspace)" |
| **修改** | 模型 add 时检测到同 key → 替换旧值 | key="构建命令" 从 `npm run build` → `pnpm build` |
| **删除** | 模型调用 `saveKnowledge(action:'delete')` | 迁移到 Vitest 后删除 key="Jest 测试命令" |

**冲突检测逻辑**（基于 `key` 字段精确匹配，不再靠字符串前缀猜测）：

```typescript
// packages/core/src/knowledge/auto-memory.ts

interface KnowledgeFact {
  key: string       // 唯一标识（如 "测试框架"、"构建命令"），相同 key = 同一件事
  fact: string      // 事实值（如 "Vitest 3"、"pnpm build"）
  category: 'tech-stack' | 'commands' | 'conventions' | 'preferences' | 'context'
  date: string      // 最后更新日期，用于淘汰判定
}

class AutoMemory {
  private facts: KnowledgeFact[]

  /** 新增或修改：同 category + 同 key → 替换旧的 */
  add(newFact: KnowledgeFact) {
    const conflictIndex = this.facts.findIndex(
      existing => existing.category === newFact.category && existing.key === newFact.key
    )
    if (conflictIndex >= 0) {
      this.facts[conflictIndex] = newFact  // 同 key → 替换（= 修改）
    } else {
      this.facts.push(newFact)             // 新 key → 追加（= 新增）
    }
    this.save()
  }

  /** 删除：按 key 精确移除 */
  delete(key: string, category?: string) {
    this.facts = this.facts.filter(f => !(f.key === key && (!category || f.category === category)))
    this.save()
  }

  /** 淘汰：移除超过 N 天未更新的事实 */
  evict(maxAgeDays: number = 90) {
    const cutoff = Date.now() - maxAgeDays * 86400_000
    this.facts = this.facts.filter(f => new Date(f.date).getTime() > cutoff)
    this.save()
  }
}
```

#### 全局 vs 项目

| 维度 | 写入文件 | 来源 |
|------|---------|------|
| 项目记忆 | `.x-code/memory/auto.md` | 启动扫描（基础配置）+ 模型 `saveKnowledge(scope:'project')`（代码约定、技术选型等） |
| 全局记忆 | `~/.xcode/memory/auto.md` | 仅模型 `saveKnowledge(scope:'global')`（用户偏好、交互习惯，跨项目生效） |

#### 存储格式

```markdown
## 自动记忆

### tech-stack
- [2025-02-08] 包管理器: pnpm (workspace 模式)
- [2025-02-08] UI 框架: React 19 + Ink 6
- [2025-02-08] 测试框架: Vitest 3

### commands
- [2025-02-08] 构建命令: pnpm build
- [2025-02-08] 测试命令: pnpm vitest run
- [2025-02-08] Lint 命令: pnpm lint

### conventions
- [2025-02-09] 组件命名: PascalCase 组件文件，kebab-case 工具文件
- [2025-02-09] 导出方式: 公共 API 通过 src/index.ts barrel export

### preferences（仅全局 auto.md）
- [2025-02-09] 语言偏好: 中文回复和中文代码注释
- [2025-02-09] 编程风格: 函数式风格而非 OOP
```

按 category 分组存储，每行格式为 `[日期] key: fact`，方便冲突检测（同 key → 替换）和人工审阅。

**加载限制**：启动时只加载前 **200 行**，超出部分不加载。超过 **90 天**未更新的条目在启动时自动淘汰。用户可随时手动编辑。

### 10.8 会话记忆（跨会话延续）

解决的问题：**"昨天做到一半的工作，今天继续时 AI 还记得"**。

知识系统记录的是长期有效的项目事实（技术栈、约定），而会话记忆记录的是**短期工作上下文**（正在做什么、做到哪了、遇到了什么问题）。两者互补。

#### 工作机制

```
对话进行中 ─────────┐
                     │  每 N 轮 / 上下文压缩时 / 会话结束时
                     ▼
              自动生成会话摘要
                     │
                     ▼
         .x-code/sessions/latest.json   ← 最新一次（启动时加载）
         .x-code/sessions/{id}.json     ← 历史归档（按需查看）
```

#### 会话摘要结构

```typescript
interface SessionSummary {
  id: string              // 会话 ID
  title: string           // 自动生成的标题（如 "实现用户认证模块"）
  startedAt: string       // 开始时间
  endedAt: string         // 结束时间
  status: 'completed' | 'in_progress' | 'abandoned'
  summary: string         // 工作内容概要（2-3 句话）
  keyResults: string[]    // 关键成果（完成了什么）
  pendingWork: string[]   // 未完成的工作（下次继续）
  filesModified: string[] // 本次修改的文件列表
  decisions: string[]     // 重要决策记录（如 "选择了 JWT 而非 session"）
}
```

#### 摘要生成时机

| 时机 | 触发方式 | 说明 |
|------|---------|------|
| **上下文压缩时** | 自动 | 对话过长需要压缩时，在压缩前生成摘要保存 |
| **会话结束时** | 自动 | 用户退出（Ctrl+C / `/exit`）时自动生成 |
| **手动保存** | `/session save` | 用户主动保存当前会话状态 |

#### 启动时加载

```
$ xc
  加载上下文...
  ✓ 项目知识 (.x-code/knowledge.md)
  ✓ 自动记忆 (.x-code/memory/auto.md, 42 条)
  ℹ 上次会话: "实现用户认证模块" (进行中, 2 项未完成)
    - 未完成: JWT refresh token 逻辑
    - 未完成: 登录接口的错误处理
  > 继续上次的工作？(Y/n)
```

如果用户选择继续，将上次会话摘要注入上下文，模型可以无缝接续。

#### 与竞品对比

| 工具 | 会话记忆 | 实现方式 |
|------|---------|---------|
| **X-Code** | **结构化摘要（JSON）** | 上下文压缩时 / 退出时自动生成，启动时询问是否继续 |
| Claude Code | 自动会话摘要 | 后台定时提取（每 ~5000 token），JSON 格式，自动注入 |
| Windsurf | 无 | — |
| Cursor | 无 | — |
| Copilot | 无 | — |

### 10.9 知识验证与淘汰

自动记忆会随时间膨胀，过时的知识反而会误导模型。需要主动清理机制。

#### 三层防腐策略

```
知识淘汰 ─┬─ ① 自动过期（程序自动）
          │      90 天未更新的条目 → 启动时自动移除
          │
          ├─ ② 模型主动清理（模型驱动）
          │      对话中发现与代码库不一致 → 调用 saveKnowledge(action:'delete')
          │
          └─ ③ 启动时校验（程序自动）
                 项目扫描发现事实变化 → 更新对应条目的日期和值
```

#### ① 自动过期

启动时运行 `AutoMemory.evict(90)`，移除超过 90 天未更新的条目。这是最粗粒度的兜底策略：

- 如果一个知识在 90 天内被模型重新 add（哪怕值不变），日期会刷新，不会被淘汰
- 项目扫描检测到的事实（包管理器、框架版本等）每次启动都会刷新日期
- 90 天阈值可在 `~/.xcode/config.json` 中配置（`memoryEvictDays`）

#### ② 模型主动清理

模型在对话中发现知识过时时主动删除：

```
用户: "把项目从 Webpack 迁移到 Vite"
AI:（完成迁移后）
  1. saveKnowledge({ action:'add', key:'构建工具', fact:'Vite 6', ... })
  2. saveKnowledge({ action:'delete', key:'Webpack 配置', ... })
  3. saveKnowledge({ action:'delete', key:'Webpack loader', ... })
```

#### ③ 启动时校验

启动时项目扫描（10.7 节）会重新读取配置文件。如果检测到的值与已有记忆不同，直接更新：

```typescript
// 扫描发现 pnpm-lock.yaml 存在
const existing = memory.find('包管理器', 'tech-stack')
if (existing && existing.fact !== 'pnpm') {
  // 配置文件变了（比如从 npm 换成了 pnpm），更新记忆
  memory.add({ key: '包管理器', fact: 'pnpm', category: 'tech-stack', date: today() })
}
```

#### 与 Copilot Agentic Memory 的对比

GitHub Copilot 的方案更精密（引用验证 + 28 天过期 + 自我修正），但它是**云端方案**，依赖 GitHub 基础设施。X-Code 作为本地 CLI，采用更轻量的方案：

| 维度 | Copilot Agentic Memory | X-Code |
|------|----------------------|--------|
| 存储 | GitHub 云端 | 本地文件 |
| 过期 | 28 天固定 TTL | 90 天可配置 TTL |
| 验证 | 引用验证（检查代码位置是否还存在） | 启动时配置文件校验 + 模型主动清理 |
| 自我修正 | 代码与记忆矛盾时自动修正 | 模型在对话中发现矛盾时调用 delete/add |
| 跨 Agent | 支持（Copilot 内部各 Agent 共享） | N/A（单 Agent） |

### 10.10 初始化命令 `xc init`

提供 `xc init` 命令，自动分析项目并**预填充**知识文件（不是空模板）：

```bash
$ xc init

  分析项目结构...
  ✓ 检测到 pnpm monorepo（2 个包: @x-code/core, @x-code/cli）
  ✓ 检测到 TypeScript 5.7（严格模式, ESM, 项目引用）
  ✓ 检测到 Vitest 4（全局模式）
  ✓ 检测到 ESLint 10 flat config + Prettier
  ✓ 检测到 React 19 + Ink 6
  ✓ 推断构建命令: pnpm build
  ✓ 推断测试命令: pnpm vitest run

  已生成:
    .x-code/knowledge.md    ← 含以上分析结果，可手动补充业务上下文
    .x-code/memory/auto.md  ← 初始自动记忆（包管理器、框架、命令等）
    .x-code/rules/          ← 空目录，可按需添加路径规则
    .x-code/local/          ← 个人配置目录（已添加到 .gitignore）
```

`xc init` 内部调用 `analyzeProject()`（10.7 节的启动时项目扫描），将检测到的事实同时写入 `knowledge.md`（人可读的概要）和 `memory/auto.md`（结构化的自动记忆）。

### 10.11 加载到 System Prompt 的方式

启动时按优先级从低到高拼接（后加载的优先级更高），注入 System Prompt 末尾：

```
## Project Knowledge

### Global Preferences
{~/.xcode/knowledge.md 的内容}

### Global Auto Memory
{~/.xcode/memory/auto.md 前 200 行}

### Project Knowledge
{.x-code/knowledge.md 的内容}

### Project Auto Memory
{.x-code/memory/auto.md 前 200 行}

### Local Preferences
{.x-code/local/preferences.md 的内容}

### Previous Session（仅当用户选择"继续"时注入）
{.x-code/sessions/latest.json 的摘要内容}
```

**规则加载**：
- **Always** 规则：启动时全部加载
- **Path Match** 规则：AI 操作对应路径的文件时动态追加
- **Agent Requested** 规则：规则描述列表始终加载，规则正文按模型请求加载
- **Manual** 规则：用户 `@rule-name` 引用时加载

### 10.12 与各家方案的对比

| 特性 | X-Code | Claude Code | Copilot | Windsurf | Cursor | Gemini CLI | Codex CLI |
|------|--------|-------------|---------|----------|--------|------------|-----------|
| 项目知识 | `.x-code/knowledge.md` | `CLAUDE.md`（6 层） | `.github/copilot-instructions.md` | `.windsurf/rules/*.md` | `.cursor/rules/*.mdc` | `GEMINI.md` | `AGENTS.md` |
| 全局配置 | `~/.xcode/knowledge.md` | `~/.claude/CLAUDE.md` | 用户级文件 | `global_rules.md` | User Rules (UI) | `~/.gemini/GEMINI.md` | `~/.codex/AGENTS.md` |
| 路径规则 | **4 种加载模式** | paths frontmatter | applyTo frontmatter | 4 种激活模式 | 4 种规则类型 | 子目录文件 | 子目录文件 |
| 项目自动记忆 | **结构化 CRUD** | 模型自由读写文件 | **Agentic Memory** | 模型自动提炼 | 无 | 无 | 早期阶段 |
| 全局自动记忆 | **模型工具 (跨项目)** | 无 | 无 | 无 | 无 | `/memory add` | 无 |
| 知识 CRUD | **key-based 精确替换** | 模型自由编辑 | 引用验证 + 自我修正 | 手动管理 | 手动编辑 | 仅追加 | 手动编辑 |
| 知识淘汰 | **90 天 TTL + 启动校验** | 无 | **28 天 TTL + 引用验证** | 无 | 无 | 无 | 无 |
| 会话记忆 | **结构化摘要** | 自动会话摘要 | 无 | 无 | 无 | 无 | 早期阶段 |
| 初始化 | **`xc init` (预填充)** | `/init` (骨架模板) | 无 | 无 | 无 | 无 | 无 |
| 本地覆盖 | `local/preferences.md` | `CLAUDE.local.md` | 无 | 无 | 无 | 无 | `AGENTS.override.md` |
| 存储位置 | 本地文件（项目内） | 本地文件（项目外） | **云端** | 本地加密 | 本地 | 本地文件 | 本地文件 |

#### X-Code 的差异化亮点

1. **双维度自动记忆**（项目 + 全局）— Claude Code 项目自动记忆存在用户目录不可团队共享，X-Code 存在项目内可 git 追踪
2. **key-based 结构化 CRUD**（比模型自由编辑文件更可控）— 通过工具 schema 约束格式，冲突检测基于 key 精确匹配而非字符串猜测
3. **三层防腐机制**（TTL 自动过期 + 启动校验 + 模型主动清理）— 大部分竞品没有知识淘汰，知识库会无限膨胀
4. **4 种规则加载模式**（Always / Path Match / Agent Requested / Manual）— 对齐 Cursor、Windsurf 的最佳实践
5. **会话记忆**（结构化摘要 + 跨会话延续）— 对齐 Claude Code，解决"工作做到一半，下次还能继续"
6. **`xc init` 预填充**（分析结果直接写入）— 比空模板实用得多

#### 坦诚不足（与 Copilot Agentic Memory 相比）

Copilot 的 Agentic Memory（2026.01）是目前架构上最先进的方案：
- **引用验证**：每条记忆关联具体代码位置，使用前检查源码是否还存在 — X-Code 靠 TTL + 启动校验替代，精度较低
- **跨 Agent 共享**：Copilot 内部多个 Agent（coding / review / CLI）共享记忆 — X-Code 是单 Agent，暂不需要
- **自我修正**：代码与记忆矛盾时自动生成修正版 — X-Code 依赖模型在对话中发现并手动删除

但 Copilot 的方案依赖云端基础设施，而 X-Code 是纯本地方案，数据始终在用户手中。

#### 多模型兼容性注意

`saveKnowledge` 工具的可靠性取决于模型的工具调用能力。不同模型的行为差异：

| 模型 | 工具调用可靠性 | 注意事项 |
|------|-------------|---------|
| Claude (Sonnet/Opus) | 高 | 工具调用倾向性强，通常会主动记录知识 |
| GPT-4o / o3 | 高 | 需要在 System Prompt 中明确提示何时该调用 |
| Gemini | 中 | 工具调用格式偶有偏差，需要更严格的 schema 校验 |
| DeepSeek (V3/R1) | 高 | Function calling 能力强，R1 推理模型可能响应较慢 |
| Qwen (Max/Plus) | 高 | 通义千问工具调用兼容性好，与 OpenAI 格式一致 |
| GLM-4 Plus | 中 | 需测试工具调用格式兼容性 |
| Kimi (K2.5) | 中 | 工具调用支持较新，需关注 schema 复杂度 |

**缓解策略**：在 System Prompt 中增加明确的指导段落，告诉模型何时应该调用 `saveKnowledge`：

```
## Auto Memory Guidelines
当你发现以下情况时，请调用 saveKnowledge 工具记录：
- 用户明确告知技术选型变更（框架、工具链、语言版本）
- 用户表达了偏好（代码风格、回复语言、工作方式）
- 你在执行任务中发现了项目约定（命名规则、目录结构、测试策略）
- 你发现已有知识与当前代码库不一致（需要 delete 旧知识）
不要为临时性、一次性的信息创建记忆。
```

---

## 十一、依赖清单

### `@x-code/core` dependencies

| 包 | 版本 | 用途 |
|----|------|------|
| `ai` | ^6.0.0 | Vercel AI SDK Core + Provider Registry（latest 6.0.77） |
| `@ai-sdk/anthropic` | ^3.0.0 | Claude 模型接入（latest 3.0.38） |
| `@ai-sdk/openai` | ^3.0.0 | OpenAI / GPT 模型接入（latest 3.0.26） |
| `@ai-sdk/google` | ^3.0.0 | Google / Gemini 模型接入（latest 3.0.22） |
| `@ai-sdk/xai` | ^3.0.0 | xAI / Grok 模型接入（latest 3.0.48） |
| `@ai-sdk/deepseek` | ^2.0.0 | DeepSeek 模型接入（latest 2.0.18） |
| `@ai-sdk/alibaba` | ^1.0.0 | 通义千问模型接入（latest 1.0.1） |
| `@ai-sdk/moonshotai` | ^2.0.0 | Moonshot / Kimi 模型接入（latest 2.0.3） |
| `@ai-sdk/openai-compatible` | ^2.0.0 | 自定义 OpenAI 兼容提供商接入（豆包、文心一言等）（latest 2.0.28） |
| `zhipu-ai-provider` | ^0.2.0 | 智谱 GLM 模型接入（社区包，latest 0.2.2） |
| `zod` | ^3.25.76 | 工具参数 Schema（AI SDK 6 peerDep 要求 ≥3.25.76） |
| `globby` | ^14.0.0 | glob 工具的底层依赖（latest 14.1.0） |
| `execa` | ^9.0.0 | 跨平台进程执行（latest 9.6.1） |
| `@tavily/core` | ^0.7.0 | webSearch 搜索 API（免费 1000 次/月，latest 0.7.1） |
| `@vscode/ripgrep` | ^1.17.0 | grep 工具底层（预编译 ripgrep 二进制，latest 1.17.0） |
| `cheerio` | ^1.0.0 | webFetch HTML 解析（latest 1.2.0） |
| `turndown` | ^7.2.0 | webFetch HTML→Markdown 转换（latest 7.2.2） |
| `diff` | ^8.0.0 | Permission 组件 diff 预览（edit/writeFile 变更对比，latest 8.0.3） |
| `chalk` | ^5.4.0 | 颜色输出（latest 5.6.2） |

### `@x-code/cli` dependencies

| 包 | 版本 | 用途 |
|----|------|------|
| `@x-code/core` | workspace:* | Agent 逻辑层 |
| `ink` | ^6.6.0 | TUI 框架（latest 6.6.0） |
| `react` | ^19.1.0 | Ink 的 peer dependency（latest 19.2.4） |
| `yargs` | ^18.0.0 | CLI 参数解析（latest 18.0.0） |
| `chalk` | ^5.4.0 | 颜色工具（latest 5.6.2） |

### 根包 devDependencies（共享）

| 包 | 版本 | 用途 |
|----|------|------|
| `typescript` | ^5.7.0 | 类型检查（latest 5.9.3） |
| `esbuild` | ^0.27.0 | 构建打包（latest 0.27.3，注意 0.x 下 ^ 只覆盖同 minor） |
| `vitest` | ^4.0.0 | 测试框架（latest 4.0.18） |
| `eslint` | ^9.0.0 | 代码检查（ESLint 10 插件生态尚未兼容，暂用 9，latest 9.28.0） |
| `typescript-eslint` | ^8.0.0 | ESLint TypeScript 支持（latest 8.54.0） |
| `eslint-plugin-react-hooks` | ^7.0.0 | React Hooks 规则（latest 7.0.1） |
| `eslint-plugin-unused-imports` | ^4.0.0 | 自动移除未使用 import（latest 4.3.0） |
| `prettier` | ^3.0.0 | 代码格式化（latest 3.8.1） |
| `@trivago/prettier-plugin-sort-imports` | ^6.0.0 | import 排序（latest 6.0.2） |
| `husky` | ^9.0.0 | Git hooks（latest 9.1.7） |
| `lint-staged` | ^16.0.0 | 只对暂存文件运行 lint/format（latest 16.2.7） |
| `@types/react` | ^19.0.0 | React 类型（latest 19.2.13） |
| `@types/node` | ^22.0.0 | Node.js 类型（latest 22.x，25.x 也可用但我们 target Node 20） |
| `@types/yargs` | ^17.0.0 | yargs 类型（yargs 18 暂无 @types/yargs@18，沿用 @types/yargs@17） |
| `ink-testing-library` | ^4.0.0 | Ink 组件测试（latest 4.0.0） |

---

## 十二、代码质量工具链

### ESLint（flat config）

**文件**: `eslint.config.mjs`

使用 ESLint 9 flat config 格式（ESLint 10 插件生态尚未兼容，待 typescript-eslint 支持后升级），主要规则集：

- `typescript-eslint/recommendedTypeChecked` — 基于类型信息的 TS 检查
- `eslint-plugin-react-hooks` — React Hooks 使用规范
- `eslint-plugin-unused-imports` — 自动移除未使用的 import

关键自定义规则：
- `@typescript-eslint/no-unused-vars` — 允许 `_` 前缀的未使用变量
- `@typescript-eslint/no-explicit-any` — 警告而非报错
- 全局注入 Vitest 的 `describe`、`it`、`expect` 等（替代 jest globals）

### Prettier

**文件**: `.prettierrc`

```json
{
  "singleQuote": true,
  "semi": false,
  "printWidth": 120,
  "trailingComma": "all",
  "plugins": ["@trivago/prettier-plugin-sort-imports"],
  "importOrder": [
    "^node:",
    "^react",
    "^ink",
    "^(ai|@ai-sdk)",
    "^zod",
    "^@x-code/",
    "^[./]"
  ],
  "importOrderSeparation": true,
  "importOrderSortSpecifiers": true
}
```

### Husky + lint-staged

- `.husky/pre-commit`：Git 提交前自动运行 `lint-staged`
- `lint-staged` 配置（写在根 `package.json` 中）：
  - `*.{ts,tsx}` → `eslint --fix` + `prettier --write`
  - `*.{json,md,yaml}` → `prettier --write`

### VSCode 集成

- `.vscode/settings.json`：保存时自动格式化（Prettier）+ ESLint 自动修复
- `.vscode/extensions.json`：推荐安装 ESLint 和 Prettier 扩展

---

## 十三、开发计划

### 阶段零：Monorepo 搭建（Day 0）

1. 初始化 pnpm monorepo（pnpm-workspace.yaml、根 package.json）
2. 创建 `packages/core` 和 `packages/cli` 骨架（package.json、tsconfig.json、vitest.config.ts）
3. 配置共享 TypeScript（tsconfig.base.json + 项目引用）
4. 配置 ESLint + Prettier + Husky + lint-staged
5. 验证：`pnpm install && pnpm typecheck && pnpm lint && pnpm format:check` 全部通过

### 阶段一：骨架搭建 + 多模型配置（Day 1）

1. 实现 CLI 入口（`packages/cli/src/index.ts`）+ yargs 参数解析（`--model`、`--trust`、`--print`、`--max-turns`、`--version`）
2. 实现 Ink 渲染 + 基本 App 组件
3. 实现多模型配置（Provider Registry + 环境变量 + `--model` 参数 + 智能默认选择）
4. 注册所有内置提供商（8 家）+ 自定义 OpenAI 兼容提供商
5. 实现首次使用引导（`<SetupWizard>`：选择提供商 → 输入 Key → 选择模型）
6. 实现 ChatInput 组件（能输入文本 + 提交 + stdin 管道输入检测）
7. 配置 esbuild 打包（`packages/cli/esbuild.config.js`）
8. 验证：首次启动能完成引导流程，`pnpm build` 后能看到输入框

### 阶段二：Agent Loop + 上下文管理（Day 2）

1. 在 `@x-code/core` 中实现 `streamText` 调用（先不带工具）
2. 在 `@x-code/cli` 中实现 StreamingText 组件（流式渲染 LLM 输出）
3. 实现 MessageList（对话历史）
4. 实现上下文压缩（token 估算 + 阈值检测 + 摘要压缩）
5. 实现 token 用量统计（累计消耗 + 估算费用）+ StatusBar 组件
6. 实现错误恢复策略（API 限流重试、网络超时、认证失败提示）
7. 验证：能和 LLM 对话，流式显示回复，长对话自动压缩

### 阶段三：核心工具（Day 3-4）

1. 在 `@x-code/core` 中实现 readFile / writeFile / edit / shell（跨平台）
2. 实现 shell-utils 跨平台抽象层（Windows → PowerShell，Unix → bash/zsh）
3. 实现 shell 流式输出（`execa` streaming + ShellOutput 组件）
4. 实现权限检查（子命令拆分 + 分别检测）+ Permission 组件（含 diff 预览）+ `--trust` 信任模式
5. 实现工具结果截断（MAX_TOOL_RESULT_CHARS = 30000）
6. 在 Agent Loop 中接入工具调用 + 最大轮次限制
7. 实现 glob / grep / listDir
8. 验证：让 AI 读一个文件并修改它（在 Windows 和 Mac 上分别测试）

### 阶段四：增强工具 + 知识系统（Day 5-7）

1. 实现 webSearch（Tavily API）/ webFetch（HTTP + HTML→Markdown）
2. 实现 askUser 工具 + `<SelectOptions>` 组件
3. 实现项目知识系统：
   - knowledge loader（分层加载、4 种规则加载模式）
   - AutoMemory 类（key-based CRUD + 冲突检测 + 90 天 TTL 淘汰）
   - saveKnowledge 工具（模型驱动知识提炼）
   - 启动时项目扫描（读配置文件注入基础上下文）
   - 启动时知识淘汰（`evict(90)`）+ 配置文件校验
4. 实现 `xc init` 命令（自动分析项目，预填充 `.x-code/knowledge.md` + `memory/auto.md`）
5. 实现规则系统（`.x-code/rules/*.md`，支持 Always / Path Match / Agent Requested / Manual）
6. 实现会话记忆（上下文压缩时 / 退出时自动生成摘要，启动时询问是否继续）
7. 实现 Plan Mode（enterPlanMode / exitPlanMode 工具 + system prompt overlay + 计划文件管理）
8. 实现内置斜杠命令（/help、/model、/plan、/compact、/usage、/clear、/init、/exit）
9. 实现非交互模式（`--print` + stdin 管道检测）
10. Ctrl+C 处理（保存会话摘要后退出）
11. ToolCall 组件（展示工具调用过程）+ Spinner 加载动画
12. 基础测试编写

---

## 十四、参考项目

| 项目 | 参考价值 | 链接 |
|------|---------|------|
| **Gemini CLI** | 技术栈完全一致（TS + esbuild + Ink + Vitest），架构最值得参考 | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |
| **AI SDK 文档** | streamText / tool 调用 / Agent Loop 的权威参考 | [ai-sdk.dev/docs](https://ai-sdk.dev/docs) |
| **Ink 文档** | 组件 API、hooks、Static 等 | [github.com/vadimdemedes/ink](https://github.com/vadimdemedes/ink) |
