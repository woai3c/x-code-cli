# X-Code CLI — MVP 设计方案

## 一、项目概述

X-Code CLI 是一个终端 AI 编程助手，通过自然语言与用户交互，能够读写文件、执行命令、搜索代码，自主完成编程任务。

**MVP 目标**：实现一个可用的 Agent Loop，支持基础工具（读文件、写文件、执行命令），能完成一个真实的编程任务。

---

## 二、技术栈

| 类别     | 选型          | 版本       | 说明                                                                                      |
| -------- | ------------- | ---------- | ----------------------------------------------------------------------------------------- |
| 语言     | TypeScript    | 5.7+       | 严格模式，ESM                                                                             |
| 运行时   | Node.js       | 20.19+     | Ink 6 要求，ESLint 10 / yargs 18 要求 ≥20.19                                              |
| TUI 框架 | Ink           | 6.6+       | React for CLI，ESM-only                                                                   |
| UI 库    | React         | 19+        | Ink 6 的 peer dependency                                                                  |
| AI 接入  | Vercel AI SDK | 6.0+       | 统一 LLM 接口，流式 + 工具调用                                                            |
| AI 模型  | 多模型        | @ai-sdk/\* | 8 家内置（Anthropic / OpenAI / Google / xAI / DeepSeek / Qwen / 智谱 / Moonshot）+ 自定义 |
| Schema   | Zod           | 3.25+      | 工具参数校验（AI SDK 6 要求 ≥3.25.76）                                                    |
| 构建     | esbuild       | 0.27+      | 打包为单文件                                                                              |
| 测试     | Vitest        | 4.0+       | 单元 + 集成测试                                                                           |
| 参数解析 | yargs         | 18+        | CLI 参数处理                                                                              |

---

## 三、项目结构

采用 **pnpm monorepo** 架构，将项目拆分为两个包：

- **`@x-code-cli/core`**：Agent 逻辑层（AI SDK、工具、权限）—— 与 UI 无关，未来可复用于 VSCode 插件 / SDK
- **`@x-code-cli/cli`**：TUI 表现层（Ink/React、yargs、用户交互）—— 依赖 core

**依赖关系**：

```
@x-code-cli/cli  →  @x-code-cli/core (workspace:*)
                        ↓
                  ai, @ai-sdk/*, zod, globby, execa, @tavily/core, marked, ...
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
│   │   │   │   │   ├── App.tsx          # 根组件（挂 ChatInput，Ink 动态区保持空）
│   │   │   │   │   ├── ChatInput.tsx    # 底部区域唯一 owner：cell-level diff 渲染
│   │   │   │   │   │                    #   滚动历史提交 + spinner + 流式文本 + 错误行
│   │   │   │   │   │                    #   + Permission 对话框 + 输入框 + 补全菜单
│   │   │   │   │   ├── SelectOptions.tsx # askUser 多选（自由文本 Other 模式，走 Ink 渲染）
│   │   │   │   │   ├── AppHeader.tsx    # printHeader() ASCII banner（Ink 外直写 stdout）
│   │   │   │   ├── MessageList.tsx  # 消息列表（scrollback 历史）
│   │   │   │   ├── Permission.tsx   # 权限确认对话框（含 diff 预览）
│   │   │   │   ├── ShellOutput.tsx  # Shell 实时流式输出
│   │   │   │   ├── Spinner.tsx      # 通用加载动画
│   │   │   │   └── ToolCall.tsx     # 工具调用条目渲染
│   │   │   │   ├── hooks/
│   │   │   │   │   ├── use-agent.ts     # Agent 状态管理 Hook（orchestration，含 streamingText state）
│   │   │   │   │   ├── use-stream-buffer.ts # 流式文本缓冲：每 delta 更新 streamingText，\n\n 时提交
│   │   │   │   │   └── use-prompt-input.ts  # 自定义 stdin hook（bracketed paste + debounce）
│   │   │   │   ├── paste-refs.ts        # [Pasted text #N +M lines] 占位符 helper
│   │   │   │   ├── stdout-writer.ts     # writeMessageToStdout（消息格式化，供 ChatInput 调用）
│   │   │   │   ├── tool-display.ts      # 工具显示工具函数（标签/预览/摘要）
│   │   │   │   ├── render-markdown.ts   # Markdown → ANSI 终端渲染
│   │   │   │   └── theme.ts             # 主题颜色常量（ACCENT/SUCCESS/WARNING/ERROR）
│   │   │   ├── version.ts              # 构建注入的版本号
│   │   │   └── config/
│   │   │       └── index.ts             # CLI 侧配置（slash 命令等）
│   │   ├── esbuild.config.js       # 构建配置（打包为单文件）
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   │
│   └── core/                       # Agent 逻辑层（UI 无关）
│       ├── src/
│       │   ├── index.ts            # 公共 API 导出（barrel exports）
│       │   ├── agent/
│       │   │   ├── loop.ts             # Agent Loop 主编排（streaming / tool / compaction 协调）
│       │   │   ├── loop-state.ts       # LoopState 类型 + createLoopState()
│       │   │   ├── tool-execution.ts   # processToolCalls：权限检查 + 写/shell 工具分发
│       │   │   ├── context-window.ts   # 模型上下文窗口表 + 压缩阈值 + token 估算
│       │   │   ├── api-errors.ts       # classifyApiError + isContextTooLongError
│       │   │   ├── stream-utils.ts     # StreamResult 类型 + drainStreamResult
│       │   │   ├── provider-compat.ts  # DeepSeek reasoning_content shim
│       │   │   ├── system-prompt.ts    # System Prompt 管理
│       │   │   ├── plan-mode.ts        # Plan Mode 逻辑（提示注入/移除 + 计划文件管理）
│       │   │   └── messages.ts         # 消息类型定义与管理
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
│       │   │   └── index.ts        # 模型解析 + 环境变量读取（无配置文件）
│       │   ├── utils.ts            # 路径常量（XCODE_DIR / GLOBAL_XCODE_DIR）
│       │   ├── knowledge/
│       │   │   ├── loader.ts       # 知识加载器（AGENTS.md 向上遍历 + 分层拼接）
│       │   │   ├── auto-memory.ts  # AutoMemory 类（CRUD + 冲突检测 + 90 天 TTL）
│       │   │   ├── session.ts      # 会话记忆（自动摘要 + 跨会话延续）
│       │   │   └── init.ts         # /init 命令：在项目根生成 AGENTS.md 模板
│       │   └── types/
│       │       └── index.ts        # 公共类型定义
│       ├── tests/                  # agent-loop / config / knowledge / permissions / shell-utils / tool-registry / glob / grep / messages
│       ├── package.json
│       ├── tsconfig.json
│       └── vitest.config.ts
│
├── .husky/pre-commit               # Git 提交前自动运行 lint-staged
├── .prettierrc                     # Prettier 配置
├── .prettierignore
├── eslint.config.mjs               # ESLint flat config
├── commitlint.config.js            # commitlint（conventional commits）
├── pnpm-workspace.yaml             # pnpm 工作区配置
├── package.json                    # 根包（private，共享 scripts + devDeps）
├── tsconfig.base.json              # 共享 TypeScript 配置
├── tsconfig.json                   # 项目引用根配置
├── patches/                        # pnpm patch-package（修上游 ink 类依赖的小问题）
├── scripts/release.mjs             # 版本发布脚本
├── docs/                           # 设计与分析文档
├── CHANGELOG.md
├── README.md
├── .gitignore
└── LICENSE
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
    // 上下文压缩检查（双重检查）：
    // 1. 上一轮 API 返回的真实 inputTokens（最可靠）
    // 2. 字符数估算安全网（chars / 3.0，偏保守，防止单轮大文件读取撑爆上下文）
    if (lastInputTokens > COMPRESSION_THRESHOLD || estimateTokenCount(messages) > COMPRESSION_THRESHOLD) {
      const summary = await compressMessages(messages, model)
      await saveSessionSummary(summary) // 同时保存会话摘要
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

    // 收集完整响应 + 统计 token 用量（直接采用 API 返回的真实数字）
    const response = await result.response
    messages.push(...response.messages)
    const usage = await result.usage
    tokenUsage.add(usage) // 累计 token 消耗（inputTokens + outputTokens）
    lastInputTokens = usage.inputTokens // 下一轮压缩判断用
    callbacks.onUsageUpdate(tokenUsage)

    if ((await result.finishReason) === 'tool-calls') {
      for (const toolCall of await result.toolCalls) {
        const approved = await checkPermission(toolCall, callbacks.onAskPermission)
        const output = approved
          ? await executeTool(toolCall, callbacks) // 传入 callbacks 用于流式输出
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
- **消息累积 + 自动压缩**：消息持续追加，双重检查触发压缩——上一轮真实 inputTokens 超过模型上下文窗口 80%，或字符估算安全网（`chars / 3.0`）超阈值时自动压缩旧消息
- **token 用量追踪**：每轮累计 `inputTokens` + `outputTokens`（API 返回的真实数字，不做费用换算），通过 callback 推送给 UI

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
      {
        role: 'system',
        content:
          'Summarize the following conversation concisely, preserving key decisions, file changes, and context needed to continue.',
      },
      ...old,
    ],
  })

  // 3. 用摘要替换旧消息
  return [{ role: 'user', content: `[Previous conversation summary]\n${summary}` }, ...recent]
}
```

