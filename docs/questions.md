### 1. 什么时候需要压缩上下文，判断条件是什么

**触发点有三个**（都在 `core/src/agent/`）：

- **Proactive 预防式**（`loop.ts` 里的 `checkAndCompressContext()`）：每轮循环开头判断
  `state.lastInputTokens > threshold || estimateTokenCount(messages) > threshold`
  任一命中且 `messages.length > 6` 就压缩。
  阈值 = `contextWindow * 0.8`（`context-window.ts` 的 `COMPRESSION_TRIGGER_RATIO = 0.8` + `getCompressionThreshold()`），contextWindow 按模型在 `MODEL_CONTEXT_WINDOWS` Map 里查（Anthropic 200k，GPT-4.1 约 1M，DeepSeek chat 64k…）。
- **Reactive 兜底**（`loop.ts` 里的 `handleContextTooLong()`，经 `api-errors.ts::isContextTooLongError` 统一模式匹配）：stream 抛错且匹配 "maximum context length" / "context_length_exceeded" / "token limit" / "prompt is too long" / "prompt_too_long" 之一，就立即压缩 + 不计这一轮、重试当前 turn。
- **手动**：用户输入 `/compact` 调 `compressMessages()`（`loop.ts`）。

**压缩做什么**：保留最后 6 条消息（`KEEP_RECENT = 6`），把前面的用 `generateText` 做 summary，替换成一条 `[Previous conversation summary]` 系统消息。

两层检查各有分工：真 `lastInputTokens` 是上一轮 API 返回的真实值，最可信；`estimateTokenCount` 按 `CHARS_PER_TOKEN_ESTIMATE = 3.0` 保守估算，专门处理"单轮读了一个大文件、真 tokens 还没回来"的情况。

---

### 2. 知识系统有哪些文件，优先级是什么

| 角色 | 路径 | 写入方式 | 加载机制 |
|---|---|---|---|
| 项目说明 | 项目根 `AGENTS.md` | 人写 | 每次 session 必加载；monorepo 从 cwd 向上遍历收集 |
| 全局偏好 | `~/.x-code/AGENTS.md` | 人写 | 每次 session 必加载 |
| 本地偏好 | `.x-code/local/preferences.md` | 人写（gitignored） | 每次 session 必加载 |
| 项目记忆 | `.x-code/memory/auto.md` | AI 调 `saveKnowledge` 工具 | 每次加载，90 天 TTL 自动驱逐（`auto-memory.ts::evict()` + `initMemories()`） |
| 全局记忆 | `~/.x-code/memory/auto.md` | AI 调 `saveKnowledge` 工具（scope=global） | 同上 |

**加载顺序**（`buildKnowledgeContext` 的拼接顺序，`loader.ts`），后出现的在 prompt 末尾、模型权重更高：

```
1. Global Preferences     (~/.x-code/AGENTS.md)            人写，跨项目
2. Global Auto Memory     (~/.x-code/memory/auto.md)       AI 写，跨项目
3. Project AGENTS.md (.)  (项目根)                          人写
4. Project AGENTS.md (packages/x)   monorepo 子包（如有）   人写
5. Project Auto Memory    (.x-code/memory/auto.md)          AI 写
6. Local Preferences      (.x-code/local/preferences.md)    人写，gitignored
```

本质：**项目覆盖全局，monorepo 子包覆盖仓库根，本地覆盖项目**。

---

### 3. Monorepo 里怎么找 AGENTS.md

`loader.ts::collectAgentsMdChain` 从 cwd 向上遍历，每层检查是否有 `AGENTS.md`，遇到 `.git` 目录（含）或文件系统根停止。按 **root-to-leaf 顺序**拼接，深层内容排在后面，对模型权重更高。

在 `packages/frontend/` 启动时：

```
### Project AGENTS.md (.)                  ← 仓库根（通用约定）
### Project AGENTS.md (packages/frontend)  ← 子包（前端特有约定）
```

这样根 AGENTS.md 可以写"这个仓库用 pnpm + TypeScript"，`packages/frontend/AGENTS.md` 可以覆写"本包用 Vitest，其他包用 Jest"——两套同时生效，子包的更贴近当前任务。

---

