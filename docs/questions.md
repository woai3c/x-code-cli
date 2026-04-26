### 1. 什么时候需要压缩上下文，判断条件是什么

**触发点有四层**（都在 `core/src/agent/`）：

- **Light compaction（O(n) 预清理）**（`light-compact.ts`）：每轮真正调 LLM summary 之前先扫一遍消息，把"连续的 tool-call / tool-result 重复对"（典型如 shell quoting 错误后反复重试）就地剔除，不发 API、不掉关键内容。处理掉的纯水分通常就足够把 token 拉回阈值之下，省掉 expensive 的 summarize。
- **Proactive 预防式**（`loop.ts` 里的 `checkAndCompressContext()`）：每轮循环开头判断
  `state.lastInputTokens > threshold || estimateTokenCount(messages) > threshold`
  任一命中且 `messages.length > 6` 就先走 light compaction，仍超阈值再走 LLM summary。
  阈值 = `contextWindow * 0.8`（`context-window.ts` 的 `COMPRESSION_TRIGGER_RATIO = 0.8` + `getCompressionThreshold()`），contextWindow 按模型在 `MODEL_CONTEXT_WINDOWS` Map 里查（Anthropic 200k，GPT-4.1 约 1M，DeepSeek chat 64k…）。
- **Reactive 兜底**（`loop.ts` 里的 `handleContextTooLong()`，经 `api-errors.ts::isContextTooLongError` 统一模式匹配）：stream 抛错且匹配 "maximum context length" / "context_length_exceeded" / "token limit" / "prompt is too long" / "prompt_too_long" 之一，就立即压缩 + 不计这一轮、重试当前 turn。
- **手动**：用户输入 `/compact` 调 `compressMessages()`（`loop.ts`）。

**LLM summary 做什么**：保留最后 6 条消息（`KEEP_RECENT = 6`），把前面的用 `generateText` 做 summary，替换成一条 `[Previous conversation summary]` 系统消息。

两层检查各有分工：真 `lastInputTokens` 是上一轮 API 返回的真实值，最可信；`estimateTokenCount` 按 `CHARS_PER_TOKEN_ESTIMATE = 3.0` 保守估算，专门处理"单轮读了一个大文件、真 tokens 还没回来"的情况。压缩同时会写一份 SessionSummary 到 `.x-code/sessions/{sessionId}.json`（`knowledge/session.ts`），下次启动可恢复对话脉络。

---

### 2. 知识系统有哪些文件，优先级是什么

| 角色     | 路径                           | 写入方式                                   | 加载机制                                                                     |
| -------- | ------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| 项目说明 | 项目根 `AGENTS.md`             | 人写                                       | 每次 session 必加载；monorepo 从 cwd 向上遍历收集                            |
| 全局偏好 | `~/.x-code/AGENTS.md`          | 人写                                       | 每次 session 必加载                                                          |
| 本地偏好 | `.x-code/local/preferences.md` | 人写（gitignored）                         | 每次 session 必加载                                                          |
| 项目记忆 | `.x-code/memory/auto.md`       | AI 调 `saveKnowledge` 工具                 | 每次加载，90 天 TTL 自动驱逐（`auto-memory.ts::evict()` + `initMemories()`） |
| 全局记忆 | `~/.x-code/memory/auto.md`     | AI 调 `saveKnowledge` 工具（scope=global） | 同上                                                                         |

**加载顺序**（`buildKnowledgeContext` 的拼接顺序，`loader.ts`），后出现的在 prompt 末尾、模型权重更高：