**触发条件**（双重检查，满足任一即触发）：

1. `lastInputTokens > contextWindow * 0.8` — 上一轮 API 响应的真实 token 数，最可靠的信号
2. `estimateTokenCount(messages) > contextWindow * 0.8` — 字符估算安全网（`总字符数 / 3.0`）

- `contextWindow` 根据模型设置（如 Claude Sonnet: 200k，GPT-4.1: 1M）
- 字符估算使用保守的 3.0 chars/token 比率（英文通常 ~4，CJK 和代码更低），故意让估算偏高，宁早不晚
- 字符估算的作用是**安全网**：当单轮工具输出（如读取大文件）一次性把上下文推过限制时，真实 token 数还没来得及更新，估算能提前拦截
- 压缩时同时触发**会话记忆保存**（10.8 节），一石二鸟

#### Token 用量统计

每轮 LLM 调用后累计 token 消耗，用户可随时查看：

```typescript
interface TokenUsage {
  inputTokens: number // 输入 token 总数（AI SDK v6 命名）
  outputTokens: number // 输出 token 总数（AI SDK v6 命名）
  totalTokens: number // 合计
}
```

> 只统计 token 数量，不做自动计费。不同 Provider 价格会调整、汇率会浮动，内置单价表很快就会过时，给用户一个不准的"费用"反而误导；真要看账单请去 Provider 控制台。

**UI 展示**：在终端底部状态栏显示，或通过 `/usage` 命令查看：

```
> /usage
  本次会话: 12,450 prompt + 3,200 completion = 15,650 tokens
  模型: anthropic:claude-sonnet-4-5
```

### 4.3 工具系统

**文件**: `packages/core/src/tools/*.ts`

参考 Claude Code、Gemini CLI、Cursor 等主流 Agent 的内置工具体系，MVP 采用分层设计，所有工具**开箱即用**，无需用户配置：

#### 工具分层

**第一层：核心工具** — 基础文件操作与命令执行

| 工具        | 功能                                                            | 权限级别                   |
| ----------- | --------------------------------------------------------------- | -------------------------- |
| `readFile`  | 读取文件内容，支持行号范围                                      | 自动允许                   |
| `writeFile` | 创建或覆盖文件                                                  | 需确认                     |
| `edit`      | 精确字符串替换（比整文件覆写更安全、省 token）                  | 需确认                     |
| `shell`     | 执行命令（跨平台：Windows → PowerShell，Unix → bash）           | 需确认（只读命令自动允许） |
| `glob`      | 按 pattern 搜索文件路径                                         | 自动允许                   |
| `grep`      | 按正则搜索文件内容（底层用 ripgrep，通过 `@vscode/ripgrep` 包） | 自动允许                   |
| `listDir`   | 列出目录内容（比 shell ls 对 LLM 更友好）                       | 自动允许                   |

**第二层：信息获取工具** — 网络搜索与页面抓取

| 工具        | 功能                           | 权限级别 |
| ----------- | ------------------------------ | -------- |
| `webSearch` | 网页搜索（查文档、查错误信息） | 自动允许 |
| `webFetch`  | 抓取网页内容并提取信息         | 自动允许 |

**webSearch API 选型 — Tavily 优先 + Brave 兜底**：

竞品搜索方案对比：

| 竞品        | 搜索方案                                         |
| ----------- | ------------------------------------------------ |
| Gemini CLI  | Google Search Grounding（自家 API）              |
| Claude Code | Brave Search（Anthropic 服务端封装，$10/1000次） |
| OpenCode    | Exa AI                                           |
| Cline       | 自建后端                                         |
| Roo Code    | 无内置，MCP 接入 Tavily / Brave                  |
| Aider       | 无搜索功能                                       |

竞品基本都是用各自绑定的搜索方案，没有统一标准。我们采用**双 provider**：**Tavily** 优先（LangChain 默认集成、返回格式对 LLM 友好、免费 1000 次/月），缺失时回退到 **Brave**（免费 2000 次/月，独立索引，不依赖 Google/Bing）。两家都必须自行注册 —— 三方 ToS 禁止在发行包里内置共享 key。

**默认行为**：

- `TAVILY_API_KEY` 存在 → 走 Tavily（`@tavily/core` SDK）
- 否则 `BRAVE_API_KEY` 存在 → 走 Brave（直接 `fetch` `api.search.brave.com`，无额外依赖）
- 两者都没有 → CLI 启动时 stderr 打印一次当前 shell（PowerShell / bash / zsh / fish / cmd）对应的配置命令；WebSearch 工具被调用时返回一段同样内容的错误,引导配置

```typescript
export const webSearch = tool({
  inputSchema: z.object({ query: z.string(), maxResults: z.number().optional() }),
  execute: async ({ query, maxResults }) => {
    const n = maxResults ?? 5
    if (process.env.TAVILY_API_KEY) return formatResults(await searchWithTavily(query, n))
    if (process.env.BRAVE_API_KEY) return formatResults(await searchWithBrave(query, n))
    return buildMissingKeyError() // 按当前 shell 定制的安装指引
  },
})
```

webFetch 不需要任何 API Key，直接 HTTP 请求 + HTML 转 Markdown（使用 `cheerio` 解析 HTML + `turndown` 转 Markdown）。15 min LRU URL 缓存 + Cloudflare 反爬降级(浏览器 UA → CLI UA)。

**第三层：交互与知识工具** — Agent 与用户的结构化交互 + 持久化知识

| 工具            | 功能                                    | 权限级别 |
| --------------- | --------------------------------------- | -------- |
| `askUser`       | 向用户提出多选题，获取偏好或澄清需求    | 自动允许 |
| `saveKnowledge` | 持久化项目/全局知识（新增、修改、删除） | 自动允许 |

> **注意**：工具名从 `bash` 改为 `shell`，这是跨平台支持的关键设计决策（详见第 6.9 节）。

#### 工具定义模式（使用 AI SDK `tool()` + Zod）

```typescript
// packages/core/src/tools/read-file.ts
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

export const readFile = tool({
  description: 'Read the contents of a file at the given path. Returns the file content with line numbers.',
  inputSchema: z.object({
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
  description:
    'Execute a shell command and return stdout/stderr. Commands should be compatible with the current platform shell.',
  inputSchema: z.object({
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
  description:
    'Ask the user a clarifying question with multiple-choice options. Use when you need user input to decide between approaches.',
  inputSchema: z.object({
    question: z.string().describe('The question to ask'),
    options: z
      .array(
        z.object({
          label: z.string().describe('Option label (1-5 words)'),
          description: z.string().describe('What this option means'),
        }),
      )
      .min(2)
      .max(4)
      .describe('Choices (an "Other" option is auto-appended)'),
  }),
  // 不提供 execute —— 通过回调触发 UI 渲染
})
```

```typescript
// packages/core/src/tools/index.ts
export const toolRegistry = {
  readFile,
  writeFile,
  edit,
  shell,
  glob,
  grep,
  listDir,
  webSearch,
  webFetch,
  askUser,
  saveKnowledge,
  enterPlanMode,
  exitPlanMode,
}
```

#### 工具结果截断

工具返回的结果可能非常大（grep 搜到数千行、readFile 读大文件），直接塞进消息会撑爆上下文。所有工具结果在返回给模型前做截断处理：

```typescript
const MAX_TOOL_RESULT_CHARS = 30000 // ~7500 tokens

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2)
  const truncatedChars = result.length - MAX_TOOL_RESULT_CHARS
  return result.slice(0, half) + `\n\n... [truncated ${truncatedChars} characters] ...\n\n` + result.slice(-half)
}
```

保留首尾各一半，中间截断并提示被截掉的字符数，让模型知道结果不完整、可用 offset/limit 再读。

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

| 权限级别       | 默认模式      | `--trust` 模式 |
| -------------- | ------------- | -------------- |
| `always-allow` | 自动放行      | 自动放行       |
| `ask`          | 弹出 Y/N 确认 | **自动放行**   |
| `deny`         | 直接拒绝      | **仍然拒绝**   |

`deny` 级别永远不会被跳过（`rm -rf /`、`sudo`、`mkfs` 等破坏性命令），即使在 trust 模式下也会被拦截。

**实现方式**：在 Agent Loop 的权限检查中注入 `trustMode` 标志：

```typescript
async function checkPermission(toolCall, trustMode, onAskPermission) {
  const level = rules[toolCall.toolName](toolCall.input)
  if (level === 'deny') return false
  if (level === 'always-allow' || trustMode) return true
  return onAskPermission(toolCall) // 弹出 UI 确认
}
```

### 4.5 UI 组件

**文件**: `packages/cli/src/ui/components/*.tsx`

**渲染架构**：上游 Ink 的 Yoga 布局 + log-update 在 CJK / IME / 长流式文本下会抖动和闪烁。主流 AI CLI 都 fork 了 Ink（Claude Code vendor 自己的、Gemini CLI 用 `@jrichman/ink`、Codex 用 Rust ratatui、opencode 用 OpenTUI）。我们走混合方案：