### 4. 什么时候执行权限检查，是每次调用工具前先检查吗，如果是写权限就底部用户，同意后才继续执行，否则就一直挂着，这里逻辑在哪

**只有三个工具走权限检查**（`tool-execution.ts::handleToolCall`）：`writeFile` / `edit` / `shell`。其它 10 个工具（readFile, glob, grep, listDir, webSearch, webFetch, askUser, saveKnowledge, enterPlanMode, exitPlanMode）在 `permissions/index.ts` 的 `rules` 表里全是 `always-allow`，根本不问。

**流程**（`tool-execution.ts::processToolCalls`，串行，for 循环一个一个处理）：

```
for each tool call:
  if writeFile / edit / shell:
    approved = await checkPermission(toolCall, trustMode, callbacks.onAskPermission)
    if !approved: pushToolResult("Permission denied by user."); continue
  execute tool
```

`checkPermission`（`permissions/index.ts`）三级判定：

- `deny` → 直接返回 false（shell 有破坏性子命令，如 `rm -rf`）
- `always-allow` 或 `trustMode=true` → 直接 true
- `ask` → `await onAskPermission(toolCall)` 返回一个 Promise

Shell 权限级别按 command 字符串 memoize 在 `shellPermissionCache`（上限 256，FIFO 淘汰），相同命令重复调用时跳过 regex 判定。

**"挂着"的实现**在 `use-agent.ts` 的 callback 里（和 `pendingQuestion` 同一套模式）：`onAskPermission` 的实现是 `new Promise(resolve => setState(prev => ({ permissionQueue: [...prev.permissionQueue, { ..., resolve }] })))`，把 resolve 函数塞进 state。Permission 组件渲染 `queue[0]`，用户按 y/n 时调 `resolvePermission(approved)` → `pendingPermission.resolve(approved)` → 那边的 await 才返回 → agentLoop 才继续执行下一个工具。期间 ChatInput 是 disabled 的。

Shell 额外分级（`permissions/index.ts::evaluateShellPermission`）：`splitShellCommands` 拆 `&&/||/;`，**任一子命令破坏性 → deny**，**全部只读 → always-allow**，**混合 → ask**。

---

### 5. agentLoop 的结束条件是什么，是根据 AI 返回的结果来判断的吗

`while (state.turnCount < options.maxTurns)` 循环（`loop.ts::agentLoop`），出口有五个：

1. **`finishReason === 'stop'`** —— AI 说完了，最常见的正常退出
2. **`finishReason === 'tool-calls'`** → `continue`，不是退出
3. **`turnCount >= maxTurns`**（默认 100）—— while 条件假，退出后 agentLoop 末尾会上报 "Reached maximum turns"
4. **不可重试错误** —— `runTurn` 里 `streamText` / `streamChunksToUI` / `collectTurnResponse` 抛错后统一走 `classifyApiError`（`api-errors.ts`），除了 429 / timeout / ECONNRESET，其它一律 `break`（返回 `TurnOutcome: 'error'`）
5. **AbortSignal**（Ctrl+C）—— `options.abortSignal` 传给 streamText，触发后 stream 抛 AbortError，被当作不可重试错误 break

所以答案：**主要是看 `finishReason`**，辅以 maxTurns 封顶、错误中断、取消信号三条兜底。

---

### 6. flushBuffer 有什么用，为什么需要它

AI 流式返回的 text-delta 一个 chunk 可能只有 1-5 个字符。`flushBuffer`（`use-stream-buffer.ts` 里的 `useStreamBuffer` hook）是把 `bufferRef`（useRef，不在 React state 里）攒着的文本一次性推到 `messages`。

**为什么不每个 delta 都推**：

- **放 React state** → 每 delta 触发重渲染 → Ink 重绘动态区 → Ink 的 Yoga 布局算 CJK 宽度算错 → 光标 rewind 超调 → 旧内容被覆盖或新旧内容 splice 成乱码
- **每 delta 都 write 到 stdout** → 终端被打爆 + 和 Ink 动态区互相踩踏

所以策略是：**累积到一个合理边界再 flush**，触发条件三选一（`use-stream-buffer.ts::appendTextDelta`）：

- `buffer.includes('\n\n')` —— 段落自然断点
- `buffer.length >= 300` —— 字符硬顶
- `buffer.split('\n').length > 5` —— 行数软顶

