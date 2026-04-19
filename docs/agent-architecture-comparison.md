# AI Agent CLI 架构对比分析

> 对比项目：x-code-cli、Claude Code、OpenAI Codex CLI、Gemini CLI

## 目录

- [一、Agent Loop 核心原理](#一agent-loop-核心原理)
- [二、AI API 调用位置](#二ai-api-调用位置)
- [三、Agent Loop 如何运转](#三agent-loop-如何运转)
- [四、循环何时停止、何时继续](#四循环何时停止何时继续)
- [五、架构详细对比](#五架构详细对比)
- [六、x-code-cli 可优化点](#六x-code-cli-可优化点)
- [七、架构复杂度总览](#七架构复杂度总览)

---

## 一、Agent Loop 核心原理

所有 AI Agent CLI 工具的核心都是**同一个模式**：

```
while (未结束) {
  response = callAI(messages, tools)    // 1. 发消息给模型
  if (response 包含 tool_calls) {
    results = executeTool(tool_calls)    // 2. 执行工具
    messages.push(results)              // 3. 结果塞回消息
    continue                            // 4. 再问一轮
  } else {
    break                               // 5. 模型说完了，结束
  }
}
```

四个项目**无一例外**都是这个循环。区别只在循环之外的"附加能力"（并发、缓存、压缩、检测等）。

### 为什么必须是这个模式？

因为这不是各家自己发明的，而是**由 AI API 的 tool use 协议决定的**。所有主流 AI API（Anthropic、OpenAI、Google）的设计都是：

```
请求:  { messages: [...], tools: [...] }
响应:  { content: "我需要读文件", tool_use: [{ name: "readFile", input: {...} }] }
                                        ↑ 模型在这里"停下来"等你执行

你执行完工具后:
请求:  { messages: [...之前的..., tool_result: { content: "文件内容..." }] }
响应:  { content: "看完了，再读另一个", tool_use: [{ name: "grep", ... }] }
                                                  ↑ 又停下来了

如此反复，直到模型不再调用工具，直接输出最终回答。
```

**模型不能自己执行代码。** 它只能说"我想调用 readFile"，然后停下来，等你把结果喂回去。所以必须有一个循环不断地：调 AI → 执行工具 → 喂结果 → 再调 AI。

就像所有 Web 服务器本质都是 `while(true) { conn = accept(); handle(conn) }` — 但 Nginx 和你手写的 HTTP server 性能差很多。差距不在循环，在循环里做了什么。

---

## 二、AI API 调用位置

| 项目            | API 调用位置                                                             | 调用方式            |
| --------------- | ------------------------------------------------------------------------ | ------------------- |
| **x-code-cli**  | `loop.ts::runTurn` (streamText) + `loop.ts::compressMessages` / `session.ts` (generateText) | Vercel AI SDK       |
| **Claude Code** | `services/api/claude.ts:1778` → `client.messages.create()`               | Anthropic SDK 原生  |
| **Codex**       | `client.rs:1360` → OpenAI `/responses` endpoint                          | Rust HTTP/WebSocket |
| **Gemini CLI**  | `geminiChat.ts:639` → `generateContentStream()`                          | Google GenAI SDK    |

x-code-cli 的 AI 调用只在 agentLoop 里：

- **主循环** `streamText()` — 核心对话
- **辅助** `generateText()` — 上下文压缩和会话摘要

---

## 三、Agent Loop 如何运转

以 x-code-cli 为例，当用户问 **"分析一下项目有什么功能"** 时：

### 第一步：用户输入 → 构建消息

```
用户输入文本 → useAgent.submit(text) → 添加到 messages 数组
```

### 第二步：构建 System Prompt

在 `packages/core/src/agent/system-prompt.ts` 中动态拼装系统提示词：

1. **你是谁** — "You are X-Code, an AI coding assistant"
2. **你有哪些工具** — readFile, glob, grep, shell, edit, writeFile...
3. **使用规则** — 先读再改、优先用专用工具而非 shell、读写权限模型
4. **项目上下文** — knowledge 文件、auto-memory、规则、上次会话摘要

这就是 AI 知道该怎么做的原因 — 不是硬编码的逻辑，而是 prompt 告诉它有哪些工具可用。

### 第三步：Agent Loop 核心循环

`packages/core/src/agent/loop.ts` 中的 `agentLoop()`：

```
while (turnCount < maxTurns) {
  1. 调用 streamText() 发送消息给 AI 模型
  2. AI 返回文本 + 工具调用
  3. 如果有工具调用 → 执行工具 → 把结果加回 messages → 继续循环
  4. 如果没有工具调用（AI 觉得够了）→ 结束
}
```

AI 模型会自主决定调用哪些工具。典型的调用序列：

```
Turn 1: AI 思考 → 调用 glob("**/*.ts") 找出项目文件结构
        ← 返回文件列表

Turn 2: AI 看到文件列表 → 调用 readFile("package.json") 了解项目配置
        ← 返回 package.json 内容

Turn 3: AI → 调用 readFile("packages/core/src/tools/index.ts") 看工具注册
        ← 返回工具定义

Turn 4: AI → 调用 grep("TODO|FIXME|HACK", "**/*.ts") 找优化点
        ← 返回匹配结果

Turn 5: AI 觉得信息够了 → 输出分析结论（纯文本，不调用工具）
        → 循环结束
```

### 第四步：streamText() 详解 — 发请求与收响应

`streamText()` 是 Vercel AI SDK 提供的函数，**它既发请求又收响应**，不是两个分开的步骤：

```typescript
result = streamText({
  model, // 用哪个模型
  system: systemPrompt, // 系统提示词
  messages: state.messages, // 对话历史
  tools: toolRegistry, // 工具定义（13 个工具的 name + description + inputSchema）
})
```

这一行等价于发送如下 HTTP 请求并打开一个流式连接：

```json
POST /v1/messages (以 Anthropic 为例)
{
  "system": "You are X-Code, an AI coding assistant...",
  "messages": [
    { "role": "user", "content": "分析一下项目有什么功能" }
  ],
  "tools": [
    {
      "name": "glob",
      "description": "Find files matching a glob pattern...",
      "input_schema": {
        "properties": {
          "pattern": { "type": "string", "description": "Glob pattern" }
        }
      }
    },
    { "name": "readFile", "description": "Read the contents of a file...", ... },
    { "name": "grep", "description": "Search file contents using regex...", ... }
    // ... 共 13 个工具定义
  ]
}
```

**工具定义在每一轮 API 请求中都会完整传递。** 模型看到 `tools` 数组中每个工具的 `description` 和 `input_schema`，就知道自己能用什么、怎么用。没有任何硬编码的路由逻辑，模型自己决定用哪些工具。

#### streamText 返回的是一个流对象

`result` 不是一个静态结果，而是一个**可遍历的流**：

```typescript
result = streamText(...)

// 逐 chunk 读取 AI 的流式响应
for await (const chunk of result.fullStream) {
  chunk.type === 'text-delta'   → AI 输出了一段文本
  chunk.type === 'tool-call'    → AI 要调用某个工具
  chunk.type === 'tool-result'  → 工具执行完毕，拿到结果
}

// 流结束后可以拿到汇总信息
await result.finishReason   → "tool-calls" 或 "end_turn"
await result.toolCalls      → 所有工具调用的列表
await result.response       → 完整的 assistant 消息
```

#### 流式处理的完整时序

```
streamText() 发出请求，打开流式连接
  │
  ├─ chunk: { type: "text-delta", text: "让我看一下项目结构" }
  │    → callbacks.onTextDelta() → 终端实时显示文字
  │
  ├─ chunk: { type: "tool-call", name: "glob", input: { pattern: "**/*.ts" } }
  │    → callbacks.onToolCall() → 终端显示 "○ glob **/*.ts"
  │    → AI SDK 内部发现 glob 有 execute 函数 → 立即自动执行
  │
  ├─ chunk: { type: "tool-result", content: "file1.ts\nfile2.ts\n..." }
  │    → callbacks.onToolResult() → 终端显示 "● glob **/*.ts ✓"
  │    → AI SDK 自动把结果写入 messages
  │
  ├─ chunk: { type: "tool-call", name: "readFile", input: { filePath: "src/index.ts" } }
  │    → 同上，AI SDK 自动执行
  │
  ├─ ... 更多 chunk ...
  │
  └─ 流结束
       → finishReason = "tool-calls"（还有手动工具要处理）
       或 finishReason = "end_turn"（AI 说完了）
```

### 第五步：两套工具执行路径

工具的执行分两个阶段，由不同的代码负责：

#### 阶段一：streamText 内部自动执行（流式阶段）

带 `execute` 函数的只读工具，AI SDK 在收到 `tool-call` chunk 时**立即在内部执行**：

- `glob`, `grep`, `readFile`, `listDir`, `webSearch`, `webFetch`
- 不需要权限检查，不经过 `processToolCalls`
- 结果作为 `tool-result` chunk 自动推入流中

#### 阶段二：processToolCalls 手动执行（流结束后）

没有 `execute` 函数的写操作工具，在流结束后由 `processToolCalls()` 串行处理：

- `writeFile`, `edit` → 需要权限确认 → `executeWriteTool()`
- `shell` → 需要权限确认 → `executeShell()`
- `askUser`, `enterPlanMode`, `exitPlanMode` → 特殊逻辑

```
工具类型          谁执行              何时执行              是否需要权限
─────────────    ──────              ──────               ──────
有 execute 的    AI SDK 内部          流式接收阶段           否（只读）
(glob/grep/      自动执行
readFile...)

没 execute 的    processToolCalls      流结束后              是（写操作）
(writeFile/      手动执行
edit/shell)
```

### 第六步：流式输出到 UI

整个过程实时渲染到终端：

```
❯ 分析一下项目有什么功能

  让我看一下项目结构                     ← text-delta chunk（实时显示）

● Glob(**/*.ts)                         ← tool-call chunk（进行中显示 Spinner）
  ⎿  42 files matched (0.1s)            ← tool-result chunk（执行完毕，显示摘要 + 耗时）
● Read(package.json)                    ← 又一个 tool-call
  ⎿  35 lines (0.0s)                    ← 执行完毕
● Grep(TODO|FIXME)
  ⎿  3 results (0.2s)

  这个项目是一个 AI 编码助手 CLI 工具，主要功能包括：  ← AI 最终输出
  1. 多模型支持...
```

### 完整数据流总图

```
用户输入 "分析项目功能"
  │
  ▼
useAgent.submit(text)
  │ messages.push({ role: 'user', content: text })
  ▼
agentLoop() ── while 循环开始 ──────────────────────────────┐
  │                                                         │
  ├─ buildSystemPrompt()                                    │
  │   拼装: 身份 + 工具说明 + 规则 + 知识上下文              │
  │                                                         │
  ├─ streamText({ model, system, messages, tools })         │
  │   │                                                     │
  │   ├─ 发送 HTTP 请求（携带完整 tools 定义）               │
  │   │                                                     │
  │   ├─ 接收流式响应                                       │
  │   │   ├─ text-delta → onTextDelta → 终端显示文字         │
  │   │   ├─ tool-call  → onToolCall  → 终端显示工具状态     │
  │   │   │               └─ 有 execute? → SDK 自动执行      │
  │   │   ├─ tool-result → onToolResult → 终端显示结果       │
  │   │   │               └─ SDK 自动写入 messages           │
  │   │   └─ ... 重复直到流结束                              │
  │   │                                                     │
  │   └─ 流结束，拿到 finishReason                           │
  │                                                         │
  ├─ finishReason === 'tool-calls'?                         │
  │   ├─ 是 → processToolCalls()                             │
  │   │       串行处理 writeFile/edit/shell（需权限）        │
  │   │       结果 push 到 messages                         │
  │   │       continue → 回到循环顶部 ─────────────────────→│
  │   │                                                     │
  │   └─ 否 → break → 退出循环                              │
  │                                                         │
  └────────────────────────────────────────────────────────┘
  │
  ▼
saveSession() → 保存会话摘要
返回 state → UI 显示最终结果
```

---

## 四、循环何时停止、何时继续

**完全由 AI 模型自己决定。**

模型每次响应都带一个 `finish_reason`：

```
finish_reason: "tool_calls"  → 我还需要执行工具，别停
finish_reason: "end_turn"    → 我说完了，停
```

x-code-cli 中的实际代码 (`loop.ts::agentLoop`)：

```typescript
if (finishReason === 'tool-calls') {
  // 模型说"我还要用工具" → 继续循环
  const toolCalls = await result.toolCalls
  // 执行工具...把结果塞回 messages...
  // continue → 下一轮循环
} else {
  // finishReason === 'end_turn' → 模型说完了
  // break → 退出循环
}
```

### 模型的决策过程

```
用户问: "这个项目有什么功能？"

模型想: 我还没看过代码 → 我需要工具
输出:   tool_use: glob("**/*.ts")
返回:   finish_reason: "tool_calls"    ← 有 tool_use 块，API 自动标记

--- 执行 glob，把文件列表喂回去 ---

模型想: 看到文件列表了，但还不够，要看具体代码
输出:   tool_use: readFile("src/index.ts")
返回:   finish_reason: "tool_calls"

--- 执行 readFile，把内容喂回去 ---

模型想: 够了，我能回答了
输出:   "这个项目是一个 CLI 工具，功能包括..."
返回:   finish_reason: "end_turn"      ← 没有 tool_use 块，API 标记为 end_turn
```

`finish_reason` 不是模型"主动选择"的字段，而是：模型输出了 `tool_use` 块 → API 标记 `"tool_calls"`，没输出 → 标记 `"end_turn"`。

### 所有项目的判断方式

| 项目            | 判断方式                                    | 代码位置      |
| --------------- | ------------------------------------------- | ------------- |
| **x-code-cli**  | `finishReason === 'tool-calls'`             | `loop.ts::agentLoop` |
| **Claude Code** | 检查响应中是否有 `tool_use` content block   | `query.ts`    |
| **Codex**       | `ResponseEvent::Completed` + 检查待执行工具 | `codex.rs`    |
| **Gemini CLI**  | `functionCalls` 是否存在于 response parts   | `turn.ts`     |

没有任何一个项目自己判断"该不该继续" — 全部委托给模型。唯一的例外是防护性措施：`maxTurns` 超限强制停止，防止模型无限循环。

---

## 五、架构详细对比

### 5.1 Agent Loop 设计

```
x-code-cli:     简单 while 循环，单层
Claude Code:     while(true) + async generator yield，单层但有流式工具执行器
Codex:          三层嵌套（submission_loop → run_turn → run_sampling_request），事件驱动
Gemini CLI:     四层嵌套（sendMessageStream → processTurn → run → makeApiCall），事件驱动
```

### 5.2 工具并发执行

| 项目            | 策略           | 细节                                        |
| --------------- | -------------- | ------------------------------------------- |
| **x-code-cli**  | 串行执行       | 工具逐个执行                                |
| **Claude Code** | 读写分离并发   | 只读工具最多 10 个并行，写工具串行          |
| **Codex**       | 读写锁并发     | `RwLock` — 并行安全的工具拿读锁，其他拿写锁 |
| **Gemini CLI**  | 调度器批量执行 | `Scheduler` 类，队列+事件驱动协调           |

### 5.3 上下文/Token 管理

| 项目            | 策略                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| **x-code-cli**  | 单一策略：超限时压缩（generateText 生成摘要，保留最后 6 条消息）            |
| **Claude Code** | **四层策略**：History Snip → Microcompact → Context Collapse → Auto Compact |
| **Codex**       | Pre-sampling compact + 上下文差异记录                                       |
| **Gemini CLI**  | Chat Compression Service + Agent History Provider + 溢出检测事件            |

### 5.4 Prompt Caching

| 项目            | 支持                                                         |
| --------------- | ------------------------------------------------------------ |
| **x-code-cli**  | 无                                                           |
| **Claude Code** | 多层缓存：全局缓存域 + 缓存断点 + 缓存编辑，1 小时 TTL       |
| **Codex**       | Sticky routing（`x-codex-turn-state` header 保持服务端状态） |
| **Gemini CLI**  | 依赖 Gemini API 内置缓存                                     |

### 5.5 流式工具执行

| 项目            | 策略                                                            |
| --------------- | --------------------------------------------------------------- |
| **x-code-cli**  | 等 AI 输出完毕后才执行工具                                      |
| **Claude Code** | `StreamingToolExecutor` — AI 还在输出时就开始执行已解析完的工具 |
| **Codex**       | 异步队列 `FuturesOrdered` — 工具边解析边执行                    |
| **Gemini CLI**  | 等一轮输出结束后批量调度                                        |

### 5.6 循环检测

| 项目            | 支持                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| **x-code-cli**  | 仅 maxTurns 限制                                                            |
| **Claude Code** | maxTurns 限制                                                               |
| **Codex**       | maxTurns + 重试上限                                                         |
| **Gemini CLI**  | **三重检测**：工具重复调用（5次阈值）+ 内容重复（10次）+ LLM 判断（30轮后） |

### 5.7 错误恢复与重试

| 项目            | 策略                                                            |
| --------------- | --------------------------------------------------------------- |
| **x-code-cli**  | AI SDK 内置 `maxRetries: 3`                                     |
| **Claude Code** | 自定义重试：最多 10 次，529 错误 3 次后切换备用模型，OAuth 刷新 |
| **Codex**       | 指数退避重试 + WebSocket → HTTP 降级                            |
| **Gemini CLI**  | 重试 + 无效流恢复（自动重新发送）+ 模型降级                     |

### 5.8 权限模型

| 项目            | 策略                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| **x-code-cli**  | 3 级：always-allow（只读）/ ask（写操作）/ deny（危险命令）                  |
| **Claude Code** | 多模式：default / plan / bypassPermissions / acceptEdits / auto（ML 分类器） |
| **Codex**       | Guardian 系统：调用 GPT 进行风险评分（<80 分自动通过）+ 沙箱 + 网络策略      |
| **Gemini CLI**  | 多层策略引擎：policy → approval mode → confirmation UI → sandbox expansion   |

---

## 六、x-code-cli 可优化点

按优先级排序：

### P0：工具并行执行

当 AI 一次返回多个工具调用时（比如同时读 3 个文件），当前是串行等待。

```typescript
// 当前：串行
for (const toolCall of toolCalls) {
  const result = await executeTool(toolCall)
}

// 优化：读写分离并行（参考 Claude Code）
const { readOnly, writeable } = partitionTools(toolCalls)
const readResults = await Promise.all(readOnly.map(executeTool)) // 并行
for (const tool of writeable) {
  await executeTool(tool) // 串行
}
```

### P1：流式工具执行

不要等 AI 全部输出完才执行工具。在 `fullStream` 循环中，遇到完整的 `tool-call` chunk 就立即启动执行：

```typescript
const pendingTools = new Map()
for await (const chunk of result.fullStream) {
  if (chunk.type === 'tool-call') {
    // 立即开始执行，不等后续 chunk
    pendingTools.set(chunk.toolCallId, executeTool(chunk))
  }
}
const results = await Promise.all(pendingTools.values())
```

### P2：渐进式上下文压缩

当前只有"满了就全压"。可以改进：

1. **裁剪老工具结果** — 早期的 glob/grep 结果用一句摘要替代
2. **保留最近对话完整** — 只压缩前面的轮次
3. **多阈值触发** — 70% 时轻压，90% 时重压

### P3：循环检测

参考 Gemini CLI，加工具调用重复检测：

```typescript
const recentToolCalls: string[] = []
// 每次工具调用记录 toolName + 关键参数的 hash
// 连续 5 次相同 → 注入 "你似乎在重复操作，请换个思路"
```

### P4：Prompt Caching

如果用 Anthropic 模型，Vercel AI SDK 的 `@ai-sdk/anthropic` 支持 `cacheControl`。系统提示词和工具定义加上缓存标记，多轮对话能省大量 token。

### P5：重试与降级

- 增加更细粒度的错误分类和重试策略
- 支持模型降级（主模型不可用时自动切换）

---

## 七、架构复杂度总览

```
简单 ◄──────────────────────────────────► 复杂

x-code-cli    Claude Code      Gemini CLI    Codex
   │               │                │           │
   ▼               ▼                ▼           ▼
 单层循环      单层+流式执行    四层事件驱动   三层+Rust异步
 串行工具      并发+缓存       调度器+检测    读写锁+Guardian
 单一压缩      四层压缩        多策略压缩     上下文差异
 ~2k行核心    ~10k行核心      ~8k行核心     ~15k行核心(Rust)
```

### 真正的差异在哪

不在循环本身，而在循环的"装饰"：

| 维度           | 本质                   | 各家差异点                  |
| -------------- | ---------------------- | --------------------------- |
| **调 AI**      | 都是发 HTTP 请求       | 缓存、重试、降级、WebSocket |
| **执行工具**   | 都是根据 name 分发执行 | 并行 vs 串行、流式启动      |
| **喂结果**     | 都是 push 到 messages  | 结果截断策略、摘要替代      |
| **判断结束**   | 都是看 finish_reason   | 循环检测、maxTurns          |
| **管理上下文** | 都是控制 messages 大小 | 压缩策略的精细程度          |

### 各项目关键文件索引

| 项目            | Agent Loop                         | API 调用                               | 工具系统                          | 权限                                    |
| --------------- | ---------------------------------- | -------------------------------------- | --------------------------------- | --------------------------------------- |
| **x-code-cli**  | `core/src/agent/loop.ts`           | 同左 (streamText)                      | `core/src/tools/index.ts`         | `core/src/permissions/index.ts`         |
| **Claude Code** | `src/query.ts`                     | `src/services/api/claude.ts`           | `src/Tool.ts` + `services/tools/` | `src/types/permissions.ts`              |
| **Codex**       | `codex-rs/core/src/codex.rs`       | `codex-rs/core/src/client.rs`          | `codex-rs/core/src/tools/`        | `codex-rs/core/src/guardian/`           |
| **Gemini CLI**  | `packages/core/src/core/client.ts` | `packages/core/src/core/geminiChat.ts` | `packages/core/src/scheduler/`    | `packages/core/src/scheduler/policy.ts` |