1. **依赖换成 Google 维护的 `@jrichman/ink@6.6.9`**（Gemini CLI 生产在用），通过 npm alias `"ink": "npm:@jrichman/ink@6.6.9"`，代码里 `import from 'ink'` 不改。fork 自带 cell-level StyledLine 测量 / DEC 2026 同步更新 / IME 光标定位。

2. **`<ChatInput>` 独占底部区域**，自己走 `process.stdout.write` + 2D cell-level diff，完全绕开 Ink 动态区。因为 fork 的 log-update 内部用 `\x1b7`/`\x1b8` 保存光标，终端只有一个 save register —— 如果 Ink 动态区也写东西，两套系统会抢这个寄存器，留下残影。所以 Ink 动态区保持**永远为空**（除非 `<SelectOptions>` 触发）。

```
App.tsx 渲染树（极简）
┌─────────────────────────────────────────────────────┐
│  <Box flexDirection="column" width={termWidth}>     │
│    {pendingQuestion && <SelectOptions ... />}       │  ← Ink 树里仅剩的动态内容（罕见）
│  </Box>                                              │
│                                                      │
│  <ChatInput                                          │  ← return null，不走 Ink 布局
│     messages={...}         # 滚动历史（自己写到 stdout） │
│     spinner={...}          # Thinking 行             │
│     streamingText={...}    # 流式 markdown 预览      │
│     errorMessage={...}     # 错误行                   │
│     permission={...}       # 权限弹窗（自己路由键盘）  │
│     hidden={!!pendingQuestion}                      │
│  />                                                  │
└─────────────────────────────────────────────────────┘

ChatInput 的 cell buffer 布局（自上而下，每部分按需出现）：
┌────────────────────────────────────────────────────┐
│ [Error 行]                                          │
│ [Streaming 文本（完整行, 经 renderMarkdown）]        │
│ [Permission 块（title + content + Yes/No）]         │
│ [空行] (有 streaming 或 permission 时作为 Thinking 顶部 margin) │
│ [⠋ Thinking... (Xs · ↑ Yk tokens)]                 │
│ ──── (顶部分隔线)                                    │
│ > 用户输入（多行 textarea, 10 行硬顶）              │
│ ──── (底部分隔线)                                    │
│ [/xxx 补全菜单]                                      │
└────────────────────────────────────────────────────┘
```

**关键组件说明**：

**`<ChatInput>`** — 底部区域**唯一** owner，500+ 行单文件包揽以下职责：

1. **滚动历史提交**：检测 `messages` prop 数组增长时，`eraseRegion()` 擦掉当前 cell frame，然后用 `process.stdout.write.bind(process.stdout)` 作为 write 函数调用 `writeMessageToStdout` 格式化并写每条新 message（消息走 `renderMarkdown` → ANSI → 2 空格缩进 → 落入 scrollback）。
2. **Cell-level diff 渲染**：每帧构建 2D `Cell[][]` 网格，对比 `prevFrameRef` 只写差异 cell，一次 `stdout.write()` 发一帧。
3. **DEC 2026 同步更新**：useEffect 整个 body 包在 `\x1b[?2026h` ... `\x1b[?2026l` 块里，支持的终端原子渲染整帧，消除 `eraseRegion + 写消息 + 重绘` 之间的闪烁。
4. **Spinner**：`spinner != null` 时内置 80ms 定时器更新 glyph，cell-diff 只重写 glyph 那一格。elapsed 时间从 `loadingStartRef` 渲染时现算（避免 setState-in-effect lint）。
5. **流式文本实时预览**：`streamingText` prop 过一遍 `renderMarkdown()` 得 ANSI 字符串，内置的 `ansiStringToCells()` 解析器（处理 SGR、跳过 OSC 超链接）把它切成带样式的 cell。只显示完整行（`trimToCompleteLines` 在 `useStreamBuffer` 里已截掉尾段），避免半截 markdown 闪烁。
6. **Permission 对话框**：`permission` prop 非空时在 cell buffer 里展开 title + content + Yes/No 行。键盘事件（Up/Down 切换选择、Enter 按当前选择 resolve、`y`/`n` 直接 resolve）**全部由 ChatInput 自己路由**，不再用 Ink 的 `useInput`。
7. **多行输入 + 补全菜单**：`usePromptInput`（自定义 stdin hook）+ paste 占位符 + 智能 backspace + `MAX_VISIBLE_LINES = 10` 硬顶。

**`<SelectOptions>`** — Ink 树里唯一的动态渲染例外：`askUser` 工具的多选交互，因为有自由文本输入模式（"Other"）需要完整键盘路由，留在 Ink 里。激活时 `hidden=true` 让 ChatInput 隐掉让出底部。触发频率极低。

#### usePromptInput — 自定义 stdin 输入管线

**文件**: `packages/cli/src/ui/hooks/use-prompt-input.ts`

Ink 的 `useInput` 不理解 bracketed paste mode（`\x1b[200~ … \x1b[201~`），Windows Terminal 也不保证把粘贴批量打包成一次 stdin data 事件。结果是大粘贴会被拆成多个小 chunk 逐字处理，触发 React setState 闭包竞态 + 字符丢失。ChatInput 因此自己挂 stdin 监听。

**双层粘贴检测**：

1. **Bracketed paste fast path**：启动时发送 `\x1b[?2004h` 启用，现代终端（Windows Terminal / VS Code / iTerm2 / gnome-terminal 等）会把粘贴用 `\x1b[200~/201~` 包裹，hook 的状态机原子 accumulate 内容然后一次性触发 `onPaste`
2. **30ms debounce fallback**：老终端（cmd.exe / 老 PowerShell console 等不响应 bracketed paste）走 debounce —— 所有可打印字符先进 `pendingTextRef` + 30ms 定时器，新数据到达就 reset 定时器，30ms 空闲才 flush；人类打字间隔 > 100ms 所以每个字符自己 flush，粘贴 burst 间隔 < 1ms 会全部累积到一个 chunk 里，作为 `onPaste` 触发

**行尾归一化**：所有 paste 入口都做 `replace(/\r\n?/g, '\n')`。必须的 —— Windows 剪贴板粘贴到终端 raw mode 时常被翻译成 `\r` 或 `\r\n`，裸 `\r` 在终端里是 carriage return（光标回行首），后续字符会覆盖之前打印的内容，直接导致"内容拼接错乱"bug。

**特殊键处理**：Enter / Backspace / Tab / Arrow keys / Ctrl+C 在 dispatch 前强制 flush pending，保证先后顺序正确。Ctrl+C 通过 `process.kill(process.pid, 'SIGINT')` 上交给外层 signal handler。

#### paste-refs.ts — 占位符流

**文件**: `packages/cli/src/ui/paste-refs.ts`

类似 Claude Code 的做法：大粘贴不在输入框里显示全文，而是显示 `[Pasted text #N +M lines]` 占位符，完整内容存到 ChatInput 的 `pastedContents` map。

```
onPaste(content):
  lineCount = content.split(/\r\n|\r|\n/).length
  isLarge  = lineCount >= 3 || content.length >= 400
    ├─ true  → 存 map，setText(text + [Pasted text #id +lineCount lines])
    └─ false → setText(text + content) 内联显示

onKey('return'):
  expanded = expandPasteRefs(text, pastedContents)  // 用存的完整内容替换所有占位符
  onSubmit(expanded)                                  // agent 看到完整文本

onKey('backspace'):
  stripTrailingRef(text):
    ├─ 若末尾是 [Pasted text #N ...] → 整体剥离 + 从 map 删除 id
    └─ 否则                           → text.slice(0, -1)
```

#### stdout-writer.ts — 消息写出管线

**文件**: `packages/cli/src/ui/stdout-writer.ts`

```
writeMessageToStdout(write: InkWrite, msg: DisplayMessage)
  │
  ├─ 归一化 msg.content: \r\n / \r → \n
  │   （防止裸 \r 在终端里触发 carriage return）
  │
  ├─ user message:
  │    write(`❯ <first>\n  <line 2>\n  <line 3>...\n\n`)
  │    （一次 write 整块 body，Ink 的 log-update 只跑一次 clear/write/redraw）
  │
  ├─ assistant with toolCalls:
  │    每个 tc 格式化为: ` ● ToolName(preview)\n   ⎿  result_summary (duration)`
  │
  └─ assistant with content:
       renderMarkdown → ANSI → 每行加 2 空格缩进 → write(indented + '\n\n')
```

**诊断 log 开关**：设 `DEBUG_STDOUT=1` 环境变量时，`debugLog` 会把事件（stream/buffer/stdout/chatinput.flush 及 payload）append 到 `<cwd>/stdout-debug.log`，便于对比 React state 与实际屏幕输出。默认关闭，不会创建文件。

### 4.6 状态管理

**文件**: `packages/cli/src/ui/hooks/use-agent.ts`

使用 React Hook 管理全部 Agent 状态。**流式文本放在 state 里**（`streamingText`）—— `@jrichman/ink` fork + ChatInput 的 cell-level diff 渲染不怕 CJK 宽度问题，每个 delta 只局部更新 cell。