外加两个强制 flush 点：工具调用前（保证文本先显示）、submit 收尾（drain 残留）。

视觉效果：用户看到的是段落一段段出现，不是逐字打字机——接近 Claude Code 的 UX。

---

### 7. 项目里经常提到的 Yoga 是什么，为什么要用它

**Yoga** = Facebook 开源的 C++ flexbox 布局引擎（Ink 内部依赖 `yoga-layout` npm 包）。Ink 用它算每个 `<Box>` / `<Text>` 占几列几行，好决定该把光标 rewind 多少行来重绘动态区。

**为什么项目总提它是因为要绕开它**：Yoga 用 `string-width` 算字符宽度，但 `string-width` 在某些 CJK / emoji / 零宽字符上会算错视觉行数。一旦算错：

1. Ink 下次重绘时 rewind 的行数不对
2. 新内容被打到错误位置，和旧内容 splice 成乱码
3. 这在 "streaming 长中文段落 + 动态区频繁重绘" 的场景里必现

Claude Code 的解法是 vendor 一份自己的 Ink 分支加 grapheme-aware stringWidth。我们这边选了更轻的方案：**消息历史用 `useStdout().write` 直接写 scrollback**（`MessageList.tsx`），让终端自己处理折行；Ink 动态区只留 spinner + 输入框 + 权限框这些短小 ASCII 内容，即使 Yoga 算错也影响不大。

所以"为什么要用它"的准确答案是：**不是主动选择用，是因为 Ink 底层就在用，我们需要理解它的坑才能绕开。**

---

### 8. Plan Mode 的进入条件是怎么判断的，plan mode 的名称能否根据问题来生成而不是用时间日期的格式

**进入条件** = AI 自己判断是否调用 `enterPlanMode` 工具。判断规则写在 `system-prompt.ts:27-42`：

**调用 plan**：新 feature、有多个方案、重构 / API 变更、多文件改动、需求不清需要先探索、需要用户权衡偏好。

**不调 plan**：单行修复、单函数、纯研究问题、明确简单的 bug 修复。

实际入口 `loop.ts:379`：AI 一旦发出 `enterPlanMode` 工具调用，`state.planMode = true`、生成 planId、`ensurePlansDir()`。后续每次 `buildSystemPrompt` 都会附加 `PLAN_MODE_PROMPT`（`system-prompt.ts:89`），限制 AI 只能用只读工具 + `writeFile` 写 `.x-code/plans/{planId}.md`。

**命名改进**：完全可以也应该改。当前 `generatePlanId()` 是 `new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)`（`plan-mode.ts:8`），形如 `2026-04-18T10-23-45` 确实难读。

两种可行做法：

1. **给 `enterPlanMode` 工具加一个 `topic` / `slug` 参数**（tool 定义在 `tools/enter-plan-mode.ts`，schema 里加一个 string 字段），AI 调用时传 `enterPlanMode({ topic: "refactor-auth-middleware" })`，planId 改成 `${date}-${slug}`，既有时间戳保序又有语义。
2. **进入 plan mode 后让 AI 先写一个 title 到 plan 文件开头**，退出时从文件里 grep 出来当归档名。

第一种改动更小，推荐。大约 5 行改动：工具 schema + `generatePlanId(slug?: string)` + `loop.ts:381` 传参。

---

### 9. 是否要支持 Skill 和 MCP Tool，目前的项目里已经有不少的 tool 工具了，这是不是就是 MCP tool，Skill 和 MCP tool 的功能是不是一样

先澄清三个概念：

| 名词 | 是什么 | 本项目现状 |
|---|---|---|
| **内置 tool** | 项目里 13 个用 AI SDK `tool({ description, inputSchema, execute })` 定义的函数 | ✅ 已有 |
| **MCP tool** | Anthropic 推的 **Model Context Protocol** 规范的外部工具：独立进程（stdio / SSE）+ JSON-RPC 协议，第三方可以用任意语言实现工具 server | ❌ 未接入 |
| **Skill** | Claude Code 的概念：`SKILL.md` + 可选脚本，预先注册一段 system-prompt 片段 + 触发条件，让用户定义"工作流" | ❌ 未接入 |