```
1. Global Preferences     (~/.x-code/AGENTS.md)            人写，跨项目
2. Global Auto Memory     (~/.x-code/memory/auto.md)       AI 写，跨项目
3. Project AGENTS.md (.)  (项目根)                          人写
4. Project AGENTS.md (packages/x)   monorepo 子包（如有）   人写
5. Project Auto Memory    (.x-code/memory/auto.md)          AI 写
6. Local Preferences      (.x-code/local/preferences.md)    人写，gitignored
[可选] 7. Session Context — 上一次 session 的 SessionSummary（启动时通过 `options.sessionContext` 注入）
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

**只有三个工具走权限检查**（`tool-execution.ts::handleToolCall`）：`writeFile` / `edit` / `shell`。其它 8 个工具（readFile, glob, grep, listDir, webSearch, webFetch, askUser, saveKnowledge）在 `permissions/index.ts` 的 `rules` 表里全是 `always-allow`，根本不问。

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

`while (state.turnCount < options.maxTurns)` 循环（`loop.ts::agentLoop`），出口有这些情况：

1. **`finishReason === 'stop'`** —— AI 说完了，最常见的正常退出
2. **`finishReason === 'tool-calls'`** → `continue`，不是退出(`continuationAttempts` 归零,表示还在做事)
3. **`finishReason === 'length'`** —— 输出被 max_tokens 截断
   - `continuationAttempts < MAX_CONTINUATIONS(=3)` → push 续写 nudge,`continue`
   - 达到上限 → `onError('still truncated')` + `break`
4. **`finishReason === 'content-filter'`** —— 被 provider 审核拦截,`onError` + `break`
5. **`turnCount >= maxTurns`**（默认 100）—— while 条件假，退出后 agentLoop 末尾会上报 "Reached maximum turns"
6. **不可重试错误** —— `runTurn` 里 `streamText` / `streamChunksToUI` / `collectTurnResponse` 抛错后统一走 `classifyApiError`（`api-errors.ts`），除了 429 / timeout / ECONNRESET，其它一律 `break`（返回 `TurnOutcome: 'error'`）
7. **AbortSignal**（Ctrl+C）—— `options.abortSignal` 传给 streamText，触发后 stream 抛 AbortError，被当作不可重试错误 break
8. **Loop guard hard-stop** —— 同一 tool 调用同一 input 在滚动窗口内重复 5 次（`loop-guard.ts::HARD_LIMIT = 5`），`runTurn` 主动退出本轮并提示用户改 approach

所以答案：**主要是看 `finishReason`**(4 种取值各有不同处理),辅以 maxTurns 封顶、错误中断、取消信号、loop-guard 四条兜底。`length` 的自动续写是 x-code-cli 的显式设计——对齐 claude-code,避免让用户看到半句话就没了。

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

Claude Code 的解法是 vendor 一份自己的 Ink 分支加 grapheme-aware stringWidth + cell-level screen buffer。我们走混合方案：

1. **依赖换成 Google 维护的 `@jrichman/ink@6.6.9` fork**（Gemini CLI 生产在用）—— 通过 npm alias，`import from 'ink'` 代码不改。fork 自带 cell-level StyledLine 测量、DEC 2026 同步更新、IME 光标定位，从根上解决了 Yoga 宽度计算问题。
2. **`<ChatInput>` 进一步独占终端底部**，用 `process.stdout.write` + 2D cell-level diff 完全绕开 Ink 动态区。因为 fork 的 log-update 内部也会用 `\x1b7`/`\x1b8` 保存光标，终端只有一个 cursor 保存寄存器 —— 如果 Ink 动态区也写东西会跟我们抢这个寄存器留下残影，所以 Ink 动态区保持永远是空（除了罕见的 `<SelectOptions>`）。

所以"为什么要用它"的准确答案是：**Ink 底层就在用 Yoga，理解它的坑是为了知道为什么要绕开**。

---

### 8. /thinking 命令是怎么把 8 家厂商的"思考/推理"统一成一个开关的

我们支持的 8 家 provider 对"thinking / reasoning" 的开关参数完全不一致——Anthropic 用 `thinking: { type: 'enabled', budgetTokens: 8000 }`、Google 用 `thinkingConfig: { thinkingBudget: -1 }`、xAI / OpenAI o-series 用 `reasoningEffort: 'high'`、DeepSeek / Moonshot / Alibaba 各有自己的字段、Zhipu / Custom 干脆没开关。各家默认值也不一致：Gemini 2.5 Pro / Kimi K2.5 默认开，Claude Sonnet / DeepSeek V4 / Qwen Max 默认关。

`/thinking` 把这些差异收口成一个布尔值（`providers/thinking.ts::buildProviderOptions`）：

| Provider     | 开                                              | 关                                      |
| ------------ | ----------------------------------------------- | --------------------------------------- |
| anthropic    | `thinking: { type: 'enabled', budgetTokens }`   | `thinking: { type: 'disabled' }`        |
| google       | `thinkingConfig: { thinkingBudget: -1 }` (动态) | `thinkingConfig: { thinkingBudget: 0 }` |
| openai       | `reasoningEffort: 'high'` (仅 o-series)         | `reasoningEffort: 'minimal'`            |
| xai          | `reasoningEffort: 'high'` (仅 mini 系列)        | `reasoningEffort: 'low'`                |
| deepseek     | `thinking: { type: 'enabled' }` (仅 v4)         | `thinking: { type: 'disabled' }`        |
| moonshotai   | `thinking: { type: 'enabled' }`                 | `thinking: { type: 'disabled' }`        |
| alibaba      | `enableThinking: true`                          | `enableThinking: false`                 |
| zhipu/custom | (无对应参数，原样发送)                          | (无对应参数，原样发送)                  |

**用户接口**：

- `/thinking`（无参数）→ 弹 SelectOptions 选择器，显示当前状态
- `/thinking on|true|enable` → 全打开
- `/thinking off|false|disable` → 全关闭

**持久化**：写到 `~/.x-code/config.json` 的 `thinking: boolean` 字段，重启保持。

**实时生效**：`use-agent.ts` 用 `thinkingRef` 持有这个 flag，下一条用户消息发出去时 `runTurn` 现读现用，不需要重建 model。

---

### 9. 是否要支持 Skill 和 MCP Tool，目前的项目里已经有不少的 tool 工具了，这是不是就是 MCP tool，Skill 和 MCP tool 的功能是不是一样

先澄清三个概念：

| 名词          | 是什么                                                                                                                                | 本项目现状 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **内置 tool** | 项目里 11 个用 AI SDK `tool({ description, inputSchema, execute })` 定义的函数                                                        | ✅ 已有    |
| **MCP tool**  | Anthropic 推的 **Model Context Protocol** 规范的外部工具：独立进程（stdio / SSE）+ JSON-RPC 协议，第三方可以用任意语言实现工具 server | ❌ 未接入  |
| **Skill**     | Claude Code 的概念：`SKILL.md` + 可选脚本，预先注册一段 system-prompt 片段 + 触发条件，让用户定义"工作流"                             | ❌ 未接入  |

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

| 层级               | 位置                                                   | 内容                                                                                                                                        |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统 prompt 硬编码 | `core/src/agent/system-prompt.ts`                      | 身份、工具清单、`File Operations` / `Command Execution` / `Interaction` / `Security` / `Response Format` 五段规则、`Auto Memory Guidelines` |
| 权限规则（代码层） | `core/src/permissions/index.ts`                        | 11 个工具的 `always-allow` / `ask` / `deny` 分级                                                                                            |
| Shell 命令分级     | `core/src/tools/shell-utils.ts`                        | `isReadOnly` / `isDestructive` 判定                                                                                                         |
| 工具 description   | `core/src/tools/*.ts` 各文件                           | 每个工具 schema 里的自然语言说明                                                                                                            |
| 项目说明           | 项目根 `AGENTS.md`                                     | 团队共享的项目规范、技术栈、命令、约定、业务背景                                                                                            |
| 用户长期偏好       | `~/.x-code/AGENTS.md` / `.x-code/local/preferences.md` | 自由 markdown                                                                                                                               |
| 运行时学到的事实   | `.x-code/memory/auto.md` / `~/.x-code/memory/auto.md`  | AI 通过 `saveKnowledge` 工具写入                                                                                                            |

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

---

### 12. 优化 token 消耗

token 优化在四个层面同时发生：

1. **工具结果截断**（`tools/truncate.ts`）：单个工具输出超 `MAX_TOOL_RESULT_LINES` / `MAX_TOOL_RESULT_BYTES` 自动首尾各保留一半 + 中间标注 `[truncated N chars]`；同一轮多个工具结果聚合再卡 `MAX_AGGREGATE_TOOL_RESULT_BYTES`，防止 grep 一次返回几千行直接撑爆 turn。
2. **Loop guard 早停**（`agent/loop-guard.ts`）：滚动窗口检测 SHA-256(toolName+input) 重复——3 次软阻断（注入"换个思路"的 tool-result）、5 次硬退出。Doom-loop 是 token 消耗的大头，单 turn 里同一个 shell 重试 8 次、每次 10k tokens 是真有过的。
3. **Light compaction**（`agent/light-compact.ts`）：proactive 压缩前先 O(n) 扫一遍删掉重复的 tool-call/result 对，纯水分，不调 LLM。能解决的就不发 summarize 请求。
4. **Prompt cache**（`providers/cache-control.ts`）：给 Anthropic / 兼容 prefix-caching 的 OpenAI-compatible endpoint（DeepSeek / Moonshot / Alibaba）打 cache-control header，system prompt + 知识库这部分不变的内容下一轮命中缓存，input token 实际计费按 ~10% 收。`/usage` 命令的 cache hit ratio 就是看这个。

兜底是 §1 的 `compressMessages` 走 LLM summary——这步 expensive，所以前面三层都在尽量延缓它。

---

### 13. 支持多媒体文件(尤其是 deepseek)

**用户接口**（`agent/file-ingest.ts`）：消息里两种语法都识别——`@D:\path\to\file.png`（显式）或裸绝对路径 `/home/me/report.pdf`（必须带扩展名）。CLI 在 `extractAttachments` 阶段把它们替换成占位 token，再附在 `messages.ts::buildUserMessage` 里发给模型。

**分类与处理**：

| 类型               | 多模态 provider (Claude / GPT / Gemini / Grok / Kimi / Qwen / GLM) | DeepSeek / 自定义 OpenAI 兼容        |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------ |
| 文本 / 代码        | TextPart 内联，带行号                                              | 同左                                 |
| 文本型 PDF         | 本地 `pdf-parse` 抽文本（省 token）                                | 同左                                 |
| 扫描型 PDF         | 作为 `FilePart` 原生发给支持 filesApi 的 provider                  | 本地栅格化每页 → tesseract OCR       |
| docx / xlsx / pptx | 本地 `mammoth` / `xlsx` / `officeparser` 抽文本                    | 同左                                 |
| 图片 png/jpg/...   | `ImagePart` 多模态原生                                             | **vision-fallback** 子 agent（见下） |

**DeepSeek 的图片识别 — vision-fallback 子 agent**（`agent/vision-fallback.ts`）：

DeepSeek 官方 API 不支持视觉输入。`provider-compat.ts` 在打包 messages 之前会把所有 ImagePart 抽出来，对每一张：

1. 按优先级（google → zhipu → alibaba → openai → anthropic → moonshotai → xai）找用户配过 key 的多模态 provider
2. 用一个轻量视觉模型（默认 `gemini-2.5-flash` / `glm-4v-flash` 等）发起一次额外请求，prompt 让它输出"文字转录 + UI 布局 + 视觉细节 + 推断目的"
3. 把生成的描述拼回原 user message，DeepSeek 全程无感地"看到"图——终端会打一行 `⎿  Captioned image via google:gemini-2.5-flash` 提示
4. 描述按 `${modelId}:${fileSize}:${first-64-bytes-base64}` 缓存，一次 session 内同一张图不会重复调
5. 没配任何视觉 provider → 回退本地 `tesseract.js` OCR（仅取图中文字，weights 缓存到 `~/.x-code/tessdata/` 一次 7.6 MB 全局共享）

**已知能力上限**：caption 是单向文字描述，DeepSeek 没法对图反复追问（"左上角按钮什么颜色" 会失败）；复杂 UI 还原 / 像素级布局校验请直接 `/model` 切到 Claude / Gemini / GLM-4V。

---

### 14. 终端渲染区的问题和优化

参见 §7 关于 Yoga / `@jrichman/ink` fork / cell-level diff 的完整讨论。要点摘要：

- **问题源头**：Ink 上游 + Yoga 用 `string-width` 算 CJK / emoji / 零宽字符宽度算错 → 重绘 rewind 行数错位 → 抖动 / 残影 / 乱码
- **第一层修**：依赖 alias 到 `@jrichman/ink@6.6.9`（Gemini CLI 同款 fork），自带 grapheme-aware 测量、DEC 2026 同步更新、IME 光标定位
- **第二层修**：`<ChatInput>` 独占 stdout 底部区，自己维护 2D cell 网格，每帧 diff prev → 只 write 差异 cell，外层 `\x1b[?2026h` / `\x1b[?2026l` 包一次原子提交。Ink 动态区永远空（除了 `<SelectOptions>` 在弹选项时短暂使用）
- **第三层修**：streaming 文本走 `useStreamBuffer` 的段落级 flush（`\n\n` / 300 字符 / 5 行三选一），写到 cell buffer 时已经经过 `renderMarkdown` ANSI 化——视觉等价于"完整段落整段出现"，没有 "plain → markdown" 的二次刷新
- **第四层修**：消息提交到 scrollback 之前先 `eraseRegion` 擦自己的 frame，然后 `process.stdout.write(message)` 一次写完，最后立刻 redraw frame —— 整个序列在一对 BSU/ESU 同步更新里原子完成，外部观察不到中间态

剩下的修复是各种细节：DECSTBM 不动滚动区、debounce 只用于 paste（typing 立即响应）、bracketed paste mode 区分粘贴和键入、CJK 宽度的 viewport 折行、resize 事件后 redraw 整帧——参见 CHANGELOG v0.1.4 的 ~30 条 jitter 相关 fix。

### 15. 是否需要内置 rtk，内置 rtk 是否会导致 ai 回复失败或者有别的隐患 其他竞品有这样做吗

**结论：不建议内置 rtk**。理由如下。

#### rtk 是什么

[Rust Token Killer (rtk)](https://github.com/woai3c/rtk) 是个命令行 wrapper，把常见开发命令（git / cargo / pnpm / vitest / docker 等）的输出做**有损过滤**——按文件分组、去重、丢辅助行——把给人看的格式压成给模型看的紧凑格式，号称 60-90% token 节省。用法是命令前缀 `rtk`：

```bash
rtk git status         # 紧凑状态
rtk vitest run         # 只保留失败用例
rtk cargo build        # 按文件分组的警告
```

把它整合到 x-code-cli 的方式只有一种：在 `shell` 工具内部、调用真实命令前先尝试 `rtk <cmd>`，把 rtk 的输出当作工具结果返回给模型。

#### 隐患（按严重度排序）

**1. AI 拿到的是有损过滤后的输出，会丢调试关键信息**

rtk 的过滤规则是为人类阅读优化的：去重、分组、抹掉中间过程行。但 AI 在调试时往往**就是要看那些"无关"行**：

- 编译失败时，rtk 把多个相同错误合并成一条，但 AI 可能需要看完整的展开宏 / 模板实例化路径才能定位根因
- `git log` 紧凑格式丢掉作者 / 时间 / 父 commit，AI 没法做"这个 bug 是哪次 commit 引入的"分析
- `pnpm list` 树形结构压成 flat list，AI 没法判断"这个依赖是 transitive 还是直接依赖"
- `vitest run` 只保留失败用例——但 AI 要看通过的 setup 步骤判断"是 fixture 问题还是逻辑问题"

模型预训练时见的是**原始命令输出**，强行喂过滤过的格式会破坏分布。

**2. 替换原始 stdout 等于把工具失败的边角全擦掉**

rtk 自己也可能 panic（unsupported flag、版本错配、子命令解析失败），它的 fallback 是"原样透传"——但这套 fallback 不够鲁棒，已知会出现：

- rtk 不支持的子命令（比如 `git rerere` / `pnpm patch`）会被 rtk 拒掉而不是透传
- rtk 改写过的退出码可能和原命令不一致——shell 工具靠退出码判断"是否需要询问用户"会出错
- rtk 自己的 stderr（"command not recognized"）会污染工具结果

把这些当成 AI 看到的"shell 输出"会让模型反复 retry 一些已经成功的命令，触发 loop guard 硬退出。

**3. 平台兼容性**

rtk 是 Rust 写的，Windows / macOS x86 / macOS ARM / Linux x64 / Linux ARM 各要一份预编译二进制。x-code-cli 是 npm 包，要么：

- 在 npm 包里 bundle 多平台二进制（包体积膨胀几十 MB）
- postinstall 脚本下载——postinstall 在 CI 里经常被禁用
- 让用户手动装 rtk——又回到"为什么不让用户自己用"

主流 npm 工具链很少走"必须装 Rust 二进制"这条路，原因就是部署摩擦太大。

**4. 让模型看不到的输出 = 让用户看不到模型在看什么**

x-code-cli 的 UI 直接把 shell 命令的 stdout 透给用户看（`onShellOutput` callback）。如果中间夹一层 rtk，**用户看到的输出 ≠ 模型看到的输出**——出问题时用户没法 debug "AI 为什么这样判断"。透明度的损失比 token 节省更致命。

**5. 升级风险**

rtk 的过滤规则在演进，新版本可能改写更多内容。x-code-cli 一旦内置 rtk，每次 rtk 升级都要回归测试模型对各命令的反应。这是一笔持续的维护成本。

#### 我们已有的 token 优化手段更安全

x-code-cli 在不损失透明度的前提下已经做了四层防御（参见 §12）：

1. 工具结果截断（`truncate.ts`）：首尾保留 + 中间标注被截字符数，模型知道"这里有更多"
2. Loop guard（`loop-guard.ts`）：检测重复调用 → 提示模型换思路 → 5 次硬退出
3. Light compaction（`light-compact.ts`）：删除滚动窗口里重复的 tool-call/result 对
4. Prompt cache（`cache-control.ts`）：system prompt + 知识库不变的部分按 ~10% 计费

这四层都是**在我们控制范围内的、对模型透明的**——和 rtk 的"对模型不可见地改写命令输出"是两个完全不同的设计取向。

#### 竞品做法

| 项目           | 是否预处理 shell 输出 | 怎么做                                                         |
| -------------- | --------------------- | -------------------------------------------------------------- |
| Claude Code    | 不预处理              | 原样输出 + Bash 工具内置截断                                   |
| Codex CLI      | 不预处理              | 原样输出 + 输出超阈值时存临时文件返回引用                      |
| Gemini CLI     | 不预处理              | 原样输出 + ToolOutputDistillationService（LLM 二次摘要，可选） |
| opencode       | 不预处理              | 原样输出                                                       |
| **x-code-cli** | 不预处理（建议保持）  | 原样输出 + 截断 / loop guard / light compact                   |

**没有一家把外部 CLI 过滤器塞到 shell 工具里**。Gemini CLI 走得最远——加了一个 `ToolOutputDistillationService`，超阈值时再开一次 LLM 二次摘要——但这是**额外的 LLM 调用、对模型可见、可关闭**，不是悄悄替换。

#### 那 rtk 该怎么用

rtk 是给**人**用的工具：开发者自己在终端跑命令时套 `rtk` 前缀，看紧凑结果。x-code-cli 的用户如果同时是 rtk 用户，可以在自己的 prompt 里显式让模型 `rtk git status`——这是用户的选择，模型会知道这是 rtk 输出，按 rtk 的格式解读。

**不要把 rtk 内置成 shell 工具的隐式包装**，把选择权留给用户。

### 16. 如果用户的问题是中文 是不是可以让 AI 无论是输入输出和思考都使用中文 这样能节省 token 你觉得如何呢 这个方案有优缺点吗

**结论：不建议强制中文，但当前的"输出跟随用户语言"策略保持不变是对的**。"中文省 token" 是一个流行的误解，下面分维度分析。

#### 先破除"中文省 token"的迷思

直觉是"中文一个字密度大，应该省 token"。实测不是这样：

| 内容           | 字符数 | GPT-4 (cl100k) tokens | Claude tokens | DeepSeek tokens |
| -------------- | ------ | --------------------- | ------------- | --------------- |
| `Hello world`  | 11     | 2                     | 2             | 2               |
| `你好世界`     | 4      | 4                     | 4             | 3               |
| `implementation` | 14   | 1                     | 1             | 2               |
| `实现`         | 2      | 2                     | 2             | 1               |
| `function`     | 8      | 1                     | 1             | 1               |
| `函数`         | 2      | 2                     | 2             | 1               |

每个汉字基本是 1-2 token，**没有压缩优势**。少数情况下 DeepSeek 这类对中文优化过的 tokenizer 能做到 1 字 1 token，但仍不比英文常用词省。

整段对比更直观（同样语义）：

| 段落                                                              | 英文 tokens | 中文 tokens | 节省 |
| ----------------------------------------------------------------- | ----------- | ----------- | ---- |
| 一段 100 字的产品描述                                             | ~80         | ~70-90      | 0-10% |
| 一段 50 行的代码注释                                              | ~120        | ~110-130    | 0-10% |
| system prompt（工具说明 + 行为规则，~3000 token 英文）             | ~3000       | ~2500-2800  | 5-15% |

**结论**：中文相比英文最多省 5-15% token，没有数量级优势。而且这种节省只发生在**自然语言段落**——代码、文件路径、工具名、JSON 参数全是 ASCII，语言切换对它们零影响。

#### 实际 token 流向再算一笔账

x-code-cli 一轮典型对话的 token 分布（粗略估算）：

| 部分          | 占比      | 是否能换语言             |
| ------------- | --------- | ------------------------ |
| System prompt | 5-10%     | 可（但牺牲指令稳定性）   |
| 知识库 / AGENTS.md | 5-10% | 取决于用户写的语言       |
| 用户消息      | 1-5%      | 用户决定，不可控         |
| 工具结果（代码 / 文件 / shell 输出） | **60-80%** | **不可换**——本来就是英文 / 代码 |
| 模型输出      | 5-15%     | 已跟随用户语言           |
| 思考 / reasoning | 0-20%（仅 thinking 模型） | 可换，但有风险           |

**大头在工具结果**，它本身就是代码、文件内容、shell 输出——不可能让 git log 用中文打印。强制中文最多影响 system prompt + 思考 + 输出三块共 10-30% 的 token，假设节省 10%，整体节省 1-3%。**不构成数量级收益**。

#### 强制中文的具体代价

**1. 指令稳定性下降**

主流 LLM 的 instruction tuning 数据**英文比例远高于中文**。同一段系统指令：

- 英文："ALWAYS read a file before editing it"
- 中文："修改文件前必须先读取文件"

模型对前者的遵守率明显更高。这是 prompt engineering 社区共识——能用英文写 system prompt 就别用中文，**指令稳定性 > token 节省**。

**2. 思考链质量下降**

对于 thinking 模型（Claude extended thinking、DeepSeek-V4 thinking、Gemini 2.5 Pro thinking budget、o-series reasoning），强制中文思考的实测影响：

- 数学 / 逻辑推理：中文思考准确率下降（这些任务的 RL 训练数据英文为主）
- 代码相关：思考链里夹杂大量英文标识符，中英混合反而比纯英文更乱
- 长链条规划：模型有时会"翻译式思考"——先英文想一遍再翻成中文，反而**多花 token**

DeepSeek-V4 / Kimi-K2 这类对中文 RL 充分的模型影响小一些，但 Claude / GPT 系列影响显著。

**3. 中英混合反而更耗 token**

实际任务里强制中文会得到这种思考片段：

```
让我先看一下 packages/core/src/agent/loop.ts 里的 agentLoop 函数，
然后调用 readFile 工具读取它，看看 streamText 是怎么用的...
```

英文标识符 + 中文连接词来回切换，对 tokenizer 不友好（很多 BPE 在语言边界处会拆成更多 token）。**纯英文思考反而是 token 最优解**。

**4. 工具调用参数仍是英文**

Tool call 的 `toolName` / `inputSchema` 都是英文（`readFile` / `filePath` / `pattern`）——这是 OpenAI / Anthropic tool use 协议要求的。强制中文思考产生的混合内容在序列化时反而触发更多 BPE 边界。

**5. 用户场景多样性**

实际用户里：

- 部分用户用英文 prompt（习惯了 GitHub / StackOverflow）
- 部分用户用中文
- 部分用户混用（"重构 src/utils.ts 的 formatDate function"）

强制语言一刀切会破坏混用场景。当前的"输出跟随输入"策略是动态的、不破坏用户预期的最小干预。

#### 当前 x-code-cli 的策略

`packages/core/src/agent/system-prompt.ts`：

- **system prompt 英文**——指令稳定性优先
- **明确指示模型用用户语言回复**——`Respond in the same language as the user's most recent message`
- **不限制思考语言**——让模型按其 RL 训练默认值走（通常是 mirrors 用户语言或者英文）

这是一个权衡过的最优解：

- 牺牲了 system prompt 那 5-15% 的节省
- 换回了指令遵守率、思考链质量、用户体验

#### 真正的中文场景优化空间

如果用户基本用中文，可以做的优化（**不**靠"强制中文"实现）：

1. **`/lang zh` 配置**——用户主动声明偏好语言后，CLI 在 system prompt 末尾追加 "User prefers Chinese for explanatory text" 一行，模型会更稳定地输出中文。这是软提示，不破坏上述权衡。
2. **AGENTS.md 用中文写**——用户的项目说明用中文，模型按用户语言回复时也会跟随。这是当前已支持的（loader 不限制 AGENTS.md 语言）。
3. **错误消息本地化**——`api-errors.ts::classifyApiError` 返回的人类可读消息可以做 i18n。token 占比小，但用户体验会好。
4. **prompt cache 命中率最大化**——这是 token 节省的真正杠杆（参见 §12 第 4 项），节省比例可达 70-90%，远超语言切换的 5-15%。

#### 竞品做法

| 项目         | system prompt 语言 | 输出语言策略         |
| ------------ | ------------------ | -------------------- |
| Claude Code  | 英文               | 跟随用户语言         |
| Codex CLI    | 英文               | 跟随用户语言         |
| Gemini CLI   | 英文               | 跟随用户语言         |
| opencode     | 英文               | 跟随用户语言         |
| **x-code-cli** | 英文              | 跟随用户语言         |

**没有一家强制语言**——所有主流 Agent CLI 在这个问题上的选择都一致。这是经过工业级用户验证的默认值。

#### 一句话总结

中文省 token 是一个**幅度被高估、代价被低估**的优化方向。系统层面强制中文会拿稳定性和思考质量去换 1-3% 的 token，性价比极差。真正的 token 优化杠杆在 prompt cache、loop guard、light compact、工具结果截断这四层（见 §12），不在语言切换。

