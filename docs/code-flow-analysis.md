# X-Code CLI 完整代码流程分析

本文档详细分析 X-Code CLI 从启动到用户提问、再到 AI 回复并在终端显示的完整代码执行流程。

---

## 目录

- [架构概览](#架构概览)
- [完整时序图](#完整时序图)
- [阶段一：CLI 启动](#阶段一cli-启动)
- [阶段二：UI 渲染初始化](#阶段二ui-渲染初始化)
- [阶段三：用户输入处理](#阶段三用户输入处理)
- [阶段四：Agent 循环执行](#阶段四agent-循环执行)
- [阶段五：AI 流式响应与工具调用](#阶段五ai-流式响应与工具调用)
- [阶段六：终端 UI 渲染](#阶段六终端-ui-渲染)
- [阶段七：退出与清理](#阶段七退出与清理)
- [具体示例：用户问"帮忙分析一下项目产品功能以及优化点"](#具体示例)

---

## 架构概览

X-Code CLI 由两个核心包组成：

```
packages/
  cli/     @x-code-cli/cli   — 终端 UI 层 (Ink/React)
  core/    @x-code-cli/core  — Agent 核心逻辑 (AI SDK + Tools)
```

**分层架构：**

```
+--------------------------------------------------+
|                   CLI 层 (cli/)                    |
|  index.ts → app.tsx → App.tsx (Ink React 组件)     |
|  ChatInput / MessageList / StreamingText / ...     |
+--------------------------------------------------+
|               Hook 桥接层 (use-agent.ts)           |
|  React State ←→ AgentCallbacks ←→ Core Agent Loop  |
+--------------------------------------------------+
|                  Core 层 (core/)                   |
|  agentLoop() → streamText() → Tool 执行            |
|  Knowledge / Session / Permission / Pricing        |
+--------------------------------------------------+
|               AI SDK + Provider 层                 |
|  Anthropic / OpenAI / Google / DeepSeek / ...      |
+--------------------------------------------------+
```

---

## 完整时序图

```
用户            CLI入口          Ink/React UI        useAgent Hook       agentLoop (Core)       AI Provider       Tool Registry
 |                |                  |                    |                    |                    |                  |
 |  xc 命令启动    |                  |                    |                    |                    |                  |
 |--------------->|                  |                    |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                | 1. checkNodeVersion()                 |                    |                    |                  |
 |                | 2. loadEnvFile()                      |                    |                    |                  |
 |                | 3. yargs 解析参数                      |                    |                    |                  |
 |                | 4. loadConfig()                       |                    |                    |                  |
 |                | 5. resolveModelId()                   |                    |                    |                  |
 |                | 6. createModelRegistry()              |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                | 7. printHeader() — 直接写 stdout       |                    |                    |                  |
 |  <ASCII Logo>  |<-----------------------------------------                  |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                | 8. startApp()    |                    |                    |                    |                  |
 |                |----------------->|                    |                    |                    |                  |
 |                |     render(<App>)|                    |                    |                    |                  |
 |                |                  | 9. useAgent() 初始化                    |                    |                  |
 |                |                  |---> 状态初始化      |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  | 10. 检查 latestSession                  |                    |                  |
 |                |                  |    (有则显示继续提示)  |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |  > 输入提示符   |                  | <ChatInput> 渲染    |                    |                    |                  |
 |<------------------------------------                  |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |  用户输入问题   |                  |                    |                    |                    |                  |
 |------------------------------------->                  |                    |                    |                  |
 |                |                  | 11. handleSubmit() |                    |                    |                  |
 |                |                  |---> submit(text)   |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |    12. initialize() (首次)              |                    |                  |
 |                |                  |    | initMemories()                     |                    |                  |
 |                |                  |    | scanProject()                      |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |    13. setState → isLoading=true        |                    |                  |
 |                |                  |    14. 添加 user message 到 messages    |                    |                  |
 |  <Spinner>     |<------------------------------------                      |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |    15. 创建 callbacks                   |                    |                  |
 |                |                  |    16. agentLoop() |                    |                    |                  |
 |                |                  |    |--------------->                    |                    |                  |
 |                |                  |                    | 17. loadRuleFiles()|                    |                  |
 |                |                  |                    | 18. buildKnowledgeContext()             |                  |
 |                |                  |                    | 19. buildSystemPrompt()                 |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | 20. streamText()   |                    |                  |
 |                |                  |                    |------------------->|                    |                  |
 |                |                  |                    |                    | API 请求            |                  |
 |                |                  |                    |                    |------------------->|                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | 21. 流式接收 chunks |                    |                  |
 |                |                  |                    |<-------------------|                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | text-delta →       |                    |                  |
 |                |                  |                    | callbacks.onTextDelta()                 |                  |
 |                |                  |                    |---> streamingBuffer                     |                  |
 |                |                  |  (每50ms flush)     |                    |                    |                  |
 |  <StreamingText>|<------- setState(streamingText)      |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | tool-call →        |                    |                  |
 |                |                  |                    | callbacks.onToolCall()                  |                  |
 |  <ToolCall>    |<------- setState(currentToolCall)     |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | 22. finishReason=tool-calls             |                  |
 |                |                  |                    | 23. handleToolCalls()                   |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    |    权限检查 (write tools)                |                  |
 |                |                  |    onAskPermission |<---                |                    |                  |
 |  <Permission>  |<------- setState(pendingPermission)   |                    |                    |                  |
 |  用户按 y/n     |------------------------------------->|                    |                    |                  |
 |                |                  |    resolve(bool)   |--->                |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    |    工具执行          |                    |                  |
 |                |                  |                    |------------------------------------------->|              |
 |                |                  |                    |    工具结果          |                    |<--------------|
 |                |                  |                    |<-------------------------------------------|              |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | 24. pushToolResult()                    |                  |
 |                |                  |                    | 25. 继续 while 循环 → 下一轮 streamText()                   |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | ... (可能多轮工具调用)                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | 26. finishReason=stop (最终文本回复)      |                  |
 |                |                  |                    |<--- return state   |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |    27. stopStreamingFlush()             |                    |                  |
 |                |                  |    28. 将 streamingText 转为 assistant message               |                  |
 |                |                  |    29. setState → isLoading=false       |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |  <MessageList> |<------- Static 渲染完整回复            |                    |                    |                  |
 |  > 输入提示符   |<------- <ChatInput> 重新可用          |                    |                    |                  |
 |                |                  |                    |                    |                    |                  |
```

---

## 阶段一：CLI 启动

**入口文件：** `cli/src/index.ts` → `main()`

### 步骤 1: Node 版本检查

```
main()
  └─ checkNodeVersion()    // 要求 Node >= 20.19.0，不满足则 process.exit(1)
```

### 步骤 2: 加载环境变量

```
main()
  └─ loadEnvFile()         // 从 cwd 向上查找 .env 文件
       └─ process.loadEnvFile(envPath)  // 原生加载 .env
```

### 步骤 3: 解析 CLI 参数

```
main()
  └─ yargs(hideBin(process.argv))
       --model / -m    模型选择 (如 sonnet, deepseek, openai:gpt-4.1)
       --trust / -t    信任模式 (跳过写操作确认)
       --print / -p    非交互模式 (输出结果后退出)
       --max-turns     最大 Agent 循环轮数 (默认 100)
       --version / -v  显示版本
```

### 步骤 4: 配置与模型解析

```
main()
  ├─ loadConfig()                  // 读取 ~/.xcode/config.json
  ├─ getAvailableProviders()       // 检测哪些 Provider 有 API Key
  ├─ resolveModelId(argv.model, config)
  │    ├─ 优先级: --model 参数 > X_CODE_MODEL 环境变量 > config.json > 自动检测
  │    └─ MODEL_ALIASES 映射: "sonnet" → "anthropic:claude-sonnet-4-5" 等
  └─ createModelRegistry()         // 创建 AI SDK Provider Registry
       └─ 注册所有有 API Key 的 Provider (Anthropic/OpenAI/Google/DeepSeek/...)
```

**模型别名映射表（定义在 `core/src/types/index.ts`）：**

| 别名     | 完整 Model ID               |
| -------- | --------------------------- |
| sonnet   | anthropic:claude-sonnet-4-5 |
| opus     | anthropic:claude-opus-4-6   |
| haiku    | anthropic:claude-haiku-4-5  |
| gpt4     | openai:gpt-4.1              |
| deepseek | deepseek:deepseek-chat      |
| ...      | ...                         |

**Provider 检测顺序：** Anthropic → OpenAI → Google → DeepSeek → xAI → Alibaba → Zhipu → Moonshot → Custom

### 步骤 5: 构建启动参数

```typescript
const options: AgentOptions = {
  modelId, // 如 "anthropic:claude-sonnet-4-5"
  trustMode: false, // 默认需要确认写操作
  printMode: false, // 默认交互模式
  maxTurns: 100, // 最大 Agent 循环轮数
}
```

---

## 阶段二：UI 渲染初始化

**入口文件：** `cli/src/app.tsx` → `startApp()`

### 步骤 6: 打印启动 Banner

```
startApp()
  └─ printHeader(modelId)    // 直接 process.stdout.write，在 Ink 启动前执行
       ├─ 根据终端宽度选择 Logo (>= 52列: 大Logo, >= 30列: 紧凑, 否则: 文字)
       └─ 输出: Logo + 版本 + 模型名 + 帮助提示
```

**终端显示效果：**

```
  ██╗  ██╗       ██████╗ ██████╗ ██████╗ ███████╗
  ╚██╗██╔╝      ██╔════╝██╔═══██╗██╔══██╗██╔════╝
   ╚███╔╝ █████╗██║     ██║   ██║██║  ██║█████╗
   ██╔██╗ ╚════╝██║     ██║   ██║██║  ██║██╔══╝
  ██╔╝ ██╗      ╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═╝  ╚═╝       ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
 v0.1.3 │ anthropic / claude-sonnet-4-5
 Type /help for commands, Ctrl+C to abort
```

### 步骤 7: Ink React 应用渲染

```
startApp()
  └─ render(<App model={model} options={options} ... />)
       └─ App 组件初始化
            ├─ useAgent(model, options)      // 核心 Hook，管理所有 Agent 状态
            │    └─ useState<AgentState>()   // 初始状态 (见下方)
            ├─ useEffect → onCleanupReady    // 注册 SIGINT 清理函数
            ├─ useEffect → onUsageUpdate     // 同步 token 用量到全局 ref
            └─ useEffect → initialPrompt     // 如有 CLI 传入 prompt，自动提交
```

**初始 AgentState：**

```typescript
{
  messages: [],                    // 对话历史
  streamingText: '',               // 当前流式文本
  isLoading: false,                // 加载状态
  currentToolCall: null,           // 当前工具调用
  shellOutput: '',                 // Shell 输出
  pendingPermission: null,         // 待确认权限
  pendingQuestion: null,           // 待回答问题
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0, costCurrency: 'USD' },
  error: null,                     // 错误信息
  latestSession: null,             // 上次会话
}
```

### 步骤 8: 初始 UI 渲染

App 组件的 JSX 结构决定了终端显示布局：

```
<Box flexDirection="column" padding={1}>
  {/* 1. 上次会话继续提示 (如有) */}
  {state.latestSession && <SessionContinuePrompt />}

  {/* 2. 消息历史 — Ink Static，写入滚动缓冲区，不重绘 */}
  <MessageList messages={state.messages} />

  {/* 3. 当前流式文本 — 动态区域，只显示末尾 N 行 */}
  {state.streamingText && <StreamingText text={state.streamingText} />}

  {/* 4. 当前工具调用显示 */}
  {state.currentToolCall && <ToolCall ... />}

  {/* 5. Shell 输出 */}
  {state.shellOutput && <ShellOutput output={state.shellOutput} />}

  {/* 6. 权限确认对话框 */}
  {state.pendingPermission && <Permission ... />}

  {/* 7. 用户选择对话框 */}
  {state.pendingQuestion && <SelectOptions ... />}

  {/* 8. 加载 Spinner */}
  {state.isLoading && !state.streamingText && !state.currentToolCall && <Spinner />}

  {/* 9. 错误信息 */}
  {state.error && <Text color="red">Error: {state.error}</Text>}

  {/* 10. 输入框 — 非加载时显示 */}
  {!state.latestSession && <ChatInput onSubmit={handleSubmit} ... />}
</Box>
```

---

## 阶段三：用户输入处理

**组件：** `cli/src/ui/components/ChatInput.tsx`

### 输入交互流程

```
ChatInput 组件
  └─ useInput((input, key) => { ... })
       ├─ 普通字符 → setText(text + input)
       ├─ Backspace → setText(text.slice(0, -1))
       ├─ Tab → 补全斜杠命令 (如 /he → /help)
       ├─ 上/下箭头 → 切换补全候选项
       └─ Enter → onSubmit(text), setText('')
```

**斜杠命令补全：**

- 用户输入 `/` 时，显示所有命令列表
- 模糊匹配：输入 `/m` 匹配 `/model`
- Tab 键接受补全

**终端显示：**

```
> /█                          ← 用户正在输入
  /help            Show this help message
  /model           Switch model or list available models
  /usage           Show token usage and cost
  /clear           Clear conversation history
  ...
```

### 提交处理

**组件：** `cli/src/ui/components/App.tsx` → `handleSubmit()`

```
handleSubmit(text)
  ├─ 以 / 开头 → 斜杠命令处理
  │    ├─ /help    → addInfoMessage(HELP_TEXT)
  │    ├─ /model   → handleModelSwitch()
  │    ├─ /usage   → handleUsage()
  │    ├─ /clear   → clear()
  │    ├─ /compact → compact() → compressMessages()
  │    ├─ /init    → initProject()
  │    ├─ /session save → saveCurrentSession()
  │    ├─ /plan    → submit('Please enter plan mode...')
  │    └─ /exit    → cleanup() → exit()
  │
  └─ 普通文本 → submit(text)   // 进入 Agent 流程
```

---

## 阶段四：Agent 循环执行

**Hook：** `cli/src/ui/hooks/use-agent.ts` → `submit()`
**Core：** `core/src/agent/loop.ts` → `agentLoop()`

### 步骤 9: useAgent.submit() — 准备阶段

```
submit(text)
  │
  ├─ 1. initialize() (仅首次调用)
  │    ├─ initMemories()          // 加载全局 + 项目 AutoMemory
  │    │    ├─ globalMemory.load()   // ~/.xcode/memory/auto.md
  │    │    ├─ projectMemory.load()  // .x-code/memory/auto.md
  │    │    ├─ globalMemory.evict(90)   // 清除 90 天前的记忆
  │    │    └─ projectMemory.evict(90)
  │    │
  │    ├─ scanProject(cwd)        // 扫描项目基本信息
  │    │    ├─ 检测包管理器 (pnpm/yarn/npm lock 文件)
  │    │    ├─ 读取 package.json → 记录 scripts, deps
  │    │    └─ 读取 tsconfig.json → 记录 strict mode, module 等
  │    │
  │    └─ loadLatestSession()     // 读取 .x-code/sessions/latest.json
  │         └─ 如有未完成会话 → setState({ latestSession })
  │
  ├─ 2. 更新 UI 状态
  │    setState({
  │      isLoading: true,
  │      messages: [...prev.messages, { role: 'user', content: text }],
  │      streamingText: '',
  │      error: null,
  │    })
  │
  ├─ 3. 创建 AbortController (用于 Ctrl+C 取消)
  │
  ├─ 4. 启动流式文本刷新定时器 (每 50ms flush buffer → setState)
  │
  ├─ 5. 构建 AgentCallbacks (React State ←→ Core Agent 桥接)
  │    {
  │      onTextDelta:       delta → streamingBuffer 累积
  │      onToolCall:        (name, input) → setState({ currentToolCall })
  │      onToolResult:      (id, result) → setState({ currentToolCall: null })
  │      onAskPermission:   (toolCall) → new Promise → setState({ pendingPermission })
  │      onAskUser:         (question, opts) → new Promise → setState({ pendingQuestion })
  │      onShellOutput:     chunk → setState(shellOutput += chunk)
  │      onUsageUpdate:     usage → setState({ usage })
  │      onContextCompressed: () → (可选通知)
  │      onError:           error → setState({ error })
  │    }
  │
  └─ 6. 调用 agentLoop(text, model, options, callbacks, existingState)
```

### 步骤 10: agentLoop() — 核心循环

```
agentLoop(userMessage, model, options, callbacks, existingState)
  │
  ├─ 1. 初始化或复用 LoopState
  │    {
  │      messages: [],            // AI SDK ModelMessage 数组
  │      tokenUsage: {...},       // Token 用量统计
  │      planMode: false,         // 计划模式标志
  │      sessionId: '...',        // 会话 ID
  │      filesModified: Set<>,    // 已修改文件集合
  │      turnCount: 0,            // 循环轮次
  │    }
  │
  ├─ 2. state.messages.push({ role: 'user', content: userMessage })
  │
  ├─ 3. 加载知识上下文
  │    ├─ loadRuleFiles()         // .x-code/rules/*.md
  │    ├─ 解析 @rule-name 引用    // 用户消息中的 @xxx 引用
  │    ├─ loadLatestSession()     // 上次会话摘要
  │    └─ buildKnowledgeContext() // 组装完整知识上下文
  │         ├─ 全局偏好      ~/.xcode/knowledge.md
  │         ├─ 全局自动记忆  ~/.xcode/memory/auto.md
  │         ├─ 项目知识      .x-code/knowledge.md
  │         ├─ 项目自动记忆  .x-code/memory/auto.md
  │         ├─ 本地偏好      .x-code/local/preferences.md
  │         ├─ 规则 (alwaysApply=true 的自动加载)
  │         ├─ 规则 (paths 匹配的自动加载)
  │         ├─ 可用规则列表 (供 AI 按需引用)
  │         └─ 上次会话上下文
  │
  ├─ 4. 计算 Token 预算
  │    getTokenBudget(modelId)
  │    └─ contextWindow * 0.8
  │       (如 anthropic 200k * 0.8 = 160k)
  │
  └─ 5. while (turnCount < maxTurns) 主循环
       │
       ├─ turnCount++
       │
       ├─ Token 压缩检查
       │    if (estimateTokens(messages) > tokenBudget)
       │      ├─ generateSessionSummary() → saveSessionSummary()
       │      └─ compressMessages()
       │           ├─ 保留最近 6 条消息
       │           ├─ 对旧消息调用 AI 生成摘要
       │           └─ 替换为 [Previous conversation summary]
       │
       ├─ 构建 System Prompt
       │    buildSystemPrompt({
       │      knowledgeContext,    // 知识上下文
       │      planMode,           // 是否计划模式
       │      modelId,            // 模型标识
       │    })
       │
       ├─ 调用 AI (streamText)
       │    streamText({
       │      model,              // AI SDK LanguageModel
       │      system: systemPrompt,
       │      messages: state.messages,
       │      tools: toolRegistry, // 13 个工具定义
       │      maxRetries: 3,
       │      abortSignal,
       │    })
       │
       ├─ 流式处理 (for await chunk of fullStream)
       │    ├─ text-delta  → callbacks.onTextDelta(text)
       │    ├─ tool-call   → callbacks.onToolCall(name, input)
       │    └─ tool-result → callbacks.onToolResult(id, truncated)
       │
       ├─ 收集响应
       │    ├─ response.messages → push 到 state.messages
       │    ├─ usage → 累加 token 用量 + estimateCost()
       │    └─ finishReason → 决定是否继续循环
       │
       ├─ if finishReason === 'tool-calls'
       │    └─ handleToolCalls() → continue (下一轮循环)
       │
       └─ else (finishReason === 'stop')
            └─ break (退出循环，AI 完成回复)
```

---

## 阶段五：AI 流式响应与工具调用

### System Prompt 结构

```
buildSystemPrompt()
  生成的 System Prompt 包含:

  1. 身份与能力描述
     "You are X-Code, an AI coding assistant running in the user's terminal..."
     "You are powered by {model}"

  2. 工具列表与使用说明
     readFile, writeFile, edit, shell, glob, grep, listDir,
     webSearch, webFetch, askUser, saveKnowledge,
     enterPlanMode, exitPlanMode

  3. 行为规则
     - 文件操作规则 (先读后改, 优先 edit)
     - 命令执行规则 (平台兼容, 禁止破坏性命令)
     - 交互规则 (不确定时 askUser)
     - 安全规则 (不输出密钥)
     - 格式规则 (禁止 emoji, 用用户语言回复)

  4. Auto Memory 指导
     何时调用 saveKnowledge

  5. 环境信息
     Platform: win32 | darwin | linux
     Shell: bash | powershell | cmd
     Working Directory: /path/to/project

  6. [可选] Plan Mode 提示
     "Plan mode is active. You MUST NOT make any edits..."

  7. [可选] 知识上下文 (buildKnowledgeContext 的输出)
     ### Global Preferences
     ### Global Auto Memory
     ### Project Knowledge
     ### Project Auto Memory
     ### Local Preferences
     ### Rule: xxx
     ### Available Rules
     ### Previous Session
```

### 工具注册表

```
toolRegistry (core/src/tools/index.ts)
  ├─ readFile       读取文件内容 (带行号)          — 自动允许
  ├─ writeFile      创建/覆盖文件                  — 需要确认
  ├─ edit           字符串替换编辑文件              — 需要确认
  ├─ shell          执行 Shell 命令                — 只读自动允许/写入需确认/破坏性拒绝
  ├─ glob           按模式查找文件                  — 自动允许
  ├─ grep           按正则搜索文件内容              — 自动允许
  ├─ listDir        列出目录内容                    — 自动允许
  ├─ webSearch      网络搜索 (Tavily)              — 自动允许
  ├─ webFetch       获取网页内容                    — 自动允许
  ├─ askUser        向用户提问                      — 自动允许
  ├─ saveKnowledge  保存知识到持久化记忆             — 自动允许
  ├─ enterPlanMode  进入计划模式                    — 自动允许
  └─ exitPlanMode   退出计划模式                    — 自动允许
```

### 工具调用处理流程

```
handleToolCalls(toolCalls, state, options, callbacks)
  │
  for each toolCall:
  │
  ├─ enterPlanMode
  │    → state.planMode = true, generatePlanId()
  │
  ├─ exitPlanMode
  │    → state.planMode = false, 读取计划文件内容
  │
  ├─ askUser
  │    → callbacks.onAskUser(question, options)
  │    → UI 显示 SelectOptions 组件
  │    → 用户选择后 resolve(answer)
  │
  ├─ writeFile / edit / shell (写入工具)
  │    → checkPermission(toolCall, trustMode, onAskPermission)
  │         ├─ getPermissionLevel(toolName, input)
  │         │    ├─ 'always-allow' → 自动通过
  │         │    ├─ 'deny' → 拒绝 (破坏性命令)
  │         │    └─ 'ask' → 询问用户
  │         │
  │         ├─ trustMode → 自动通过所有
  │         │
  │         └─ onAskPermission → UI 显示 Permission 组件
  │              → 用户按 y/n → resolve(bool)
  │
  ├─ writeFile 执行
  │    → fs.mkdir + fs.writeFile
  │    → state.filesModified.add(filePath)
  │
  ├─ edit 执行
  │    → fs.readFile → 检查 oldString 唯一性 → string.replace → fs.writeFile
  │
  ├─ shell 执行
  │    → execa(shell, ['-c', command], { timeout })
  │    → stdout/stderr → callbacks.onShellOutput (实时流式输出)
  │
  └─ readFile/glob/grep/listDir/webSearch/webFetch
       → AI SDK 自动执行 (tool 定义了 execute 函数)
       → 结果超过 30000 字符时自动截断 (头尾各保留一半)
```

### 权限系统详解

```
三级权限模型 (core/src/permissions/index.ts):

PermissionLevel:
  'always-allow'  — 自动通过，无需用户确认
  'ask'           — 需要用户 y/n 确认
  'deny'          — 直接拒绝

Shell 命令智能分级:
  ├─ splitShellCommands(cmd) — 拆分 && / || / ; 链式命令
  ├─ isReadOnly(cmd)        — 检测只读命令 (ls, cat, git status, ...)
  ├─ isDestructive(cmd)     — 检测破坏性命令 (rm -rf, format, drop, ...)
  └─ 混合命令 → 'ask'

Trust Mode (--trust / -t):
  └─ 跳过所有 'ask' 级别确认，直接执行
```

**终端权限确认显示：**

```
╭──────────────────────────────────────────╮
│ X-Code wants to edit a file              │
│   src/index.ts                           │
│   - const old = 'value'                  │
│   + const new = 'updated'                │
│ Allow? (y)es / (n)o                      │
╰──────────────────────────────────────────╯
```

---

## 阶段六：终端 UI 渲染

### 渲染架构

X-Code CLI 使用 Ink (React for CLI) 渲染终端 UI，分为两个区域：

```
┌─────────────────────────────────────────┐
│  Static 区域 (Ink <Static>)              │  ← 写入终端滚动缓冲区，不重绘
│  - 启动 Banner (printHeader, Ink 外)     │
│  - 历史消息 (MessageList)                │
│    - 用户消息: "> 问题内容"               │
│    - AI 回复: Markdown 渲染后的文本       │
│    - 工具调用记录                         │
├─────────────────────────────────────────┤
│  Dynamic 区域 (Ink 动态重绘)             │  ← 每次状态变化重绘
│  - StreamingText (流式文本，仅显示尾部)   │
│  - ToolCall (当前工具调用)                │
│  - ShellOutput (Shell 输出)              │
│  - Permission (权限确认)                 │
│  - SelectOptions (用户选择)              │
│  - Spinner (加载中)                      │
│  - Error (错误信息)                      │
│  - ChatInput (输入框 + 命令补全)          │
└─────────────────────────────────────────┘
```

### Markdown 渲染

```
renderMarkdown(text)  (cli/src/ui/render-markdown.ts)
  │
  ├─ marked.lexer(text)    // Markdown → AST Token 树
  │
  └─ renderTokens(tokens)  // AST → ANSI 转义序列
       ├─ heading    → chalk.hex('#89b4fa').bold.underline(text)  (h1)
       │             → chalk.bold(text)                           (h2+)
       ├─ paragraph  → text + '\n'
       ├─ code block → chalk.dim('[lang]') + chalk.hex('#f9e2af')(code)
       ├─ list       → bullet '•' 或 numbered '1.'
       ├─ blockquote → chalk.dim.italic('│ ' + text)
       ├─ strong     → chalk.bold(text)
       ├─ em         → chalk.italic(text)
       ├─ codespan   → chalk.hex('#89b4fa')(code)
       ├─ link       → chalk.hex('#89b4fa').underline(text) (url)
       ├─ table      → 对齐表格，│ 分隔，─ 分行
       └─ hr         → chalk.dim('─' * 40)
```

### 流式文本显示策略

```
StreamingText 组件 (cli/src/ui/components/StreamingText.tsx)
  │
  问题: Ink 动态区域超出终端高度时会出现重复渲染
  │
  解决方案 (参考 Gemini CLI):
  ├─ 计算可用行数: maxLines = terminalRows - 6 (reserved)
  ├─ 只显示文本末尾 maxLines 行
  └─ 完整文本在流式结束后转入 Static <MessageList>

  节流策略 (use-agent.ts):
  ├─ onTextDelta → 累积到 streamingBufferRef (不触发 re-render)
  └─ 每 50ms setInterval → flush buffer → setState(streamingText)
```

### 消息列表渲染

```
MessageList 组件 (cli/src/ui/components/MessageList.tsx)
  │
  └─ <Static items={messages}>   // Ink Static: 写入一次，永不重绘
       ├─ role === 'user'
       │    → <Text color="#89b4fa" bold>> </Text>{content}
       │
       └─ role === 'assistant'
            → <Text>{renderMarkdown(content)}</Text>
            └─ toolCalls?.map → [status] toolName: output...
```

---

## 阶段七：退出与清理

### 正常退出流程

```
/exit 命令 或 Ctrl+C
  │
  ├─ cleanup() (use-agent.ts)
  │    └─ saveSession(loopState, model)
  │         ├─ generateSessionSummary()    // AI 生成会话摘要
  │         │    → title, summary, keyResults, pendingWork, decisions, status
  │         └─ saveSessionSummary()
  │              ├─ .x-code/sessions/latest.json    // 最新会话
  │              └─ .x-code/sessions/{id}.json      // 归档
  │
  ├─ exit() (Ink unmount)
  │
  └─ printExitSummary() (app.tsx)
       → "anthropic:claude-sonnet-4-5 | 12,345 tokens (in: 10,000, out: 2,345) | cost: $0.0456"
```

### SIGINT (Ctrl+C) 处理

```
process.on('SIGINT')  (cli/src/index.ts)
  ├─ 第一次 Ctrl+C → cleanup() → printExitSummary() → process.exit(0)
  └─ 第二次 Ctrl+C → process.exit(1)  // 强制退出
```

---

## 具体示例

**用户输入：** "帮忙分析一下项目产品功能以及优化点"

### 完整执行流程

```
1. 用户在终端输入 "帮忙分析一下项目产品功能以及优化点"，按 Enter

2. ChatInput 组件
   └─ onSubmit("帮忙分析一下项目产品功能以及优化点")

3. App.handleSubmit()
   └─ 非 / 开头，走普通提交路径
   └─ submit("帮忙分析一下项目产品功能以及优化点")

4. useAgent.submit()
   ├─ initialize() (首次)
   │    ├─ 加载 AutoMemory (全局 + 项目)
   │    ├─ scanProject() → 检测到 pnpm, TypeScript, React, Ink, Vitest 等
   │    └─ loadLatestSession() → 检查是否有未完成会话
   │
   ├─ setState
   │    → messages 追加用户消息
   │    → isLoading = true
   │
   │  [终端显示]
   │  > 帮忙分析一下项目产品功能以及优化点
   │  ⠋ Thinking...
   │
   ├─ 构建 callbacks
   └─ agentLoop("帮忙分析一下项目产品功能以及优化点", model, options, callbacks)

5. agentLoop() — 第一轮
   ├─ messages: [{ role: 'user', content: '帮忙分析一下项目产品功能以及优化点' }]
   │
   ├─ buildKnowledgeContext()
   │    → 加载项目知识、规则、记忆、上次会话等
   │
   ├─ buildSystemPrompt()
   │    → 完整 system prompt (约 2000-3000 tokens)
   │    → 包含: 身份、工具列表、规则、环境信息、知识上下文
   │
   ├─ streamText({ model, system, messages, tools })
   │    → API 请求发送到 AI Provider (如 Anthropic)
   │
   ├─ AI 决定先了解项目结构，返回 tool-calls:
   │    ├─ tool-call: glob({ pattern: "**/*.{ts,tsx,json}" })
   │    └─ tool-call: readFile({ filePath: "package.json" })
   │
   │  [终端显示]
   │  ◑ glob **/*.{ts,tsx,json}
   │
   ├─ finishReason = 'tool-calls'
   ├─ handleToolCalls()
   │    ├─ glob → 自动执行 (always-allow) → 返回文件列表
   │    └─ readFile → 自动执行 (always-allow) → 返回 package.json 内容
   │
   └─ continue (进入下一轮)

6. agentLoop() — 第二轮
   ├─ messages 现在包含: user + assistant(tool-calls) + tool-results
   │
   ├─ streamText() → AI 继续分析
   │
   ├─ AI 可能再次调用工具读取更多文件:
   │    ├─ readFile({ filePath: "packages/core/src/index.ts" })
   │    ├─ readFile({ filePath: "packages/cli/src/ui/components/App.tsx" })
   │    └─ listDir({ path: "packages/core/src/tools" })
   │
   │  [终端显示]
   │  ◑ readFile packages/core/src/index.ts
   │
   └─ continue

7. agentLoop() — 第三轮 (可能更多轮)
   ├─ AI 已获得足够信息，开始生成分析报告
   │
   ├─ streamText() → AI 返回纯文本分析 (finishReason = 'stop')
   │
   ├─ 流式输出过程:
   │    ├─ text-delta: "## 项目产品功能分析\n\n"
   │    │    → callbacks.onTextDelta() → streamingBuffer 累积
   │    │    → 50ms 后 flush → setState({ streamingText })
   │    │
   │    │  [终端显示 — StreamingText 组件，只显示尾部 N 行]
   │    │  ## 项目产品功能分析
   │    │
   │    │  ### 核心功能
   │    │  1. 多模型支持 — 支持 Anthropic, OpenAI, Google...
   │    │  ...
   │    │
   │    ├─ text-delta: "### 1. 多模型 AI 对话\n..."
   │    ├─ text-delta: "### 2. 智能工具调用\n..."
   │    ├─ ... (持续流式输出)
   │    └─ text-delta: "### 优化建议\n..."
   │
   └─ finishReason = 'stop' → break 退出循环

8. 回到 useAgent.submit()
   ├─ stopStreamingFlush()     // 停止定时器，flush 剩余 buffer
   │
   ├─ setState({
   │    messages: [...prev.messages, {
   │      role: 'assistant',
   │      content: '## 项目产品功能分析\n\n### 核心功能\n...',  // 完整回复
   │    }],
   │    streamingText: '',      // 清空流式文本
   │    isLoading: false,       // 加载完成
   │    currentToolCall: null,
   │  })
   │
   │  [终端最终显示]
   │
   │  > 帮忙分析一下项目产品功能以及优化点     ← Static 区 (用户消息)
   │                                            ← Static 区 (AI 回复, Markdown 渲染)
   │  项目产品功能分析                          ← h2, bold + underline + accent blue
   │
   │  核心功能                                  ← h3, bold
   │
   │  1. 多模型 AI 对话                         ← ordered list
   │     支持 Anthropic, OpenAI, Google,
   │     DeepSeek 等多个 AI 服务商...
   │
   │  2. 智能工具调用
   │     13 个内置工具: 文件读写, Shell 执行,
   │     代码搜索, 网络搜索...
   │
   │  3. 知识管理系统
   │     - 分层知识加载 (全局/项目/本地)
   │     - AutoMemory 自动记忆
   │     - 会话持久化与恢复
   │
   │  ...
   │
   │  优化建议
   │
   │  1. 性能优化
   │     - 工具结果截断阈值可配置化
   │     - 流式刷新频率自适应
   │  ...
   │
   │  > █                                       ← ChatInput 重新可用
   │
   └─ 等待用户下一次输入
```

### AI 回复中可能的工具调用序列示意

对于"分析项目产品功能以及优化点"这类问题，AI 可能执行如下工具调用链：

```
Turn 1: AI 需要了解项目结构
  ├─ glob({ pattern: "**/package.json" })              → 找到 monorepo 结构
  ├─ readFile({ filePath: "package.json" })             → 根 package.json
  └─ listDir({ path: "packages" })                      → 发现 cli/ 和 core/

Turn 2: AI 深入了解各包
  ├─ readFile({ filePath: "packages/core/package.json" })
  ├─ readFile({ filePath: "packages/cli/package.json" })
  └─ listDir({ path: "packages/core/src" })

Turn 3: AI 阅读核心代码
  ├─ readFile({ filePath: "packages/core/src/agent/loop.ts" })
  ├─ readFile({ filePath: "packages/core/src/tools/index.ts" })
  └─ readFile({ filePath: "packages/cli/src/ui/components/App.tsx" })

Turn 4: AI 生成最终分析报告 (纯文本回复, 无工具调用)
  → finishReason = 'stop'
```

---

## 关键数据流总结

```
┌──────────┐    text     ┌──────────┐   submit()   ┌────────────┐
│ ChatInput │ ─────────> │   App    │ ──────────> │  useAgent  │
│ (Ink)     │            │ (React)  │             │  (Hook)    │
└──────────┘            └──────────┘             └─────┬──────┘
                                                       │ agentLoop()
                                                       v
                              ┌──────────────────────────────────┐
                              │         agentLoop (Core)          │
                              │                                    │
                              │  ┌─────────────┐  ┌────────────┐ │
                              │  │ System Prompt│  │ Knowledge  │ │
                              │  │ Builder      │  │ Loader     │ │
                              │  └──────┬──────┘  └─────┬──────┘ │
                              │         │               │         │
                              │         v               v         │
                              │  ┌─────────────────────────────┐ │
                              │  │      streamText() (AI SDK)   │ │
                              │  │  model + system + messages   │ │
                              │  │  + tools                     │ │
                              │  └──────┬───────────────┬──────┘ │
                              │         │               │         │
                              │    text-delta       tool-calls    │
                              │         │               │         │
                              │         │     ┌─────────v───────┐│
                              │         │     │ handleToolCalls()││
                              │         │     │ ├─ Permission   ││
                              │         │     │ ├─ Execute      ││
                              │         │     │ └─ Result       ││
                              │         │     └─────────┬───────┘│
                              │         │               │         │
                              └─────────┼───────────────┼─────────┘
                                        │               │
                              callbacks │               │ callbacks
                                        v               v
                              ┌──────────────────────────────────┐
                              │          useAgent (Hook)           │
                              │  onTextDelta → streamingBuffer    │
                              │  onToolCall  → currentToolCall    │
                              │  onAskPermission → pendingPerm    │
                              │  onUsageUpdate → usage            │
                              └──────────────┬───────────────────┘
                                             │ setState()
                                             v
                              ┌──────────────────────────────────┐
                              │         React/Ink Re-render       │
                              │                                    │
                              │  <MessageList>    Static 区域     │
                              │  <StreamingText>  动态区域        │
                              │  <ToolCall>       动态区域        │
                              │  <Permission>     动态区域        │
                              │  <ChatInput>      动态区域        │
                              └──────────────────────────────────┘
                                             │
                                             v
                                        终端输出 (ANSI)
```

---

## 文件索引

| 阶段          | 文件                                      | 关键函数/组件                                                      |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| CLI 入口      | `cli/src/index.ts`                        | `main()`, `checkNodeVersion()`, `loadEnvFile()`                    |
| Ink 渲染      | `cli/src/app.tsx`                         | `startApp()`, `printExitSummary()`                                 |
| 根组件        | `cli/src/ui/components/App.tsx`           | `App`, `handleSubmit()`, `SLASH_COMMANDS`                          |
| Agent Hook    | `cli/src/ui/hooks/use-agent.ts`           | `useAgent()`, `submit()`, `AgentState`                             |
| Agent 循环    | `core/src/agent/loop.ts`                  | `agentLoop()`, `handleToolCalls()`, `compressMessages()`           |
| System Prompt | `core/src/agent/system-prompt.ts`         | `buildSystemPrompt()`, `PLAN_MODE_PROMPT`                          |
| 消息处理      | `core/src/agent/messages.ts`              | `estimateTokens()`, `toolResultMessage()`                          |
| 定价          | `core/src/agent/pricing.ts`               | `estimateCost()`, `MODEL_PRICING`                                  |
| 工具注册      | `core/src/tools/index.ts`                 | `toolRegistry`, `truncateToolResult()`                             |
| 权限系统      | `core/src/permissions/index.ts`           | `checkPermission()`, `getPermissionLevel()`                        |
| 知识加载      | `core/src/knowledge/loader.ts`            | `buildKnowledgeContext()`, `loadRuleFiles()`                       |
| 会话管理      | `core/src/knowledge/session.ts`           | `loadLatestSession()`, `saveSession()`, `generateSessionSummary()` |
| 自动记忆      | `core/src/knowledge/auto-memory.ts`       | `AutoMemory`, `initMemories()`                                     |
| 项目扫描      | `core/src/knowledge/hooks.ts`             | `scanProject()`                                                    |
| 配置          | `core/src/config/index.ts`                | `loadConfig()`, `resolveModelId()`, `getAvailableProviders()`      |
| Provider      | `core/src/providers/registry.ts`          | `createModelRegistry()`                                            |
| 输入组件      | `cli/src/ui/components/ChatInput.tsx`     | `ChatInput`, 模糊匹配补全                                          |
| 消息列表      | `cli/src/ui/components/MessageList.tsx`   | `MessageList` (Ink Static)                                         |
| 流式文本      | `cli/src/ui/components/StreamingText.tsx` | `StreamingText`, 尾部截断策略                                      |
| 工具显示      | `cli/src/ui/components/ToolCall.tsx`      | `ToolCall`                                                         |
| 权限确认      | `cli/src/ui/components/Permission.tsx`    | `Permission`, `DiffView`                                           |
| Header        | `cli/src/ui/components/AppHeader.tsx`     | `printHeader()`, ASCII Logo                                        |
| Markdown      | `cli/src/ui/render-markdown.ts`           | `renderMarkdown()`, marked lexer + chalk                           |
| 主题          | `cli/src/ui/theme.ts`                     | `ACCENT`, `SUCCESS`, `WARNING`, `ERROR`                            |