```typescript
interface AgentState {
  messages: DisplayMessage[] // 已提交的 user/assistant/tool 条目（ChatInput 自己写到 scrollback）
  isLoading: boolean // 是否等待 LLM 响应
  currentToolCall: { toolName: string; input: Record<string, unknown> } | null
  shellOutput: string // Shell 实时输出（目前未在 UI 显示，保留数据）
  permissionQueue: PendingPermission[] // 队列：可能同时有多个待批权限
  pendingQuestion: { question; options; resolve: (answer: string) => void } | null
  usage: TokenUsage // { inputTokens, outputTokens, totalTokens }
  error: string | null
  streamingText: string // 正在流式输出的活文本，ChatInput 实时画在 cell buffer 里
}

// 流式文本：每 delta 更新 streamingText state；\n\n 段落边界提交到 messages
const { appendTextDelta, flushBuffer, resetBuffer } = useStreamBuffer(appendMessage, setStreamingText)
// 内部常量：MAX_STREAMING_LINES = 12（超过则强制提交到 scrollback 避免 cell buffer 过大）
```

**数据流方向**：

```
用户输入
  → ChatInput.handleSubmit(text)
  → App.handleSubmit → useAgent.submit(text)
    → setState({ messages: [...prev, userMsg], isLoading: true })
       └─ ChatInput useEffect: eraseRegion + writeMessageToStdout → scrollback (走 process.stdout.write)
    → agentLoop(text, callbacks)
       ├─ callbacks.onTextDelta(delta)
       │    → useStreamBuffer.appendTextDelta(delta)
       │    → bufferRef += delta
       │    ├─ 段落断点 \n\n → commitToScrollback (appendMessage to state.messages)
       │    │    → ChatInput useEffect eraseRegion + writeMessageToStdout → scrollback (经 renderMarkdown)
       │    ├─ 单段 > MAX_STREAMING_LINES(12) → 强制 commit
       │    └─ 默认 → setStreamingText(trimToCompleteLines(buffer))
       │              → React 自动 batch 连续 delta 成单次 re-render
       │              → ChatInput cell-level diff 只更新 streaming 区域变化的 cell
       │                (renderMarkdown + ansiStringToCells，cell buffer 里就已经是带格式 markdown)
       ├─ callbacks.onToolCall  → flushBuffer()（drain 文本）+ setState({ currentToolCall })
       │                          → spinner mode 变成 'tool-use'（↓ 箭头）
       ├─ callbacks.onToolResult → push DisplayToolCall 到 messages
       │                          → ChatInput useEffect 把 tool-call 行写到 scrollback
       ├─ callbacks.onAskPermission → permissionQueue += entry
       │                          → ChatInput 在 cell buffer 里展开 title/Yes/No
       │                          → 键盘 Up/Down/Enter/y/n 由 ChatInput 自己路由
       ├─ callbacks.onAskUser       → setState({ pendingQuestion })
       │                          → <SelectOptions> (Ink 渲染, 唯一例外)
       │                          → ChatInput 收到 hidden=true 隐藏自己让出底部
       ├─ callbacks.onShellOutput   → setState({ shellOutput: prev + chunk }) (目前未在 UI 显示)
       └─ callbacks.onUsageUpdate   → setState({ usage })
    → loop 结束
       ├─ flushBuffer() 把 buffer 最后一段残留提交到 messages
       ├─ 安全网：若 sawTextDelta=false，从 loopState.messages 兜底抽取文本
       └─ setState({ isLoading: false, currentToolCall: null })
          → spinner 消失、streamingText 清空、cell buffer 收缩
```

**为什么 streaming 文本进 React state 而不是 ref**：

`@jrichman/ink` fork（cell-level 测量 + 同步更新）+ ChatInput 自己的 cell-level diff 保证宽度计算正确、重绘原子化，所以可以把 streaming 文本直接放 state 实时渲染。两个好处：

- UX：用户看到"完整行一行行出现"，接近 Claude Code 的块粒度体验
- Markdown 格式：cell buffer 里的 streaming 预览已经经过 `renderMarkdown`，跟提交到 scrollback 那一瞬间视觉完全一致，消除"plain text → markdown"的转换闪烁

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
  inputSchema: z.object({
    topic: z
      .string()
      .describe(
        'Short 3-6 word description of what this plan addresses, used to name the plan file (e.g. "refactor auth middleware").',
      ),
  }),
  // 不提供 execute — 在 Agent Loop 中处理（注入 plan mode 提示 + 等待用户同意）
})

