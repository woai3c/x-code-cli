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
  cli/     @x-code-cli/cli   — 终端 UI 层 (Ink/React — 使用 @jrichman/ink fork)
  core/    @x-code-cli/core  — Agent 核心逻辑 (AI SDK + Tools)
```

**渲染架构**：

Ink 上游标准版在 CJK / IME / 长流式文本组合下有根深蒂固的抖动问题（Yoga 布局按字符串粗粒度测宽度、log-update 按逻辑换行数擦屏）。主流 AI CLI 的共识是必须绕开：Claude Code vendor 自己的 Ink fork、Gemini CLI 用 `@jrichman/ink`、Codex 直接 Rust ratatui、opencode 换 OpenTUI + SolidJS。我们走混合路线：

1. **依赖 = `@jrichman/ink@6.6.9`**（Google/Jacob Richman 维护、Gemini CLI 生产在用）—— 通过 npm alias `"ink": "npm:@jrichman/ink@6.6.9"`，代码里 `import from 'ink'` 完全不改。fork 内建 cell-level StyledLine 测量、DEC 2026 同步更新、IME 光标定位。
2. **`<ChatInput>` 独占整个底部区域**，直接 `process.stdout.write` + cell-level diff，完全绕过 Ink 的动态区。Ink 的动态区 = 永远空（除非 `<SelectOptions>` 被触发，这个仍走 Ink）。

```
+----------------------------------------------------------+
|                      CLI 层 (cli/)                         |
|  index.ts → app.tsx → App.tsx (Ink React Fragment)         |
|                                                            |
|  ┌─ Ink 动态区 ─────────────────────────────────────┐      |
|  │  仅 <SelectOptions>（askUser 交互，罕见触发）     │      |
|  │  其余组件全部不再经 Ink 渲染                       │      |
|  └────────────────────────────────────────────────┘       |
|                                                            |
|  ┌─ <ChatInput> cell buffer（独占 stdout 底部）────┐      |
|  │  构建 2D cell 网格，每帧 diff prev → 只 write    │      |
|  │  差异的 cell。一次 stdout.write() 一帧，外层包   │      |
|  │  BSU/ESU (DEC 2026) 原子渲染。                   │      |
|  │                                                  │      |
|  │  [error 行] (可选)                              │      |
|  │  [streaming markdown 行 × N] (流式输出中,        │      |
|  │    仅渲染完整行, 经 renderMarkdown)              │      |
|  │  [permission 对话框] (权限请求时,                │      |
|  │    键盘也由 ChatInput 内部路由, y/n/Up/Down/↩)   │      |
|  │  [空行]                                          │      |
|  │  [⠋ Thinking... (Xs · ↑ Yk tokens)] (loading)   │      |
|  │  ───── (输入框顶分隔线)                          │      |
|  │  > 用户输入                                       │      |
|  │  ───── (输入框底分隔线)                          │      |
|  │  [/<command> 补全菜单] (slash command 时)       │      |
|  │                                                  │      |
|  │  同时 ChatInput 还负责把 messages 新增条目用     │      |
|  │  writeMessageToStdout + process.stdout.write    │      |
|  │  提交到终端 scrollback（即我们控的区域上方）。    │      |
|  │  提交前先 eraseRegion 擦自己的 frame, BSU/ESU    │      |
|  │  包一次，提交+重绘原子化。                        │      |
|  └────────────────────────────────────────────────┘       |
|                                                            |
|  ┌─ 输入管线 (usePromptInput) ──────────────────────┐      |
|  │  stdin → bracketed paste[^bp] / debounce →       │      |
|  │              onPaste / onText / onKey            │      |
|  │  paste-refs → [Pasted text #N +M lines] 占位     │      |
|  │                                                  │      |
|  │  [^bp] bracketed paste mode：终端通过 ESC[?2004h │      |
|  │   开启，粘贴前后加 \x1b[200~ / \x1b[201~，       │      |
|  │   应用据此把"粘贴"和"逐键输入"区分开。           │      |
|  └────────────────────────────────────────────────┘       |
+----------------------------------------------------------+
|                Hook 桥接层 (use-agent.ts)                 |
|  useStreamBuffer ←→ AgentCallbacks ←→ Core Agent Loop     |
|  AgentState 新增 streamingText 字段                        |
+----------------------------------------------------------+
|                      Core 层 (core/)                       |
|  agentLoop() → runTurn() → streamText() → processToolCalls() |
|  Knowledge / Session / Permission / Plan Mode              |
+----------------------------------------------------------+
|                   AI SDK + Provider 层                     |
|  Anthropic / OpenAI / Google / DeepSeek / ...              |
+----------------------------------------------------------+
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
 |                |                  |                    |                    |                    |                  |
 |                |                  |    13. setState → isLoading=true        |                    |                  |
 |                |                  |    14. 添加 user message 到 messages    |                    |                  |
 |  <Spinner>     |<------------------------------------                      |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |    15. 创建 callbacks                   |                    |                  |
 |                |                  |    16. agentLoop() |                    |                    |                  |
 |                |                  |    |--------------->                    |                    |                  |
 |                |                  |                    | 17. buildKnowledgeContext()             |                  |
 |                |                  |                    | 18. buildSystemPrompt()                 |                  |
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
 |                |                  |                    |---> useStreamBuffer.appendTextDelta() |                     |
 |                |                  |  每 delta 更新 streamingText (完整行); \n\n 段落时提交到 messages |                |
 |  <streaming>   |<------- ChatInput cell buffer 实时渲染带 markdown 的完整行 |                    |                  |
 |  <scrollback>  |<------- 段落提交: ChatInput.useEffect 把 messages 新条目写到 stdout (走 writeMessageToStdout + markdown) |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | tool-call →        |                    |                  |
 |                |                  |                    | callbacks.onToolCall()                  |                  |
 |  Thinking ↓    |<------- setState(currentToolCall)     |  spinner 切换 tool-use 模式              |                  |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    | 22. finishReason=tool-calls             |                  |
 |                |                  |                    | 23. processToolCalls() (tool-execution.ts) |              |
 |                |                  |                    |                    |                    |                  |
 |                |                  |                    |    权限检查 (write tools)                |                  |
 |                |                  |    onAskPermission |<---                |                    |                  |
 |  [权限对话框]   |<------- permissionQueue 推入 (ChatInput cell buffer 展开 Yes/No 行)             |                  |
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
 |                |                  |    27. flushBuffer() — drain residual stream buffer 到 messages               |
 |                |                  |    28. 若 stream 无 text-delta，extractLastAssistantText 兜底 |                  |
 |                |                  |    29. setState → isLoading=false       |                    |                  |
 |                |                  |                    |                    |                    |                  |
 |  <scrollback>  |<------- ChatInput.useEffect 逐条把新 message 经 writeMessageToStdout 写到终端     |
 |  > 输入提示符   |<------- ChatInput spinner 消失, 输入框接受下一轮问题                             |
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
  ├─ loadConfig()                  // 读取 ~/.x-code/config.json
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

**Provider 检测顺序：** Anthropic → OpenAI → DeepSeek → Alibaba → Google → xAI → Zhipu → Moonshot → Custom

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
  messages: [],                    // 对话历史（已提交的 user / assistant / tool 条目）
  isLoading: false,                // 加载状态
  currentToolCall: null,           // 当前正在执行的工具（驱动 spinner mode）
  shellOutput: '',                 // Shell 实时输出（当前未在 UI 显示，保留数据）
  permissionQueue: [],             // 待用户确认的权限请求队列（FIFO，按 toolCallId 去重）
  pendingQuestion: null,           // askUser 待回答的问题
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  error: null,                     // 错误信息
  streamingText: '',               // 正在流式输出的活文本（only 完整行），ChatInput 渲染在 cell buffer 里
}
```

> 注：权限请求是**队列**而不是单值。同一轮 `processToolCalls` 里可能触发多次 `onAskPermission`（例如 AI 一次返回多个 edit 调用），UI 逐个弹出 —— 这些 Permission 对话框在 ChatInput 内部的 cell buffer 里渲染。

> 注：**streaming 文本在 React state 里**（`streamingText`）。`useStreamBuffer(appendMessage, setStreamingText)` 每次 delta 都会调 `setStreamingText(completeLinesOnly)`，React 自动 batch 连续 delta 成单次 re-render。ChatInput 的 cell-level diff 只会局部更新变化的 cell，CJK 抖动问题由 `@jrichman/ink` fork 处理。只在段落断点 `\n\n` 或超 12 行时才把内容 flush 到 `messages` 提交到 scrollback。

### 步骤 8: 初始 UI 渲染

App 组件 JSX 结构（极简）：

```jsx
<>
  {/* Ink 动态区 — 几乎永远是空。仅 <SelectOptions>（askUser 交互）
         会渲染内容，因为它有自由文本输入模式，迁移进 cell buffer 成本较高。 */}
  <Box flexDirection="column" width={termWidth}>
    {state.pendingQuestion && (
      <SelectOptions
        question={state.pendingQuestion.question}
        options={state.pendingQuestion.options}
        onSelect={resolveQuestion}
      />
    )}
  </Box>

  {/* ChatInput 独占底部 — return null 给 Ink（不走布局），自己用
         process.stdout.write + cell-level diff 渲染。职责包括：
           - 把 messages 新增条目写到 scrollback (writeMessageToStdout)
           - cell buffer 内渲染 spinner / streaming / permission / error / 输入框
           - 键盘事件路由（permission 激活时吸收 Up/Down/Enter/y/n） */}
  <ChatInput
    messages={state.messages}
    onSubmit={handleSubmit}
    onInterrupt={exit}
    disabled={!!state.pendingQuestion /* 仅 askUser 弹窗时彻底锁键盘 */}
    hidden={!!state.pendingQuestion}
    spinner={
      state.isLoading && !state.pendingQuestion && state.permissionQueue.length === 0
        ? { label: 'Thinking', mode: state.currentToolCall ? 'tool-use' : 'requesting',
            totalTokens: state.usage.totalTokens }
        : null
    }
    errorMessage={state.error}
    streamingText={state.streamingText || undefined}
    permission={
      state.permissionQueue[0]
        ? { toolName: ..., input: ..., onResolve: resolvePermission }
        : null
    }
    commands={SLASH_COMMANDS}
  />
</>
```

**关键点**：
- `<ChatInput>` 通过 props 接收所有动态信息（messages、spinner、permission、error、streamingText），内部构建 cell buffer 一帧。
- `disabled` 只在 `pendingQuestion` 时为 true；加载中不锁键盘（允许预输入下一个问题，Enter 被 `spinner != null` 守卫忽略）。
- 整个 useEffect 包在 DEC 2026 `\x1b[?2026h` / `\x1b[?2026l` 同步更新块里，保证 eraseRegion + 写消息 + 重绘 frame 原子化，消除闪烁。

---

## 阶段三：用户输入处理

**组件：** `cli/src/ui/components/ChatInput.tsx`
**输入 Hook：** `cli/src/ui/hooks/use-prompt-input.ts`
**Paste 辅助：** `cli/src/ui/paste-refs.ts`

### 为什么不用 Ink 的 `useInput`

Ink 自带的 `useInput` 走 `parseKeypress`，**不认 bracketed paste mode** 的 `\x1b[200~` / `\x1b[201~` 包裹序列，而 Windows Terminal 又不保证把粘贴批量打包成一次 stdin data 事件——结果是大粘贴会被拆成多个小 chunk 逐字处理，触发 React setState 闭包竞态 + 字符丢失。ChatInput 因此自己挂 stdin 监听。

### 输入管线：`usePromptInput`

```
stdin data 事件
  │
  ├─ 启动时 process.stdout.write('\x1b[?2004h')    // 启用 bracketed paste
  │
  ├─ 收到 '\x1b[200~' → 进入 inPaste 模式
  │    └─ 累积 state.buffer 直到 '\x1b[201~'
  │         └─ flushPending() → onPaste(normalizedContent)   // \r\n → \n
  │
  └─ 不在 paste 中 → processNormalInput(chunk)
       ├─ data === '\r' / '\n'  → onKey('return')   // 'return' = 回车键（Enter / Return，键盘主区大回车），历史上叫 Return，这里沿用该命名
       ├─ data === '\x7f' / '\b' → onKey('backspace') // 退格键（删除光标左侧字符的那个键）
       ├─ data === '\t'          → onKey('tab')       // Tab 键
       ├─ data === '\x1b[A/B/C/D' → onKey('up' / 'down' / 'right' / 'left')  // 四个方向键
       ├─ data === '\x03'        → process.kill(pid, 'SIGINT')
       └─ 其他可打印文本
            └─ queueText(data) —— 累积到 pendingTextRef + 30ms 定时器
                 └─ 定时器到期 → flushPending()
                      ├─ 内容 ≥ 8 字符或含 \n → onPaste(text)
                      └─ 否则 → onText(text)
```

**双层粘贴检测**：

1. **Bracketed paste fast path**：现代终端（Windows Terminal / VS Code / iTerm2 / gnome-terminal 等）支持 `\x1b[?2004h`，粘贴原子到达
2. **30ms debounce fallback**：老终端（cmd.exe / 老 PowerShell）不支持 marker，靠时间窗口区分"打字"（> 100ms 间隔）和"粘贴 burst"（< 1ms 间隔）
3. **特殊键在 dispatch 前强制 flush pending**：保证 Enter/Backspace/Arrow 看到的 text state 是完整的

**行尾归一化**：paste 入口和 flush 入口都做 `replace(/\r\n?/g, '\n')`。没有这一步的话，后续写 stdout 时裸 `\r` 会被终端当 carriage return，新字符覆盖已打印字符，产生"optimizations Claude Managed Agents is currently in beta" 这种拼接错觉。

### ChatInput 的 onPaste / onText / onKey 处理

```
onPaste(content)
  ├─ lineCount = content.split(/\r\n|\r|\n/).length
  ├─ isLarge = lineCount >= 3 || content.length >= 400
  │    ├─ 是 → nextPasteIdRef++ → setPastedContents({ [id]: { content, lineCount } })
  │    │       setText(text + formatPasteRef(id, lineCount))
  │    │       // 输入框里只显示 "[Pasted text #1 +115 lines]"
  │    └─ 否 → setText(text + content)           // 短粘贴内联
  │
onText(chunk)
  └─ setText((prev) => prev + chunk)
  //  setCompletionIndex(0)

onKey('return')   // 用户按下回车键
  └─ handleSubmit()
       ├─ expandPasteRefs(text, pastedContents) — 把所有 [Pasted text #N +M lines]
       │     替换回 pastedContents 里存的完整原文
       └─ onSubmit(expanded) — agent 看到的是完整内容

onKey('backspace')
  └─ stripTrailingRef(text):
       ├─ 若文本末尾是 [Pasted text #N ...] → 整体剥离整个 ref + 从 pastedContents 删除对应 id
       └─ 否则 → text.slice(0, -1)              // 删一个字符

onKey('tab')  → 接受当前补全候选
onKey('up/down') → 切换补全候选项
```

### 多行渲染 + 硬顶

ChatInput 把 `text` split 成多行，在有上下边框的 Box 里逐行渲染，输入框高度随行数自动伸缩。**硬顶 `MAX_VISIBLE_LINES = 10`**：超过 10 行时显示前 9 行 + `… +N more lines`，完整 text 仍在 state 里，只是显示截断——即使上游 paste 检测失败让大量字符进了 onText，输入框也绝不会膨胀到撑爆 Ink 动态区。

**斜杠命令补全：**

- 用户输入 `/` 时，显示所有命令列表
- 模糊匹配：输入 `/m` 匹配 `/model`
- Tab 键接受补全

**终端显示：**

```
> /█                          ← 用户正在输入
  /help            Show this help message
  /model           Switch model or list available models
  /usage           Show token usage
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
  │    └─ initMemories()          // 加载全局 + 项目 AutoMemory
  │         ├─ globalMemory.load()   // ~/.x-code/memory/auto.md
  │         ├─ projectMemory.load()  // .x-code/memory/auto.md
  │         ├─ globalMemory.evict(90)   // 清除 90 天前的记忆
  │         └─ projectMemory.evict(90)
  │
  ├─ 2. 更新 UI 状态
  │    setState({
  │      isLoading: true,
  │      shellOutput: '',
  │      error: null,
  │      messages: [...prev.messages, { role: 'user', content: text }],
  │    })
  │    // ChatInput 的 useEffect 检测到 messages 增长, eraseRegion + writeMessageToStdout
  │    // 直接 process.stdout.write 把 user message 落到 scrollback
  │
  ├─ 3. 创建 AbortController (用于 Ctrl+C 取消)
  │
  ├─ 4. 构建 AgentCallbacks (Core Agent → UI 桥接)
  │    {
  │      onTextDelta:       delta → useStreamBuffer.appendTextDelta(delta)
  │                                   → bufferRef += delta
  │                                   → setStreamingText(trimToCompleteLines(buffer))
  │                                     (仅完整行进 state, 半截行留内部 buffer 不显示)
  │                                   → 遇到 \n\n 段落断点或单段 > 12 行时:
  │                                     commitToScrollback → appendMessage 推入 state.messages
  │                                     ChatInput useEffect 把它写到 scrollback (经 renderMarkdown)
  │                                   streamingText 更新时 ChatInput cell-level diff 只重绘
  │                                   变化的 cell, 无闪烁
  │      onToolCall:        (name, input) → flushBuffer() 先把 buffer 的残留文本提交
  │                                       → 记录 toolCallStartRef 起始时间
  │                                       → setState({ currentToolCall })
  │      onToolResult:      (id, result) → 计算 durationMs (工具执行耗时)
  │                                       → 构建 DisplayToolCall { toolName, input, output, status, durationMs }
  │                                       → push 到 state.messages
  │                                       → setState({ currentToolCall: null })
  │      onAskPermission:   (toolCall) → new Promise → permissionQueue 推入 entry
  │                                       (ChatInput cell buffer 展开 Permission 对话框)
  │      onAskUser:         (question, opts) → new Promise → setState({ pendingQuestion })
  │                                       (ChatInput 被 hidden=true, Ink 渲染 <SelectOptions>)
  │      onShellOutput:     chunk → setState(shellOutput += chunk) (当前未在 UI 显示)
  │      onUsageUpdate:     usage → setState({ usage })
  │      onContextCompressed: () → (可选通知)
  │      onError:           error → setState({ error })
  │    }
  │
  ├─ 5. 调用 agentLoop(text, model, options, callbacks, loopStateRef.current ?? undefined)
  │    └─ 第五个参数 existingState 复用上一次 submit 的 LoopState，使同一次 CLI 会话内
  │       多轮提问共享同一个 state.messages / tokenUsage / planMode / sessionId。
  │       (不是启动时自动恢复历史会话 —— 启动时 loopStateRef 为 null。)
  │
  └─ 6. 收尾：
       ├─ flushBuffer() 把 stream buffer 的最后一段残留文本 push 到 messages
       ├─ 安全网：若本轮 onTextDelta 从未触发 (某些推理模型把全部文本放在 response.messages
       │   的最终 part 里)，使用 extractLastAssistantText(loopState.messages) 兜底取文本
       │   追加为 assistant message
       └─ setState({ isLoading: false, currentToolCall: null })
```

### 步骤 10: agentLoop() — 核心循环

```
agentLoop(userMessage, model, options, callbacks, existingState)
  │
  ├─ 1. 初始化或复用 LoopState
  │    {
  │      messages: [],            // AI SDK ModelMessage 数组
  │      tokenUsage: {...},       // 累计 token 用量（API 返回的真实值）
  │      lastInputTokens: 0,      // 上一轮 API 返回的 inputTokens，用于触发压缩
  │      planMode: false,         // 计划模式标志
  │      planId: null,            // 当前计划 ID（计划模式下生成）
  │      sessionId: '...',        // 会话 ID
  │      startedAt: '...',        // 会话起始时间 (ISO)
  │      filesModified: Set<>,    // 已修改文件集合
  │      turnCount: 0,            // 循环轮次
  │    }
  │
  ├─ 2. state.messages.push({ role: 'user', content: userMessage })
  │
  ├─ 3. 加载知识上下文
  │    └─ buildKnowledgeContext()               // 组装完整知识上下文
  │         ├─ 全局偏好       ~/.x-code/AGENTS.md           (人写)
  │         ├─ 全局自动记忆   ~/.x-code/memory/auto.md      (AI 自动写)
  │         ├─ 项目 AGENTS.md chain              (人写，从 cwd 向上到 .git 根，
  │         │                                     沿路径每层找 AGENTS.md，
  │         │                                     root → leaf 顺序拼接，
  │         │                                     monorepo 子包可用自己的
  │         │                                     AGENTS.md 覆盖根配置)
  │         ├─ 项目自动记忆   .x-code/memory/auto.md        (AI 自动写)
  │         └─ 本地偏好       .x-code/local/preferences.md  (人写，gitignored)
  │
  ├─ 4. 检测 .git 目录一次（用于 system prompt 的 Environment 段）
  │
  ├─ 5. 计算压缩阈值
     compressionThreshold = getCompressionThreshold(modelId)
     └─ contextWindow * 0.8     (如 anthropic 200k * 0.8 = 160k)
  │
  └─ 5. while (turnCount < maxTurns) 主循环
       │
       ├─ turnCount++
       │
       ├─ 上下文压缩检查（双重检查，满足任一即触发）
       │    if (state.lastInputTokens > compressionThreshold
       │        || estimateTokenCount(messages) > compressionThreshold)
       │      ├─ generateSessionSummary() → saveSessionSummary()
       │      ├─ compressMessages()
       │      │    ├─ 保留最近 6 条消息
       │      │    ├─ 对旧消息调用 AI 生成摘要
       │      │    └─ 替换为 [Previous conversation summary]
       │      └─ state.lastInputTokens = 0   // 压缩后重置，下一轮再累计
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
       │    try/catch 包裹：抛错时调用 classifyApiError(err) 将 HTTP 错误映射为
       │    人类可读消息 (401/403 授权、429 限流、503 服务不可用、timeout 等)，
       │    通过 callbacks.onError 上报；非可重试错误直接 break 退出循环。
       │
       ├─ 流式处理 (for await chunk of fullStream)
       │    ├─ text-delta  → callbacks.onTextDelta(text)
       │    ├─ tool-call   → callbacks.onToolCall(name, input)
       │    └─ tool-result → callbacks.onToolResult(id, truncated)
       │
       │    stream 循环同样被 try/catch 包裹，错误经 classifyApiError() 分类后上报。
       │
       ├─ 收集响应
       │    ├─ response.messages → push 到 state.messages
       │    ├─ usage → 累加 tokenUsage (inputTokens/outputTokens/totalTokens)
       │    │         并把 usage.inputTokens 写入 state.lastInputTokens
       │    │         （下一轮开头据此判断是否压缩）
       │    └─ finishReason → 决定是否继续循环
       │
       ├─ if finishReason === 'tool-calls'
       │    └─ processToolCalls() → continue (下一轮循环)
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
     Is Git Repo: yes | no

  6. [可选] Plan Mode 提示
     "Plan mode is active. You MUST NOT make any edits..."

  7. [可选] 知识上下文 (buildKnowledgeContext 的输出)
     ### Global Preferences (~/.x-code/AGENTS.md)
     ### Global Auto Memory
     ### Project AGENTS.md (.)           (repo 根)
     ### Project AGENTS.md (packages/x)  (monorepo 子包, 如有, 覆盖上层)
     ### Project Auto Memory
     ### Local Preferences
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
processToolCalls(toolCalls, state, options, callbacks)  // tool-execution.ts
  │
  for each toolCall:
  │
  ├─ enterPlanMode
  │    → state.planMode = true, generatePlanId(input.topic)
  │       // topic 是 AI 在 tool-call 里顺手生成的短主题
  │       // 最终 planId 形如 refactor-auth-middleware-20260419-0812
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

X-Code CLI 用 Ink (React for CLI) 渲染终端 UI，但**消息历史完全不走 Ink 的布局引擎**——直接打到终端的滚动缓冲区。Ink 只管底部一小块动态区。

```
┌─────────────────────────────────────────┐
│  终端滚动缓冲区 (由终端自己管理)           │  ← 不走 Ink 布局
│  - 启动 Banner (printHeader, Ink 外)     │
│  - 历史消息 (走 ChatInput 内部提交)       │
│    - 用户消息: "❯ 问题内容"               │
│    - AI 回复: Markdown 渲染后的文本       │
│    - 工具调用记录                         │
│    - 换行 / 折行由终端处理                │
├─────────────────────────────────────────┤
│  Ink 动态区 (几乎永远是空)               │
│  - 仅 <SelectOptions> 罕见触发时渲染     │
│  - 输入框 / spinner / permission / 错误  │
│    全部移入 ChatInput cell buffer        │
├─────────────────────────────────────────┤
│  <ChatInput> cell buffer (独占底部)     │  ← cell-level diff + BSU/ESU 同步更新
│  - Error 行  (可选)                      │
│  - Streaming 文本 (markdown 渲染,        │
│    只显示完整行)                          │
│  - Permission 对话框 (含键盘路由)       │
│  - Thinking... spinner                   │
│  - ─── 输入框顶部分隔线                  │
│  - 输入框 (多行 textarea)               │
│  - ─── 输入框底部分隔线                  │
│  - / 补全菜单 (可选)                    │
└─────────────────────────────────────────┘
```

**为什么要这么分**：上游 Ink 的 Yoga 布局在 CJK + 长文本 + 动态重绘下算错视觉行数，重绘 rewind 超调 → 残影和抖动。主流 AI CLI 都 fork 了 Ink（Claude Code vendor 自己的、Gemini CLI 用 `@jrichman/ink`、Codex 用 Rust ratatui、opencode 用 OpenTUI）。我们走混合：

1. **依赖换成 `@jrichman/ink@6.6.9`**（Google 维护，npm alias `"ink": "npm:@jrichman/ink@6.6.9"`）—— fork 内建 cell-level StyledLine 测量 / DEC 2026 同步更新 / IME-aware 光标定位，解决了上游 Ink 的 CJK 抖动。
2. **`<ChatInput>` 完全绕开 Ink 动态区**，自己走 `process.stdout.write` + 2D cell 网格 diff。因为 fork 的 log-update 内部也用 `\x1b7`/`\x1b8` 保存光标，两套系统同时写动态区会抢那唯一一个 cursor 保存寄存器，留下残影 —— 所以 Ink 动态区必须保持空，ChatInput 独占。
3. **`<SelectOptions>` 是仅剩的 Ink 渲染例外**（askUser 交互里有自由文本 "Other" 模式）。它激活时 ChatInput 收到 `hidden=true` prop 让出底部；这种场景罕见，短时间的视觉不完美可接受。

### 消息写入管线（`stdout-writer.ts` + ChatInput useEffect）

```
use-agent.ts setState({ messages: [...prev, newMsg] })
  │
  └─ React commit
       │
       └─ ChatInput useEffect 触发（无 deps，每次 render 都跑）
            │
            ├─ 进入 DEC 2026 同步更新块 (\x1b[?2026h)
            │
            ├─ 检测 messages.length > writtenMessageCountRef.current?
            │   │
            │   └─ 是 → 先 eraseRegion() 擦掉 cell buffer 的 frame
            │          然后对每条新 message 调用 writeMessageToStdout
            │          （传入 process.stdout.write.bind(process.stdout) 作为
            │           write 函数 —— 直接进终端 stdout,
            │           不经过 Ink 的协调层）
            │
            ├─ 重建 cell frame (error + streaming + permission + spinner + 输入 + 补全)
            ├─ cell-level diff 对比 prevFrameRef 只写差异
            ├─ 末尾发 \x1b7 (DECSC) 保存光标 + \x1b[?2026l (ESU 结束同步更新)
            └─ prevFrameRef = frame
```

**writeMessageToStdout 的流程**（不变，还是那套格式化逻辑）：

```
writeMessageToStdout(write, msg)
  ├─ 归一化 \r\n / \r → \n
  ├─ user message     → write("❯ <line1>\n  <line2>...\n\n")
  ├─ assistant toolCalls → 每个 tc: write(" ● Tool(preview)\n   ⎿  result (Nms)\n")
  └─ assistant content   → renderMarkdown → 2 空格缩进 → write(indented + '\n\n')
```

**关键点**：write 函数是 `(data) => process.stdout.write(data)`，直接进终端 stdout，不经过 Ink 的协调层（Ink 动态区是空的，没什么要协调的）。但 fork 内部在动态区操作时仍会用 `\x1b7`/`\x1b8`，所以我们自己画 cell buffer 时不能指望通过 save/restore cursor 来定位，只能靠 cell-diff 按行列精确写入。

### Markdown 渲染

```
renderMarkdown(text)  (cli/src/ui/render-markdown.ts)
  │
  │  // 颜色直接从 theme.ts import（ACCENT→HEADING / BLUE_PURPLE→CODE /
  │  //                            SPINNER_BLUE→LINK / PROMPT_BORDER→BLOCKQUOTE /
  │  //                            ACCENT_DIM→CODE_LANG），不再内联 hex 字面量
  │
  ├─ marked.lexer(text)         // Markdown → AST Token 树
  │   └─ 禁用 del 扩展           // 避免文件路径里的 ~ 被当作删除线
  │
  └─ renderTokens(tokens)       // 递归 AST → ANSI
       ├─ heading      → h1: chalk.hex(ACCENT).bold.underline(text)
       │               → h2+: chalk.bold(text)
       ├─ paragraph    → text + '\n'
       ├─ code (block) → chalk.dim('[lang]') + 每行缩进 2 空格 + chalk.hex(WARNING)
       ├─ list         → 递归渲染 items，bullet '•' 或 '1. / 2. ...'（带缩进）
       ├─ list_item    → 支持嵌套 list / paragraph 子节点
       ├─ blockquote   → 每行前缀 chalk.dim.italic('  │ ')
       ├─ table        → padVisual 对齐，' │ ' 分隔列，'─┼─' 分隔行
       ├─ hr           → chalk.dim('─' × 40)
       ├─ strong       → chalk.bold(children)
       ├─ em           → chalk.italic(children)
       ├─ codespan     → chalk.hex(ACCENT)(code)
       ├─ link         → chalk.hex(ACCENT).underline(text) + ' (' + dim(href) + ')'
       │                  mailto: 链接只输出邮箱地址
       ├─ br / space   → 换行
       └─ text/escape  → 原样输出（text 若有 inline 子节点则递归）

  流式兜底：renderMarkdown 外层 try/catch —— 部分/未闭合的 Markdown
  走 lexer 失败时直接返回原文，保证 UI 不会因为半截流式文本崩掉。
```

### 流式文本累积策略

```
useStreamBuffer hook (use-stream-buffer.ts)
│
参数: (appendMessage, setStreamingText)
内部状态: bufferRef (ref — 未提交的流式缓冲)
│
累积 (appendTextDelta):
├─ onTextDelta(delta) → bufferRef.current += delta
│
├─ 检测 "\n\n" 段落断点
│   ├─ 有 → commitToScrollback(committed part)
│   │       清 bufferRef，更新 streamingText = 尾段中的完整行
│   └─ 无
│
├─ 检测单段超过 MAX_STREAMING_LINES=12 行
│   └─ 是 → 强制 commitToScrollback 避免 cell buffer 过大
│
└─ 默认 → setStreamingText(trimToCompleteLines(buffer))
         └─ 只把 "末尾是 \n" 的完整行送进 streamingText；
            最后那段未带 \n 的尾巴留在 bufferRef 内部不显示，
            避免用户看到"半截 markdown"（比如 # 没补全）

commit (commitToScrollback):
├─ 读 buffer 文本
├─ appendMessage({ role: 'assistant', content: text })
│    → setState 更新 messages → ChatInput useEffect 把它
│       写到 scrollback (走 writeMessageToStdout + markdown 渲染)
└─ setStreamingText('') — 清掉 cell buffer 里的流式预览

强制 flush 的时机:
├─ 段落断点 "\n\n" 触发
├─ 单段 > 12 行触发
├─ onToolCall 触发前（保证文本先于工具调用指示符显示）
└─ submit 收尾时（drain 最后一段残留）
```

**streamingText 怎么渲染**：ChatInput 把 `streamingText` 过一遍 `renderMarkdown()` 得到 ANSI 字符串，然后用内建的 `ansiStringToCells()` 解析器把 ANSI 切成带样式的 cell。结果就是 cell buffer 里的流式预览**已经是 markdown 格式**（标题加粗、列表有 bullet、代码块高亮），跟真正提交到 scrollback 那一瞬间视觉完全一致 —— 用户看不到"plain text → markdown"的转换闪烁。

**跟 Claude Code 对比**：Claude Code 按行 commit 到 scrollback，我们按段 commit 但 cell buffer 里实时显示完整行预览 —— 视觉效果都是"块一样出现、带完整格式"，用户感知一致。

**AgentState 字段 `streamingText: string`**：`useStreamBuffer` 的 `setStreamingText` 回调就是 `setState(prev => ({ ...prev, streamingText: text }))`，让 ChatInput 作为 prop 拿到。

### writeMessageToStdout 的输出格式

用 `tool-display.ts` 提供的共享显示函数 + chalk 直出 ANSI：

```

user message (writeUserMessage):
❯ <first line>
<line 2 — 两空格缩进对齐>
<line 3>
...

assistant with toolCalls (formatToolCall):
● ToolName(input_preview) ← 绿色圆点 + 粗体标签
⎿ result_summary (duration) ← 缩进结果 + 耗时
(denied 状态显示为红色)

assistant with content:
(2 空格缩进)

# Heading

Paragraph text...

- bullet
  ...

```

所有路径都先跑 `replace(/\r\n?/g, '\n')` 归一化，防止裸 `\r` 在终端里被当 carriage return（会导致后续字符覆盖之前打印的内容，产生粘贴 splicing bug）。

---

## 阶段七：退出与清理

### 正常退出流程

```

/exit 命令 或 Ctrl+C
│
├─ 触发源
│    ├─ /exit → App handleSubmit → exit()（Ink unmount）
│    └─ Ctrl+C → SIGINT handler 只做计数 + 设 exitCode=0
│                然后 Ink 自己捕获 SIGINT → unmount
│
├─ Ink unmount → waitUntilExit() 在 main() 里返回
│
└─ gracefulShutdown() (index.ts) ← 统一收尾
     ├─ saveSession(loopState, model)
     │    ├─ generateSessionSummary()  // AI 生成会话摘要
     │    │   → title, summary, keyResults, pendingWork, decisions, status
     │    └─ saveSessionSummary()
     │        ├─ .x-code/sessions/latest.json  // 最新会话
     │        └─ .x-code/sessions/{id}.json    // 归档
     │
     │   注：持久化仍然会发生（上下文压缩时也会写一次），预留给后续 history 功能。
     │   但下次启动 CLI 时不会再自动读取 latest.json 并注入到 system prompt。
     │
     └─ printExitSummary()
         → "anthropic:claude-sonnet-4-5 | 12,345 tokens (in: 10,000, out: 2,345)"

```

### SIGINT (Ctrl+C) 处理

```

process.on('SIGINT') (cli/src/index.ts)  — 只做安全网，不直接收尾
├─ 第一次 Ctrl+C
│    ├─ sigintCount++       // 仅记录计数
│    └─ process.exitCode = 0 // 若后续直接退出，保证退出码为 0
│       ↓
│    随后 Ink 捕获信号 → unmount App → waitUntilExit 返回
│       ↓
│    main() 走到 gracefulShutdown() → saveSession() + printExitSummary()
│       → "anthropic:claude-sonnet-4-5 | 12,345 tokens (in: 10,000, out: 2,345)"
│
└─ 第二次 Ctrl+C → process.exit(0)  // 强退，退出码仍是 0
```

> 两次 Ctrl+C 退出码都是 `0`。区别在于第二次跳过 gracefulShutdown 的 saveSession / printExitSummary，用于用户等不及收尾想立即返回 shell 的场景。

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
   │ └─ 加载 AutoMemory (全局 + 项目，驱逐 90 天前条目)
   │
   ├─ setState
   │ → messages 追加用户消息
   │ → isLoading = true
   │
   │ [终端显示]
   │ > 帮忙分析一下项目产品功能以及优化点
   │ ⠋ Thinking...
   │
   ├─ 构建 callbacks
   └─ agentLoop("帮忙分析一下项目产品功能以及优化点", model, options, callbacks)

5. agentLoop() — 第一轮
   ├─ messages: [{ role: 'user', content: '帮忙分析一下项目产品功能以及优化点' }]
   │
   ├─ buildKnowledgeContext()
   │ → 拼接全局/项目 AGENTS.md chain、auto memory、local preferences
   │
   ├─ buildSystemPrompt()
   │ → 完整 system prompt (约 2000-3000 tokens)
   │ → 包含: 身份、工具列表、规则、环境信息、知识上下文
   │
   ├─ streamText({ model, system, messages, tools })
   │ → API 请求发送到 AI Provider (如 Anthropic)
   │
   ├─ AI 决定先了解项目结构，返回 tool-calls:
   │ ├─ tool-call: glob({ pattern: "**/\*.{ts,tsx,json}" })
   │ └─ tool-call: readFile({ filePath: "package.json" })
   │
   │ [终端显示]
   │ ● Glob(**/_.{ts,tsx,json})
   │ ⎿ ⠋ Running...
   │
   ├─ finishReason = 'tool-calls'
   ├─ processToolCalls()
   │ ├─ glob → 自动执行 (always-allow) → 返回文件列表
   │ └─ readFile → 自动执行 (always-allow) → 返回 package.json 内容
   │
   │ [工具完成后终端显示 (scrollback, 由 writeMessageToStdout 打出)]
   │ ● Glob(\*\*/_.{ts,tsx,json})
   │ ⎿ 42 files matched (0.1s)
   │ ● Read(package.json)
   │ ⎿ 35 lines (0.0s)
   │
   └─ continue (进入下一轮)

6. agentLoop() — 第二轮
   ├─ messages 现在包含: user + assistant(tool-calls) + tool-results
   │
   ├─ streamText() → AI 继续分析
   │
   ├─ AI 可能再次调用工具读取更多文件:
   │ ├─ readFile({ filePath: "packages/core/src/index.ts" })
   │ ├─ readFile({ filePath: "packages/cli/src/ui/components/App.tsx" })
   │ └─ listDir({ path: "packages/core/src/tools" })
   │
   │ [终端显示]
   │ ● Read(packages/core/src/index.ts)
   │ ⎿ ⠋ Running...
   │
   └─ continue

7. agentLoop() — 第三轮 (可能更多轮)
   ├─ AI 已获得足够信息，开始生成分析报告
   │
   ├─ streamText() → AI 返回纯文本分析 (finishReason = 'stop')
   │
   ├─ 流式输出过程 (段落为单位):
   │ ├─ text-delta: "## 项目产品功能分析\n\n"
   │ │ → callbacks.onTextDelta(delta)
   │ │ → useStreamBuffer.bufferRef.current += delta
   │ │ → buffer 含 "\n\n" 段落断 → commitToScrollback → appendMessage
   │ │ → setState: messages 追加 { role: 'assistant', content: "## 项目产品功能分析\n\n" }
   │ │ → ChatInput useEffect: eraseRegion + writeMessageToStdout → 落到 scrollback
   │ │
   │ │ [终端显示 — 直接到 scrollback, 由 ChatInput 经 process.stdout.write 直写]
   │ │ 项目产品功能分析
   │ │
   │ ├─ text-delta: "### 核心功能\n\n1. 多模型支持..."
   │ │ → 累积至 300 字或下一个 \n\n → 继续 flush
   │ ├─ text-delta: "### 2. 智能工具调用\n..."
   │ ├─ ... (持续段落 flush，每段独立 scrollback 写入)
   │ └─ text-delta: "### 优化建议\n..."
   │
   └─ finishReason = 'stop' → break 退出循环

8. 回到 useAgent.submit()
   ├─ flushBuffer() // drain buffer 的最后一段残留到 messages
   │
   ├─ 安全网：若本轮 onTextDelta 从未触发
   │ → extractLastAssistantText(loopState.messages) 兜底取文本
   │ → 追加为 assistant message
   │
   ├─ setState({
   │ isLoading: false,
   │ currentToolCall: null,
   │ })
   │
   │ [终端最终显示 — 所有 message 已在 scrollback 里]
   │
   │ ❯ 帮忙分析一下项目产品功能以及优化点 ← user message (writeUserMessage)
   │
   │ ● Glob(\*_/_.{ts,tsx,json}) ← 工具调用历史 (formatToolCall)
   │ ⎿ 42 files matched (0.1s)
   │ ● Read(package.json)
   │ ⎿ 35 lines (0.0s)
   │ ● Read(packages/core/src/index.ts)
   │ ⎿ 120 lines (0.1s)
   │ ← AI 回复 (多段 flush 拼接)
   │ 项目产品功能分析 ← h2, bold + underline + accent blue
   │
   │ 核心功能 ← h3, bold
   │
   │ 1. 多模型 AI 对话 ← ordered list
   │ 支持 Anthropic, OpenAI, Google,
   │ DeepSeek 等多个 AI 服务商...
   │
   │ 2. 智能工具调用
   │ 13 个内置工具: 文件读写, Shell 执行,
   │ 代码搜索, 网络搜索...
   │
   │ 3. 知识管理系统
   │ - 分层知识加载 (全局/项目/本地)
   │ - AutoMemory 自动记忆
   │ - 会话持久化与恢复
   │
   │ ...
   │
   │ 优化建议
   │
   │ 1. 性能优化
   │ - 工具结果截断阈值可配置化
   │ - 流式刷新频率自适应
   │ ...
   │
   │ > █ ← ChatInput 重新可用
   │
   └─ 等待用户下一次输入

```

### AI 回复中可能的工具调用序列示意

对于"分析项目产品功能以及优化点"这类问题，AI 可能执行如下工具调用链：

```

Turn 1: AI 需要了解项目结构
├─ glob({ pattern: "\*\*/package.json" }) → 找到 monorepo 结构
├─ readFile({ filePath: "package.json" }) → 根 package.json
└─ listDir({ path: "packages" }) → 发现 cli/ 和 core/

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
┌─────────────┐ onSubmit  ┌──────────┐ submit() ┌────────────┐
│ ChatInput   │──────────>│   App    │─────────>│  useAgent  │
│ (cell buf)  │           │ (React)  │          │   (Hook)   │
└─────────────┘           └──────────┘          └─────┬──────┘
                                                      │ agentLoop()
                                                      v
                    ┌──────────────────────────────────────────┐
                    │          agentLoop (Core)                │
                    │                                          │
                    │  System Prompt Builder + Knowledge Loader │
                    │             │                            │
                    │             v                            │
                    │  streamText() (AI SDK)                   │
                    │    ├─ text-delta  ────────┐              │
                    │    └─ tool-calls ──┐      │              │
                    │                    v      │              │
                    │         processToolCalls()│              │
                    │         ├─ Permission     │              │
                    │         ├─ Execute        │              │
                    │         └─ Result         │              │
                    └────────────────┬──────────┼──────────────┘
                                     │          │
                                 callbacks  callbacks
                                     v          v
                    ┌──────────────────────────────────────────┐
                    │             useAgent (Hook)              │
                    │                                          │
                    │ onTextDelta   → useStreamBuffer          │
                    │   ├─ 每 delta: setStreamingText(完整行)  │
                    │   └─ \n\n 段落: appendMessage(rest)      │
                    │ onToolCall    → setState currentToolCall │
                    │                 + flushBuffer (drain)    │
                    │ onToolResult  → messages += tool summary │
                    │ onAskPermission → permissionQueue += ... │
                    │ onUsageUpdate → usage                    │
                    └─────────────────┬────────────────────────┘
                                      │ setState({...})
                                      v
                    ┌──────────────────────────────────────────┐
                    │  <ChatInput> useEffect (no deps, runs   │
                    │   every render). ONE synchronous block   │
                    │   wrapped in DEC 2026 BSU/ESU:           │
                    │                                          │
                    │   1. 检测 messages.length 增长           │
                    │      → eraseRegion() + writeMessageToStdout │
                    │        直接走 process.stdout.write          │
                    │        (user / assistant / tool call 条目   │
                    │        经 writeMessageToStdout 格式化, 落    │
                    │        入终端 scrollback)                    │
                    │                                           │
                    │   2. 构建 2D cell 网格 (frame):            │
                    │      [error] [streaming markdown 行]       │
                    │      [permission 块] [空行] [Thinking...]  │
                    │      [top sep] [input] [bottom sep]        │
                    │      [completions]                          │
                    │                                           │
                    │   3. Cell-level diff 对比 prevFrame,       │
                    │      只写差异 cell (一次 stdout.write)     │
                    │                                           │
                    │   4. \x1b7 保存光标 + \x1b[?2026l          │
                    └─────────────────┬────────────────────────┘
                                      │
                                      v
                    终端 scrollback (user/assistant/tool 消息) +
                    ChatInput 底部 cell buffer (实时 UI)

 Ink 动态区几乎一直是空 — 仅 <SelectOptions> (askUser 自由文本模式)
 会渲染内容；它激活时 ChatInput 的 `hidden=true` prop 会让出底部。
```

---

## 文件索引

| 阶段          | 文件                                    | 关键函数/组件                                                                     |
| ------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| CLI 入口      | `cli/src/index.ts`                      | `main()`, `checkNodeVersion()`, `loadEnvFile()`                                   |
| Ink 渲染      | `cli/src/app.tsx`                       | `startApp()`, `printExitSummary()`                                                |
| 根组件        | `cli/src/ui/components/App.tsx`         | `App`, `handleSubmit()`, `SLASH_COMMANDS`                                         |
| Agent Hook    | `cli/src/ui/hooks/use-agent.ts`         | `useAgent()`, `submit()`, `AgentState`                                            |
| Agent 循环    | `core/src/agent/loop.ts`                | `agentLoop()`, `runTurn()`, `compressMessages()`                                  |
| 工具执行      | `core/src/agent/tool-execution.ts`      | `processToolCalls()` — 权限检查 + write/shell 分发                                |
| 上下文窗口    | `core/src/agent/context-window.ts`      | `getCompressionThreshold()`, `estimateTokenCount()` + 模型/provider 表           |
| API 错误      | `core/src/agent/api-errors.ts`          | `classifyApiError()`, `isContextTooLongError()`, `extractHttpStatus()`           |
| Stream 工具   | `core/src/agent/stream-utils.ts`        | `StreamResult` 类型, `drainStreamResult()`                                        |
| System Prompt | `core/src/agent/system-prompt.ts`       | `buildSystemPrompt()`, `PLAN_MODE_PROMPT`                                         |
| 消息处理      | `core/src/agent/messages.ts`            | `userMessage()`, `toolResultMessage()`                                            |
| 计划模式      | `core/src/agent/plan-mode.ts`           | `ensurePlansDir()`, `generatePlanId(topic?)`, `getPlanPath()`                     |
| 工具注册      | `core/src/tools/index.ts`               | `toolRegistry`, `truncateToolResult()`                                            |
| 权限系统      | `core/src/permissions/index.ts`         | `checkPermission()`, `getPermissionLevel()`                                       |
| 知识加载      | `core/src/knowledge/loader.ts`          | `buildKnowledgeContext()`, AGENTS.md 向上遍历                                     |
| 会话持久化    | `core/src/knowledge/session.ts`         | `saveSession()`, `generateSessionSummary()`, `loadLatestSession()` (预留 history) |
| 自动记忆      | `core/src/knowledge/auto-memory.ts`     | `AutoMemory`, `initMemories()` — 4 类 taxonomy (user/feedback/project/reference)  |
| 项目初始化    | `core/src/knowledge/init.ts`            | `initProject()` — `/init` 命令入口，写 AGENTS.md 到项目根                         |
| 配置          | `core/src/config/index.ts`              | `loadConfig()`, `resolveModelId()`, `getAvailableProviders()`                     |
| Provider      | `core/src/providers/registry.ts`        | `createModelRegistry()`                                                           |
| 底部 UI       | `cli/src/ui/components/ChatInput.tsx`   | `ChatInput` — 整个底部区域唯一 owner: scrollback 提交 + cell-level diff 渲染 spinner/streaming/permission/error/输入框/补全菜单, DEC 2026 同步更新 |
| 输入 Hook     | `cli/src/ui/hooks/use-prompt-input.ts`  | `usePromptInput()`, bracketed paste + 30ms debounce fallback, `\r\n` 归一化       |
| 粘贴引用      | `cli/src/ui/paste-refs.ts`              | `formatPasteRef()`, `expandPasteRefs()`, `stripTrailingRef()`                     |
| 流式缓冲      | `cli/src/ui/hooks/use-stream-buffer.ts` | `useStreamBuffer()`, 每 delta 更新 streamingText (完整行), \n\n 段落边界提交到 messages |
| Stdout 写入   | `cli/src/ui/stdout-writer.ts`           | `writeMessageToStdout()`, user/assistant/tool 格式化 + ANSI + 行尾归一化          |
| 工具显示      | `cli/src/ui/tool-display.ts`            | `getToolLabel()`, `getToolInputPreview()`, `getToolResultSummary()`               |
| askUser UI    | `cli/src/ui/components/SelectOptions.tsx` | `SelectOptions` — 唯一仍走 Ink 渲染的动态组件（自由文本 "Other" 输入模式）        |
| Header        | `cli/src/ui/components/AppHeader.tsx`   | `printHeader()`, ASCII Logo                                                       |
| Markdown      | `cli/src/ui/render-markdown.ts`         | `renderMarkdown()`, marked lexer + chalk                                          |
| 主题          | `cli/src/ui/theme.ts`                   | `ACCENT`, `SUCCESS`, `WARNING`, `ERROR` 等 (对齐 Claude Code dark 配色)           |