所以**内置 tool ≠ MCP tool**——它们只是"工具"这个抽象概念的两种实现：一种是进程内的 JS 函数，一种是跨进程的 JSON-RPC 服务。

**Skill 和 MCP 功能上也不一样**：

- MCP tool = **可执行能力的扩展**（连数据库、查 Slack、操控 K8s…），像"外部函数"
- Skill = **提示 + 触发模板**（预装"PR review 流程"、"security audit 流程"），像"宏"

打个比方：MCP 是 `npm install` 一个新库；Skill 是一个 `.md` 作为"角色扮演脚本"。

**建议**：

- **MCP 优先**。可以直接复用社区已经做好的几十个 server（GitHub / Slack / Notion / 数据库）。实现上 AI SDK 5 有原生 MCP client 支持，几十行代码就能把 MCP 注册为额外工具。
- **Skill 其次**。Agent Skills 是 Anthropic 发布的开放协议（SKILL.md + scripts/ + assets/），定位是"可复用的能力包"。对通用 CLI 短期收益低，等用户基数和使用模式清晰了再做。

---

### 10. 行为规则是什么，都定义在哪

**按作用域分层**，从"全场景恒定"到"任务临时"：

| 层级 | 位置 | 内容 |
|---|---|---|
| 系统 prompt 硬编码 | `core/src/agent/system-prompt.ts` | 身份、工具清单、`File Operations` / `Command Execution` / `Interaction` / `Security` / `Response Format` 五段规则、`Auto Memory Guidelines` |
| Plan mode overlay | `system-prompt.ts::PLAN_MODE_PROMPT` | 只读工具限制 |
| 权限规则（代码层） | `core/src/permissions/index.ts` | 13 个工具的 `always-allow` / `ask` / `deny` 分级 |
| Shell 命令分级 | `core/src/tools/shell-utils.ts` | `isReadOnly` / `isDestructive` 判定 |
| 工具 description | `core/src/tools/*.ts` 各文件 | 每个工具 schema 里的自然语言说明 |
| 项目说明 | 项目根 `AGENTS.md` | 团队共享的项目规范、技术栈、命令、约定、业务背景 |
| 用户长期偏好 | `~/.x-code/AGENTS.md` / `.x-code/local/preferences.md` | 自由 markdown |
| 运行时学到的事实 | `.x-code/memory/auto.md` / `~/.x-code/memory/auto.md` | AI 通过 `saveKnowledge` 工具写入 |

所以回答"行为规则是什么"要看你问的是**硬性代码约束**（权限层）还是**软性自然语言约束**（prompt 层）还是**用户自定义**（AGENTS.md / preferences / auto memory）。

---

### 11. Markdown 是怎么渲染的，用的什么库/工具，还是自己写的解析器和渲染器

**库 + 自研渲染器**：

1. 用 `marked` 的 **lexer**（`marked.lexer(text)`）把 markdown 解析成 AST token 树
2. 渲染器 `renderToken` / `renderTokens` **自己写**（`cli/src/ui/render-markdown.ts:53-239`），递归遍历 AST，用 `chalk`（24-bit 真彩色）把每个 token 转成 ANSI 字符串

**为什么不用 marked 自带的 renderer**：

- marked 默认 renderer 是输出 HTML，用不了
- `marked-terminal` 这类社区 terminal renderer 颜色不可控、缩进不可控，放进终端会丑
- 自己写 token→ANSI 能精准匹配项目主题色（h1 / codespan 用 `#d77757` Claude orange，code block 用 `#b1b9f9` 蓝紫等）、可控缩进、可控表格对齐

**一些细节**：

- `marked.use({ tokenizer: { del() { return undefined } } })`（`render-markdown.ts:27-33`）—— 禁用删除线 tokenizer，避免文件路径里的 `~` 被当 strikethrough
- 表格用 `padVisual` + `stripAnsi` 算可见宽度对齐（`render-markdown.ts:148-188`）
- 外层 try/catch（`render-markdown.ts:255-258`）—— 流式文本可能是半截的 markdown，lexer 偶尔抛错，直接 fallback 成原文，保证 UI 不崩
- h1 bold + underline + accent color、h2 bold + accent、h3+ 仅 bold（有视觉层级）

整个 renderer 大约 280 行，没有依赖 Chalk 外的重型东西。