export const exitPlanMode = tool({
  description:
    'Signal that the plan is complete and ready for user review. The system will read the plan file and present it to the user.',
  inputSchema: z.object({}),
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

| 变量         | 来源               | 示例                          |
| ------------ | ------------------ | ----------------------------- |
| `{platform}` | `process.platform` | `win32` / `darwin` / `linux`  |
| `{shell}`    | 平台检测           | `powershell` / `bash` / `zsh` |
| `{cwd}`      | `process.cwd()`    | `/Users/xxx/project`          |

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

| 提供商                   | SDK 包               | 环境变量                       | 模型示例                           |
| ------------------------ | -------------------- | ------------------------------ | ---------------------------------- |
| Anthropic                | `@ai-sdk/anthropic`  | `ANTHROPIC_API_KEY`            | claude-sonnet-4-5, claude-opus-4-6 |
| OpenAI                   | `@ai-sdk/openai`     | `OPENAI_API_KEY`               | gpt-4.1, o3                        |
| Google                   | `@ai-sdk/google`     | `GOOGLE_GENERATIVE_AI_API_KEY` | gemini-2.5-pro                     |
| xAI                      | `@ai-sdk/xai`        | `XAI_API_KEY`                  | grok-3                             |
| DeepSeek                 | `@ai-sdk/deepseek`   | `DEEPSEEK_API_KEY`             | deepseek-chat, deepseek-reasoner   |
| Alibaba Qwen（通义千问） | `@ai-sdk/alibaba`    | `ALIBABA_API_KEY`              | qwen-max, qwen-plus                |
| Zhipu AI（智谱 GLM）     | `zhipu-ai-provider`  | `ZHIPU_API_KEY`                | glm-4-plus, glm-4-flash            |
| Moonshot AI（Kimi）      | `@ai-sdk/moonshotai` | `MOONSHOT_API_KEY`             | kimi-k2.5, moonshot-v1-128k        |

**自定义 OpenAI 兼容提供商**：

对于未内置的模型提供商（如火山引擎豆包、百度文心一言），用户可通过配置 OpenAI 兼容端点接入：

| 环境变量                     | 说明                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| `OPENAI_COMPATIBLE_API_KEY`  | 自定义提供商的 API Key                                                   |
| `OPENAI_COMPATIBLE_BASE_URL` | 自定义提供商的 API 端点（如 `https://ark.cn-beijing.volces.com/api/v3`） |
| `OPENAI_COMPATIBLE_MODEL`    | 要使用的模型名（如 `doubao-1.5-pro`）                                    |

示例：接入火山引擎豆包

```bash
export OPENAI_COMPATIBLE_API_KEY="your-ark-api-key"
export OPENAI_COMPATIBLE_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
xc --model custom:doubao-1.5-pro
```

### 6.3 模型选择（优先级从高到低）

1. **CLI 参数**：`xc --model anthropic:claude-sonnet-4-5`
2. **环境变量**：`X_CODE_MODEL=anthropic:claude-sonnet-4-5`
3. **智能默认**：扫描已配置的 API Key，按以下顺序选择第一个可用的提供商：
   - `ANTHROPIC_API_KEY` → `anthropic:claude-sonnet-4-5`
   - `OPENAI_API_KEY` → `openai:gpt-4.1`
   - `DEEPSEEK_API_KEY` → `deepseek:deepseek-chat`
   - `ALIBABA_API_KEY` → `alibaba:qwen-max`
   - `GOOGLE_GENERATIVE_AI_API_KEY` → `google:gemini-2.5-pro`
   - 其他已配置的提供商...
   - 全部未配置 → 报错并打印所有支持的环境变量名

**模型 ID 格式**：`提供商:模型名`，如 `anthropic:claude-sonnet-4-5`、`openai:gpt-4.1`

**内置别名**（可直接使用，无需写完整 ID）：

| 别名       | 解析为                        | 说明                 |
| ---------- | ----------------------------- | -------------------- |
| `sonnet`   | `anthropic:claude-sonnet-4-5` | 默认推荐             |
| `opus`     | `anthropic:claude-opus-4-6`   | 最强                 |
| `haiku`    | `anthropic:claude-haiku-4-5`  | 最快                 |
| `gpt4`     | `openai:gpt-4.1`              | OpenAI 主力          |
| `gemini`   | `google:gemini-2.5-pro`       | Google 主力          |
| `deepseek` | `deepseek:deepseek-chat`      | DeepSeek V3          |
| `r1`       | `deepseek:deepseek-reasoner`  | DeepSeek R1 推理模型 |
| `qwen`     | `alibaba:qwen-max`            | 通义千问             |
| `glm`      | `zhipu:glm-4-plus`            | 智谱 GLM             |
| `kimi`     | `moonshotai:kimi-k2.5`        | Moonshot Kimi        |

使用示例：`xc --model sonnet` 或 `xc --model deepseek` 或 `xc --model openai:gpt-4.1`

### 6.4 Provider Registry 实现

基于 AI SDK 的 `createProviderRegistry`，运行时根据可用 API Key 动态注册：

```typescript
import { zhipu } from 'zhipu-ai-provider'

import { createAlibaba } from '@ai-sdk/alibaba'
import { anthropic } from '@ai-sdk/anthropic'
import { deepseek } from '@ai-sdk/deepseek'
import { google } from '@ai-sdk/google'
import { moonshotai } from '@ai-sdk/moonshotai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { xai } from '@ai-sdk/xai'
import { createProviderRegistry } from 'ai'

export function createModelRegistry() {
  const providers: Record<string, any> = {}

  // 内置提供商 — 按环境变量动态注册
  if (process.env.ANTHROPIC_API_KEY) providers.anthropic = anthropic
  if (process.env.OPENAI_API_KEY) providers.openai = createOpenAI()
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) providers.google = google
  if (process.env.XAI_API_KEY) providers.xai = xai
  if (process.env.DEEPSEEK_API_KEY) providers.deepseek = deepseek
  if (process.env.ALIBABA_API_KEY)
    providers.alibaba = createAlibaba({
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

### 6.5 启动时的 Provider 选择

启动时按以下顺序解析要使用的模型：

1. 命令行 `--model <alias>` / `-m <alias>`（最高优先级）
2. `X_CODE_MODEL` 环境变量
3. **自动选择**：按顺序扫描环境变量里已配置的 API Key（Anthropic → OpenAI → DeepSeek → Alibaba → Google → xAI → Zhipu → Moonshot → Custom），第一个有 key 的 Provider 即为默认

如果**一个 Provider 的 API Key 都没有**，启动时直接报错并打印所有支持的环境变量名和各提供商 Key 获取地址。用户自行设置环境变量后重新启动即可。

> 交互式配置向导不在 MVP 范围内——多数用户在开发环境里设一次环境变量就够了，做一整套 Wizard 是过度工程。

**各提供商 API Key 获取地址**：

| 提供商    | 获取地址                                      |
| --------- | --------------------------------------------- |
| Anthropic | https://console.anthropic.com/                |
| OpenAI    | https://platform.openai.com/api-keys          |
| Google    | https://aistudio.google.com/apikey            |
| xAI       | https://console.x.ai/                         |
| DeepSeek  | https://platform.deepseek.com/api_keys        |
| 通义千问  | https://dashscope.console.aliyun.com/apiKey   |
| 智谱 AI   | https://open.bigmodel.cn/usercenter/apikeys   |
| Moonshot  | https://platform.moonshot.ai/console/api-keys |

### 6.6 配置来源

**所有配置都走环境变量**，没有配置文件。用户如果想固定默认模型，设置 `X_CODE_MODEL` 或每次传 `--model`；API Key 同样只读环境变量。实现见 `packages/core/src/config/index.ts` —— 注释里也明确写了 "There is no config file"。这是刻意的简化：一份数据源，不必同步 JSON / env / CLI 三处。

**完整环境变量清单**：

| 环境变量                       | 说明                                                                                       |    必填    |
| ------------------------------ | ------------------------------------------------------------------------------------------ | :--------: |
| `ANTHROPIC_API_KEY`            | Anthropic Claude API Key                                                                   |    按需    |
| `OPENAI_API_KEY`               | OpenAI GPT API Key                                                                         |    按需    |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini API Key                                                                      |    按需    |
| `XAI_API_KEY`                  | xAI Grok API Key                                                                           |    按需    |
| `DEEPSEEK_API_KEY`             | DeepSeek API Key                                                                           |    按需    |
| `ALIBABA_API_KEY`              | 通义千问 / DashScope API Key                                                               |    按需    |
| `ZHIPU_API_KEY`                | 智谱 GLM API Key                                                                           |    按需    |
| `MOONSHOT_API_KEY`             | Moonshot / Kimi API Key                                                                    |    按需    |
| `OPENAI_COMPATIBLE_API_KEY`    | 自定义 OpenAI 兼容提供商 Key                                                               |    按需    |
| `OPENAI_COMPATIBLE_BASE_URL`   | 自定义提供商 API 端点                                                                      | 与上面配套 |
| `OPENAI_COMPATIBLE_MODEL`      | 自定义提供商模型名                                                                         | 与上面配套 |
| `X_CODE_MODEL`                 | 默认使用的模型（如 `deepseek:deepseek-chat`）                                              |    可选    |
| `TAVILY_API_KEY`               | Tavily 搜索 API Key（免费 1000 次/月，https://tavily.com）                                 |    可选    |
| `BRAVE_API_KEY`                | Brave 搜索 API Key（免费 2000 次/月，Tavily 缺失时自动回退，https://api.search.brave.com） |    可选    |

> 至少需要配置 **一个** 模型提供商的 API Key 才能使用。

### 6.7 内置斜杠命令

对话中可使用以下内置命令：

| 命令            | 功能                    | 说明                                                      |
| --------------- | ----------------------- | --------------------------------------------------------- |
| `/help`         | 显示所有可用命令        |                                                           |
| `/model [name]` | 切换模型 / 查看可用模型 | `/model opus`、`/model deepseek`                          |
| `/plan`         | 进入 Plan Mode          | 只读探索 + 生成实施计划，需用户审核通过后执行（详见 4.7） |
| `/compact`      | 手动触发上下文压缩      | 不等自动阈值，立即压缩旧消息                              |
| `/usage`        | 查看 token 用量         | 本次会话的累计 token 统计（不含自动计费）                 |
| `/clear`        | 清空对话历史            | 不退出程序，重新开始新对话（保留知识上下文）              |
| `/init`         | 初始化项目              | 在项目根生成 `AGENTS.md` 模板 + 建 `.x-code/` 目录结构    |
| `/session save` | 手动保存会话摘要        | 不退出程序，保存当前进度                                  |
| `/exit`         | 退出（等同 Ctrl+C）     | 自动保存会话摘要后退出                                    |

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
    // Git Bash / MSYS2 / Cygwin set SHELL to a Unix-style path (e.g. /usr/bin/bash).
    // Prefer that shell when available so the Unix tool ecosystem works as expected.
    const shell = process.env.SHELL
    if (shell && /\b(bash|zsh)$/i.test(shell)) {
      const type: ShellType = shell.endsWith('zsh') ? 'zsh' : 'bash'
      return { executable: shell, args: ['-c'], type }
    }
    return { executable: 'powershell.exe', args: ['-NoProfile', '-Command'], type: 'powershell' }
  }
  const userShell = process.env.SHELL ?? '/bin/bash'
  const type = userShell.endsWith('zsh') ? 'zsh' : 'bash'
  return { executable: userShell, args: ['-c'], type }
}
```

#### 各层跨平台要点

| 层面              | 设计决策                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| **工具命名**      | `shell`（非 `bash`），语义上不绑定特定 shell                                                      |
| **命令执行**      | 运行时检测：Windows → 优先 Git Bash/MSYS2（如有 $SHELL），否则 PowerShell；macOS/Linux → bash/zsh |
| **System Prompt** | 注入 `{shell}` 变量，模型据此生成对应语法的命令                                                   |
| **路径处理**      | 全部用 Node.js `path` 模块（自动处理 `\` vs `/`）                                                 |
| **进程管理**      | 使用 `execa` 库（跨平台进程管理，自动处理信号/编码）                                              |
| **危险命令检测**  | PowerShell 和 bash 分别维护检测规则                                                               |
| **文件操作**      | 使用 `node:fs` API，不依赖 shell 命令                                                             |
| **沙盒**          | MVP 不实现，后续可分平台实现                                                                      |

#### 已知挑战

Gemini CLI 的跨平台经验表明以下问题需要注意：

- PowerShell 的引号规则与 bash 差异巨大（单引号/双引号/转义）
- Windows 路径中的 `\` 可能被 shell 解释为转义符
- 部分 npm 包（如 `node-pty`）在 Windows 上需要预编译二进制
- 文件权限模型（Unix `chmod 600` vs Windows ACL）不同

### 6.10 错误恢复策略

**文件**: `packages/core/src/agent/loop.ts`（集成在 Agent Loop 中）

| 错误类型               | 恢复策略                                | 说明                                  |
| ---------------------- | --------------------------------------- | ------------------------------------- |
| **API 限流 (429)**     | 指数退避重试（1s → 2s → 4s，最多 3 次） | AI SDK 内置 `maxRetries` 参数         |
| **API 认证失败 (401)** | 提示用户检查 Key，提供重新配置入口      | 不重试，直接提示                      |
| **网络超时**           | 重试 1 次，失败后提示                   | 保留当前对话状态，不丢失上下文        |
| **模型不可用 (503)**   | 提示用户切换备用模型 (`/model`)         | 如果用户配置了多个 provider，建议切换 |
| **工具执行超时**       | 返回超时提示给模型，模型决定下一步      | shell 默认 30s 超时，可通过参数调整   |
| **工具执行错误**       | 将 stderr 返回给模型，模型自主修正      | 不中断循环，让模型看到错误并调整      |
| **上下文超限**         | 触发压缩（4.2 节），压缩后继续          | 如果压缩后仍超限，提示用户开启新会话  |
| **Ctrl+C**             | 中断当前操作，保存会话摘要后退出        | 不丢弃已完成的工作                    |

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

- **`@x-code-cli/core`**：TypeScript 编译（`tsc`），输出 `packages/core/dist/`，供 cli 包引用
- **`@x-code-cli/cli`**：esbuild 打包为单文件 `packages/cli/dist/cli.js`，包含 shebang，可直接执行

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
  "dev": "pnpm -r run build && pnpm --filter @x-code-cli/cli run dev",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "eslint . --fix",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "typecheck": "tsc -b",
  "ci": "pnpm typecheck && pnpm lint && pnpm test && pnpm build",
  "release": "node scripts/release.mjs"
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

### 分发方式

本地开发：`pnpm build && node packages/cli/dist/cli.js`
全局链接：`cd packages/cli && pnpm link --global` → 使用 `x-code` 或 `xc` 命令
npm 发布：`pnpm release`（`scripts/release.mjs`，按 conventional commits 决定版本号）

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

| 模块               | 测试内容                         | 优先级 |
| ------------------ | -------------------------------- | ------ |
| `tools/read-file`  | 正常读取、行号范围、文件不存在   | P0     |
| `tools/write-file` | 正常写入、路径不存在             | P0     |
| `tools/shell`      | 命令执行、超时、stderr、流式输出 | P0     |
| `tools/glob`       | pattern 匹配                     | P1     |
| `tools/grep`       | 正则搜索、无结果                 | P1     |
| `permissions`      | 规则匹配、allow/ask/deny         | P0     |
| `agent/loop`       | mock LLM 响应，验证循环逻辑      | P1     |
| `ui/App`           | ink-testing-library 渲染测试     | P2     |

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
- [x] 跨平台支持（Windows 原生 PowerShell / macOS / Linux，不依赖 WSL）
- [x] 交互式询问（AI 可向用户提出多选题，获取偏好）
- [x] 项目知识系统（`.x-code/` 目录，手动知识 + 自动提炼 + 4 种规则加载模式）
- [x] 知识验证与淘汰（90 天 TTL + 启动校验 + 模型主动清理）
- [x] 会话记忆（自动摘要 + 跨会话延续）
- [x] `xc init` 初始化命令（在项目根生成 `AGENTS.md` 模板，建 `.x-code/` 内部目录）
- [x] 上下文压缩（token 超阈值时自动压缩旧消息，支持长对话）
- [x] Shell 流式输出（长命令实时显示进度，如 npm install）
- [x] Token 用量统计（累计输入/输出 token，`/usage` 命令查看；不做自动计费）
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
- **配置**：项目级 `.x-code/mcp.json` + 全局 `~/.x-code/mcp.json`
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

~/.x-code/skills/           # 全局 Skills（所有项目可用）
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

| 优先级 | 功能                     | 说明                                                                                                                                                                                     |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | **MCP 协议**             | 外部工具连接（GitHub、数据库、Jira 等），stdio + HTTP                                                                                                                                    |
| P1     | **Skills 系统**          | 可复用操作手册，遵循开放标准                                                                                                                                                             |
| P1     | **Subagent（子 Agent）** | 独立上下文的子 LLM 实例。内置 Explore（只读，用便宜模型搜索代码库）和 General（全工具）子 Agent，支持自定义子 Agent（YAML frontmatter），支持并行执行。通过 `task` 工具在主 Agent 中调用 |
| P1     | **任务追踪**             | todoWrite 工具，进度管理，复杂任务自动拆解为 checklist                                                                                                                                   |
| P1     | **对话历史浏览**         | `xc --resume` 继续上次会话、`/sessions` 查看历史会话列表、选择历史会话继续                                                                                                               |
| P2     | **Git 集成**             | 内置 git 操作（不依赖 shell 调用）                                                                                                                                                       |
| P2     | **图片/PDF 支持**        | 多模态输入（截图分析、文档阅读）                                                                                                                                                         |
| P2     | **浏览器自动化**         | Playwright 集成（截图、交互测试）                                                                                                                                                        |
| P3     | **插件系统**             | 第三方扩展框架                                                                                                                                                                           |
| P3     | **VSCode 扩展**          | 复用 @x-code-cli/core，IDE 内使用                                                                                                                                                        |

---

## 十、项目知识系统

**人写的和 AI 写的严格分开**,各自有独立的文件和触发机制。

| 角色     | 写入者          | 目的                           | 文件                           |
| -------- | --------------- | ------------------------------ | ------------------------------ |
| 项目说明 | 人(团队 / 用户) | 项目是什么、团队约定、业务背景 | `AGENTS.md`(项目根)            |
| 全局偏好 | 人(用户)        | 跨项目的个人偏好               | `~/.x-code/AGENTS.md`          |
| 本地覆盖 | 人(用户)        | 不提交到 git 的个人项目偏好    | `.x-code/local/preferences.md` |
| 项目记忆 | AI              | 对话中学到的项目相关事实       | `.x-code/memory/auto.md`       |
| 全局记忆 | AI              | 学到的用户相关事实(跨项目)     | `~/.x-code/memory/auto.md`     |

项目说明文件用 `AGENTS.md` 并放在**项目根**——对齐 Codex / OpenCode 的行业惯例,供应商中性,发现性高。

### 10.1 文件布局

```
项目根/
├── AGENTS.md                     ← 项目说明(人写,git 追踪)
└── .x-code/                      ← CLI 内部状态
    ├── memory/auto.md            ← AI 自动写入的记忆
    ├── sessions/*.json           ← 会话摘要
    ├── plans/*.md                ← Plan Mode 产出
    └── local/
        ├── .gitignore            ← 内容是 `*`
        └── preferences.md        ← 个人项目偏好(人写)

~/.x-code/
├── AGENTS.md                     ← 全局用户偏好(人写)
└── memory/auto.md                ← 全局自动记忆
```

> 没有配置文件。API Key 和默认模型都走环境变量(`ANTHROPIC_API_KEY` / `X_CODE_MODEL` 等),`config/index.ts` 注释里也有明确声明:"There is no config file"。

### 10.2 AGENTS.md 加载规则

**单仓**:读项目根的 `AGENTS.md`。

**Monorepo**:从当前工作目录向上遍历到 `.git` 目录(含)或文件系统根,每层都找 `AGENTS.md`,按 **root-to-leaf** 顺序拼接。子包的 AGENTS.md 排在后面,对模型权重更高,能覆盖根级约定。

示例:在 `packages/frontend/` 下启动时:

```
### Project AGENTS.md (.)                  ← 根目录(通用约定)
### Project AGENTS.md (packages/frontend)  ← 子包(React 特有约定)
```

实现:`core/src/knowledge/loader.ts::collectAgentsMdChain`。

### 10.3 AGENTS.md 模板(`/init` 生成)

```markdown
# AGENTS.md

## Overview

<!-- 项目做什么,给谁用 -->

## Tech Stack

<!-- 语言 / 框架 / 关键依赖 -->

## Commands

<!-- 常用命令(build / test / lint 等) -->

## Conventions

<!-- 非显而易见的项目约定 -->

## Business Context

<!-- 领域知识 / 业务约束 / 关键决策 -->
```

用户可自由增删 section、改格式——这个文件是用户主权的,`/init` 只在文件不存在时创建。

### 10.4 自动记忆(auto.md)

**写入机制**:AI 在对话中判断学到了值得记的事,调用 `saveKnowledge` 工具主动写入。不是后台抽取,是 AI 在当前 turn 里顺手写。

**Taxonomy(4 分类)**——按"**知识类型**"分,边界清晰、互斥:

| 类别        | 含义                                     | 典型触发                                             |
| ----------- | ---------------------------------------- | ---------------------------------------------------- |
| `user`      | 关于用户本身(角色、专长、长期约束)       | "我是十年 Go 工程师,第一次碰 React"                  |
| `feedback`  | 用户的纠正或认可(都要含原因)             | "不要 mock 数据库——上季度 mock 过测试通过但迁移炸了" |
| `project`   | 进行中的工作 / 决策 / 非代码可推导的状态 | "mobile release 冻结从 2026-03-05 开始"              |
| `reference` | 外部系统指针                             | "pipeline bug 都在 Linear 的 INGEST 项目"            |

**不该写入**(避免记忆膨胀和误导):

- 代码或配置里能直接读到的事实(AI 读 `package.json` 就知道用 React)
- Git history 里有的内容
- AGENTS.md 已经说过的
- 一次性调试解决方案

**冲突检测**:同 category + 同 key 自动替换。不是只追加。

**TTL**:90 天未更新的条目启动时自动驱逐。

**大小限制**:注入 system prompt 时取前 200 行。

**存储格式**(markdown,按 category 分组):

```markdown
## Auto Memory

### feedback

- [2026-04-18] testing-db-policy: 集成测试必须打真库。原因:Q1 migration 事故,mocked 测试通过但生产炸了
- [2026-04-18] refactor-batching: 重构倾向打成一个 PR——用户验证过减少 churn

### user

- [2026-04-18] user-stack: 十年 Go 工程师,React 新手,前端例子可类比后端概念

### project

- [2026-04-18] release-freeze: mobile release 冻结 2026-03-05 起,非 critical PR 要 flag
```

### 10.5 `saveKnowledge` 工具

```typescript
saveKnowledge({
  action: 'add' | 'delete',
  key: string, // 短唯一 slug,如 "user-role"
  fact: string, // 事实内容
  scope: 'project' | 'global',
  category: 'user' | 'feedback' | 'project' | 'reference',
})
```

`add` 同 category + 同 key 自动替换旧值。工具 description 详细告诉 AI 每类该什么时候用,system prompt 的 "Auto Memory Guidelines" 段给具体触发示例。

### 10.6 加载到 System Prompt 的完整顺序

`buildKnowledgeContext()` 按下面顺序拼接(后出现的权重更高):

```
1. Global Preferences     (~/.x-code/AGENTS.md)           人写,跨项目
2. Global Auto Memory     (~/.x-code/memory/auto.md)      AI 写,跨项目
3. Project AGENTS.md (.)                                   人写,项目根
4. Project AGENTS.md (packages/x)                          人写,monorepo 子包(如有)
5. Project Auto Memory    (.x-code/memory/auto.md)         AI 写,本项目
6. Local Preferences      (.x-code/local/preferences.md)   人写,gitignored
```

整段注入 system prompt 末尾("## Project Knowledge" 段)。

### 10.7 会话记忆(跨会话延续)

知识系统记的是长期事实(项目约定、用户偏好)。会话记忆记的是**短期工作上下文**(正在做什么、做到哪了)。

**工作机制**:

```
对话进行中 ─┐
            │  上下文压缩时 / 会话结束时 / 手动 /session save
            ▼
     自动生成会话摘要
            │
            ▼
   .x-code/sessions/{id}.json
```

**摘要结构**:

```typescript
interface SessionSummary {
  id: string
  title: string
  startedAt: string
  endedAt: string
  status: 'completed' | 'in_progress' | 'abandoned'
  summary: string
  keyResults: string[]
  pendingWork: string[]
  filesModified: string[]
  decisions: string[]
}
```

当前实现仅归档,不自动恢复。未来可以加 `/resume` 之类的命令用。

### 10.8 和竞品的位置对比

| 工具        | 项目说明文件                             | 位置   | 自动记忆                | Monorepo 向上遍历 |
| ----------- | ---------------------------------------- | ------ | ----------------------- | ----------------- |
| **X-Code**  | `AGENTS.md`                              | 项目根 | ✅ auto.md(AI 主动调用) | ✅ 向上到 `.git`  |
| Codex       | `AGENTS.md`                              | 项目根 | ✅ 后台双阶段 pipeline  | ✅ 向上到 `.git`  |
| OpenCode    | `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` | 项目根 | ❌                      | ❌ 只读 cwd       |
| Claude Code | `CLAUDE.md`                              | 项目根 | ✅ 后台 extractor       | ✅ 向上遍历       |

### 10.9 相关代码位置

| 功能                      | 文件                                | 关键函数                                                                   |
| ------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| AGENTS.md chain 加载      | `core/src/knowledge/loader.ts`      | `collectAgentsMdChain()`, `buildKnowledgeContext()`                        |
| 自动记忆管理              | `core/src/knowledge/auto-memory.ts` | `AutoMemory`, `initMemories()`, `getAutoMemory()`(project 实例按 cwd 缓存) |
| saveKnowledge 工具        | `core/src/tools/save-knowledge.ts`  | schema + AI 触发指南                                                       |
| Taxonomy 类型             | `core/src/types/index.ts`           | `KnowledgeCategory`                                                        |
| `/init` 命令              | `core/src/knowledge/init.ts`        | `initProject()`, AGENTS_TEMPLATE                                           |
| System prompt memory 指南 | `core/src/agent/system-prompt.ts`   | "Auto Memory Guidelines" 段                                                |

---

## 十一、依赖清单

### `@x-code-cli/core` dependencies

| 包                          | 版本     | 用途                                                               |
| --------------------------- | -------- | ------------------------------------------------------------------ |
| `ai`                        | ^6.0.0   | Vercel AI SDK Core + Provider Registry（latest 6.0.77）            |
| `@ai-sdk/anthropic`         | ^3.0.0   | Claude 模型接入（latest 3.0.38）                                   |
| `@ai-sdk/openai`            | ^3.0.0   | OpenAI / GPT 模型接入（latest 3.0.26）                             |
| `@ai-sdk/google`            | ^3.0.0   | Google / Gemini 模型接入（latest 3.0.22）                          |
| `@ai-sdk/xai`               | ^3.0.0   | xAI / Grok 模型接入（latest 3.0.48）                               |
| `@ai-sdk/deepseek`          | ^2.0.0   | DeepSeek 模型接入（latest 2.0.18）                                 |
| `@ai-sdk/alibaba`           | ^1.0.0   | 通义千问模型接入（latest 1.0.1）                                   |
| `@ai-sdk/moonshotai`        | ^2.0.0   | Moonshot / Kimi 模型接入（latest 2.0.3）                           |
| `@ai-sdk/openai-compatible` | ^2.0.0   | 自定义 OpenAI 兼容提供商接入（豆包、文心一言等）（latest 2.0.28）  |
| `zhipu-ai-provider`         | ^0.2.0   | 智谱 GLM 模型接入（社区包，latest 0.2.2）                          |
| `zod`                       | ^3.25.76 | 工具参数 Schema（AI SDK 6 peerDep 要求 ≥3.25.76）                  |
| `globby`                    | ^14.0.0  | glob 工具的底层依赖（latest 14.1.0）                               |
| `execa`                     | ^9.0.0   | 跨平台进程执行（latest 9.6.1）                                     |
| `@tavily/core`              | ^0.7.0   | webSearch 搜索 API（免费 1000 次/月，latest 0.7.1）                |
| `@vscode/ripgrep`           | ^1.17.0  | grep 工具底层（预编译 ripgrep 二进制，latest 1.17.0）              |
| `cheerio`                   | ^1.0.0   | webFetch HTML 解析（latest 1.2.0）                                 |
| `turndown`                  | ^7.2.0   | webFetch HTML→Markdown 转换（latest 7.2.2）                        |
| `diff`                      | ^8.0.0   | Permission 组件 diff 预览（edit/writeFile 变更对比，latest 8.0.3） |
| `chalk`                     | ^5.4.0   | 颜色输出（latest 5.6.2）                                           |

### `@x-code-cli/cli` dependencies

| 包                 | 版本                      | 用途                                                                                                                   |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@x-code-cli/core` | workspace:\*              | Agent 逻辑层                                                                                                           |
| `ink`              | `npm:@jrichman/ink@6.6.9` | Google/Gemini CLI 维护的 Ink fork（npm alias），自带 cell-level buffer / StyledLine / DEC 2026 同步更新，消除 CJK 抖动 |
| `react`            | ^19.1.0                   | Ink 的 peer dependency                                                                                                 |
| `yargs`            | ^18.0.0                   | CLI 参数解析                                                                                                           |
| `chalk`            | ^5.4.0                    | ANSI 颜色（启动提示、header 输出）                                                                                     |
| `marked`           | ^17.0.0                   | streaming markdown lexer → ANSI 渲染                                                                                   |
| `diff`             | ^8.0.0                    | Permission 组件 diff 预览                                                                                              |

### 根包 devDependencies（共享）

| 包                                        | 版本    | 用途                                                 |
| ----------------------------------------- | ------- | ---------------------------------------------------- |
| `typescript`                              | ^5.7.0  | 类型检查（latest 5.9.3）                             |
| `esbuild`                                 | ^0.27.0 | 构建打包（0.x 下 ^ 只覆盖同 minor）                  |
| `vitest`                                  | ^4.0.0  | 测试框架                                             |
| `eslint`                                  | ^10.0.0 | 代码检查（flat config）                              |
| `typescript-eslint`                       | ^8.0.0  | ESLint TypeScript 支持                               |
| `eslint-plugin-react-hooks`               | ^7.0.0  | React Hooks 规则                                     |
| `eslint-plugin-unused-imports`            | ^4.4.1  | 自动移除未使用 import                                |
| `prettier`                                | ^3.0.0  | 代码格式化                                           |
| `@trivago/prettier-plugin-sort-imports`   | ^6.0.0  | import 排序                                          |
| `husky`                                   | ^9.0.0  | Git hooks                                            |
| `lint-staged`                             | ^16.0.0 | 只对暂存文件运行 lint/format                         |
| `@commitlint/cli` + `config-conventional` | ^20.0.0 | conventional commits 校验（commit-msg hook）         |
| `tsx`                                     | ^4.21.0 | `pnpm dev` 入口（直接跑 TS 无需先 build）            |
| `@types/react`                            | ^19.0.0 | React 类型                                           |
| `@types/node`                             | ^22.0.0 | Node.js 类型（target Node 20）                       |
| `@types/yargs`                            | ^17.0.0 | yargs 类型（yargs 18 暂无 @types/yargs@18，沿用 17） |
| `ink-testing-library`                     | ^4.0.0  | Ink 组件测试（保留依赖，尚未写 cli 侧测试）          |

---

## 十二、代码质量工具链

### ESLint（flat config）

**文件**: `eslint.config.mjs`

使用 ESLint 10 flat config 格式，主要规则集：

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
  "importOrder": ["^node:", "^react", "^ink", "^(ai|@ai-sdk)", "^zod", "^@x-code-cli/", "^[./]"],
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

## 十三、实现状态

当前已落地的功能。下面的清单以源码为准——任何被移除或后续重写的设计细节都不在这里出现。

### 13.1 基础设施 & 构建

- ✅ pnpm monorepo（`packages/core` + `packages/cli`）+ 共享 TypeScript 项目引用
- ✅ ESLint + Prettier + Husky + lint-staged
- ✅ esbuild 单文件打包（`packages/cli/esbuild.config.js`）
- ✅ Vitest 测试套件（75+ tests，9 test files）

### 13.2 CLI 入口 & 启动

- ✅ `packages/cli/src/index.ts`：Node 版本检查 + `.env` 自动加载 + yargs 参数解析（`--model` / `--trust` / `--print` / `--max-turns` / `--version`）+ 未配 WebSearch API Key 时启动提示
- ✅ `packages/cli/src/app.tsx`：Ink render 入口 + `startApp()` / `getCleanupFn()`
- ✅ `AppHeader.printHeader()`：ASCII Logo + 版本 + 模型信息（Ink 外直写 stdout）
- ✅ `gracefulShutdown()` + `resetTerminal()`：Ctrl+C 秒退（<10 ms），cleanup 跑为 fire-and-forget；退出时**不**打 token 统计（对齐 claude-code/gemini-cli/opencode）

### 13.3 多 Provider 支持

- ✅ 8 家内置 Provider：Anthropic / OpenAI / Google / xAI / DeepSeek / Alibaba / Moonshot / Zhipu
- ✅ OpenAI 兼容接口（自定义 provider via base URL）
- ✅ 模型别名映射 + 智能默认选择 + 启动时检测可用 Provider
- ✅ 运行时 `/model` 切换命令

### 13.4 Agent Loop

- ✅ `agentLoop()`：streamText + 工具调用 + while 循环（拆为 `runTurn` / `streamChunksToUI` / `collectTurnResponse` / `handleContextTooLong` / `checkAndCompressContext` 等聚焦函数）
- ✅ `processToolCalls()`（`tool-execution.ts`）：顺序执行、权限检查、结果收集
- ✅ 上下文压缩（token 超阈值时 `compressMessages()` 生成摘要替换旧消息）
- ✅ Token 用量统计（累计 input/output token，不做自动计费——汇率和价格会变，内置单价表很快过时）
- ✅ 错误分类 `classifyApiError()`（`api-errors.ts`：401/403/429/503/timeout + 上下文超限集中检测）+ 非可重试错误 break
- ✅ 最大轮次限制（`--max-turns`）+ AbortController（Ctrl+C 中断）
- ✅ `extractLastAssistantText()` 安全网：某些推理模型把全部文本放在 response.messages 最后 part 的兜底
- ✅ `maxOutputTokens: 32000` 显式设置（覆盖 Anthropic 4096 默认）+ `finishReason === 'length'` 自动续写（push "continue" 提示,最多 3 次,成功 tool 轮次 reset 计数）
- ✅ `finishReason === 'content-filter'` 明确报错(不再静默)

### 13.5 工具（13 个）

- ✅ `readFile` / `writeFile` / `edit` / `listDir` / `glob` / `grep`（跨平台，ripgrep 基础）
- ✅ `shell`：execa + 跨平台（Windows PowerShell / Unix bash/zsh）+ 流式输出 + 智能权限分级
- ✅ `webSearch`：Tavily 优先 + Brave 兜底（`@tavily/core` SDK + Brave 直连 fetch），工具描述注入当前年份；都缺失时返回平台化配置引导
- ✅ `webFetch`：HTTP + cheerio + turndown，100 KB 上限，50 条 / 15 min LRU 缓存，Cloudflare bot-challenge 降级重试
- ✅ `askUser`：配合 `<SelectOptions>` UI
- ✅ `saveKnowledge`：模型驱动知识提炼
- ✅ `enterPlanMode` / `exitPlanMode`
- ✅ 全局 `truncateToolResult()`（30 KB 上限，头尾各半保留）

### 13.6 权限系统

- ✅ 三级 `PermissionLevel`: `always-allow` / `ask` / `deny`
- ✅ Shell 命令智能分级：拆分 `&&` / `||` / `;` 链式命令后分别判定；`isReadOnly` 放行，`isDestructive` 拒绝，混合 → `ask`
- ✅ `--trust` 模式跳过所有 `ask` 确认
- ✅ `Permission` 组件带 diff 预览（edit / writeFile）

### 13.7 知识系统

- ✅ 分层知识加载（全局 `~/.x-code/` / 项目 `.x-code/` / 本地 `.x-code/local/preferences.md`）
- ✅ `AutoMemory` 类（key-based CRUD + 冲突检测 + 90 天 TTL 淘汰）
- ✅ `/init` 命令在项目根生成 `AGENTS.md` 模板 + `.x-code/` 内部目录结构
- ✅ AGENTS.md chain（从 cwd 向上到 `.git`，沿路径收集所有 AGENTS.md，root-to-leaf 拼接，monorepo 子包可覆盖根约定）
- ✅ 会话持久化（`saveSession` + `saveSessionSummary`；上下文压缩时同步写一次；Ctrl+C 退出路径为 fire-and-forget，可能来不及保存最后一次摘要 —— 这是为了 exit 秒退的明确取舍）；**启动时不自动恢复**，预留给后续 history 功能

### 13.8 UI & 渲染管线

- ✅ `@jrichman/ink@6.6.9` fork（Google 维护 / Gemini CLI 生产版）+ React 19
- ✅ `useAgent` hook 管理 AgentState（messages / isLoading / currentToolCall / shellOutput / permissionQueue / pendingQuestion / usage / error / **streamingText**）
- ✅ streaming 文本**进 state**：`useStreamBuffer(appendMessage, setStreamingText)` 每 delta 更新，`\n\n` 段落边界 flush 到 messages，MAX_STREAMING_LINES=12 兜底
- ✅ `<ChatInput>` 独占底部区域：cell-level 2D diff 渲染，`process.stdout.write` 直写 stdout
  - 包揽：滚动历史提交 + spinner + streamingText（`renderMarkdown` + `ansiStringToCells`）+ permission 对话框 + error 行 + 输入框 + 补全菜单
  - 所有写操作包在 DEC 2026 `\x1b[?2026h`/`\x1b[?2026l` 同步更新块里，原子渲染
- ✅ `stdout-writer.ts`：user/assistant/tool 格式化 + ANSI + `\r\n → \n` 归一化
- ✅ `usePromptInput`：自定义 stdin 处理，bracketed paste + 30ms debounce 双路径，paste 占位符，多行 textarea + 10 行硬顶（`MAX_VISIBLE_LINES`）
- ✅ `paste-refs.ts`：`[Pasted text #N +M lines]` 占位符 + expand 辅助
- ✅ `renderMarkdown`（marked.lexer + chalk）Markdown → ANSI
- ✅ `SelectOptions`：askUser 多选（含自由文本 Other 模式，唯一仍走 Ink 渲染的动态组件）
- ✅ 可选诊断 log（`DEBUG_STDOUT=1` → `<cwd>/stdout-debug.log`）

### 13.9 斜杠命令

- ✅ `/help` / `/model` / `/usage` / `/clear` / `/compact` / `/init` / `/session save` / `/plan` / `/exit`
- ✅ Tab 补全（模糊匹配）

### 13.10 Plan Mode

- ✅ `enterPlanMode` / `exitPlanMode` 工具
- ✅ System prompt overlay（Plan 模式下禁用所有写入工具）
- ✅ 计划文件管理（`.x-code/plans/` 目录 + 自动生成的 plan ID）

### 13.11 非交互模式 & CI 集成

- ✅ `--print` / 管道输入（stdin 检测）
- ✅ Ctrl+C 优雅退出（保存会话摘要）

### 13.12 未实现 / 后续功能

参考 `docs/tools-comparison.md` 第 12 节优化路线图——剩余 P0/P1/P2 改进项（先读后写检查、结构化错误类型、Grep 分页、webSearch 丰富入参、Brave 多后端 fallback 等）均在其中。

---

## 十四、参考项目

| 项目            | 参考价值                                                      | 链接                                                                               |
| --------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Gemini CLI**  | 技术栈完全一致（TS + esbuild + Ink + Vitest），架构最值得参考 | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |
| **AI SDK 文档** | streamText / tool 调用 / Agent Loop 的权威参考                | [ai-sdk.dev/docs](https://ai-sdk.dev/docs)                                         |
| **Ink 文档**    | 组件 API、hooks、`useStdout` 等                               | [github.com/vadimdemedes/ink](https://github.com/vadimdemedes/ink)                 |
