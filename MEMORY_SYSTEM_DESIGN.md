# x-code Memory v2 实施规格

> 状态：Implementation Ready
> 目标版本：一次性启用完整写入、存储、召回和诊断链路
> 代码范围：packages/core、packages/cli
> 数据范围：userXcodeDir()/memory

## 1. 交付约束

实现必须同时满足以下约束：

1. 只在根 agentLoop clean stop 后创建一次记忆任务。工具轮次、子 Agent、abort、error、content filter 和 length 截断不创建任务。
2. 主回答只等待任务文件原子落盘，不等待记忆模型。
3. 提取输入只包含本次 agentLoop 增量，不重复发送完整会话。
4. 自动记忆只有一个全局命名空间：userXcodeDir()/memory/topics。仓库信息通过 applies_to 标记，不再自动写项目级 memory。
5. Markdown 是记忆正文唯一真源。SQLite 不进入本次实现。
6. 新且证据更准确的事实替换旧事实；新旧值在同一事务内完成写入和物理删除。已确认错误的旧值不得归档为可召回内容。
7. 稳定 user、portfolio、feedback 事实不设 90 天 TTL。只有易变事实可以到期后变为 stale。
8. 新会话常驻加载小型 Core profile；详细 topic 按当前问题召回。
9. 动态召回内容不得逐轮改写 systemPromptCache。
10. topics、队列、索引、召回和诊断必须在同一个正式版本可用。

## 2. 磁盘布局

所有全局路径通过 userXcodeDir() 解析，禁止直接使用固定 USER_XCODE_DIR 做 I/O。

```text
<userXcodeDir>/memory/
  MEMORY.md
  topics/
    user-profile.md
    product-portfolio.md
    collaboration.md
    workflow.md
    references.md
    <topic-id>.md
  .state/
    schema.json
    jobs/
      pending/<job-id>.json
      running/<job-id>.json
      failed/<job-id>.json
    transactions/<transaction-id>/
      manifest.json
      staged/
      deletes.json
      MEMORY.md
      change.json
      COMMIT
      DONE
    changes/<generation>.json
    locks/
      extractor.lock
      writer.lock
    recent-runs.jsonl
```

文件职责：

- topics/\*.md：完整、可人工编辑的记忆正文，唯一真源。
- MEMORY.md：从 topics 确定性生成的 Core profile 和紧凑路由索引，可删除后重建。
- jobs：durable post-turn 队列。
- transactions：多 topic 原子写和崩溃恢复。
- changes：跨进程缓存失效和 attachment tombstone 信息，不含记忆正文。
- recent-runs.jsonl：不含正文的运行统计。

## 3. Markdown 数据格式

### 3.1 Topic frontmatter

```markdown
---
id: product-portfolio
type: portfolio
description: 用户长期维护的产品、仓库、高层技术栈和产品关系
summary: 用户长期开发 coding-agent 产品；详细仓库和技术信息按需召回
created_at: 2026-08-02T10:00:00.000Z
updated_at: 2026-08-02T12:00:00.000Z
status: active
keywords:
  - x-code
  - coding agent
  - TypeScript
aliases:
  - x-code-cli
  - x code
applies_to:
  - D:\res\x-code-cli
related:
  - collaboration
pinned: true
---

# Product portfolio

## x-code-cli

<!-- x-memory: {"id":"portfolio.x-code.identity","observedAt":"2026-08-02T11:59:58.000Z","evidence":"explicit","status":"active"} -->

- 用户开发的 coding-agent CLI，仓库位于 D:\res\x-code-cli。

<!-- x-memory: {"id":"portfolio.x-code.stack","observedAt":"2026-08-02T11:59:58.000Z","evidence":"observed","status":"active"} -->

- 高层技术栈为 TypeScript、Node.js 和 pnpm workspace。
```

Topic 类型固定为：

```ts
type MemoryType = 'user' | 'portfolio' | 'feedback' | 'workflow' | 'project' | 'reference'
type MemoryStatus = 'active' | 'stale'
type EvidenceKind = 'explicit' | 'validated' | 'observed'
```

字段规则：

- id：全局唯一安全 slug，必须与文件名一致。
- description：必填，用于说明何时应召回该 topic。
- summary：pinned topic 必填，最多 120 tokens。
- aliases、keywords：去重后排序，单项最多 80 字符。
- applies_to：canonical repository/path，只用于加权，不做硬过滤。
- related：只允许存在的 topic ID，最多 8 个。
- pinned：只有稳定、高频用户画像允许为 true。
- frontmatter status 是派生值：存在 active fact 即为 active；全部 fact stale 才为 stale。

### 3.2 Fact 规则

x-memory JSON 注释是事实的稳定主键和事实级元数据。

- id 表示 subject + predicate，不包含日期、随机值或事实值。
- 同一语义槽位修改时复用 id。例如技术栈从 TypeScript 改为 Rust，仍使用 portfolio.x-code.stack。
- observedAt 是原始用户陈述或工具证据发生时间，不是后台 job 执行时间。
- evidence 只能是 explicit、validated、observed。
- status 只能是 active、stale；可选 expiresAt 只用于易变事实。
- fact block 从 x-memory 注释开始，到下一个 x-memory 注释、同级或更高级标题、文件结尾之前结束。
- fact hash 只计算规范化正文，不包含注释元数据。只更新 observedAt 不改变 fact hash。
- 没有 x-memory 注释的人工正文可以检索，但自动写入器不得删除；用户明确指出并确认删除时除外。
- 重复 fact ID 使该 topic 校验失败，并禁止自动写入。

### 3.3 Core profile

MEMORY.md 由 memory-store 确定性生成：

```markdown
# Core profile

<所有 pinned topic 的 summary；总计不超过 800 tokens>

# Topic registry

- product-portfolio — 产品、仓库、技术栈；aliases: x-code, x-code-cli
- collaboration — 用户确认和纠正过的协作方式
```

约束：

- MEMORY.md 总计不超过 1,500 tokens 和 200 行。
- Core profile 只来自 active pinned topic。
- registry 按 pinned、updated_at、topic ID 确定性排序，在预算内输出。
- 完整 topic 集由内存索引维护，不依赖 registry 覆盖。
- MEMORY.md 文件头必须注明它是派生文件，人工修改会被覆盖。

## 4. 核心 TypeScript 类型

在 packages/core/src/knowledge/memory-types.ts 定义：

```ts
interface MemoryEvidence {
  kind: EvidenceKind
  sourceId: string
  occurredAt: string
  contentHash?: string
}

interface TopicMetadataPatch {
  type?: MemoryType
  description?: string
  summary?: string
  addKeywords?: string[]
  removeKeywords?: string[]
  addAliases?: string[]
  removeAliases?: string[]
  appliesTo?: string[]
  related?: string[]
  pinned?: boolean
}

type MemoryOperation =
  | {
      action: 'upsert'
      topicId: string
      factId: string
      expectedTopicHash?: string
      content: string
      evidence: MemoryEvidence[]
      topicPatch?: TopicMetadataPatch
    }
  | {
      action: 'replace-conflict'
      topicId: string
      factId: string
      expectedTopicHash?: string
      content: string
      remove: Array<{ topicId: string; factId: string; expectedTopicHash: string }>
      evidence: MemoryEvidence[]
      reason: string
      topicPatch?: TopicMetadataPatch
    }
  | {
      action: 'delete'
      remove: Array<{ topicId: string; factId?: string; expectedTopicHash: string }>
      evidence: MemoryEvidence[]
      reason: 'explicit-forget'
      topicPatches?: Array<{ topicId: string; patch: TopicMetadataPatch }>
    }

interface TurnMemoryProjection {
  userMessages: string[]
  assistantFinal: string
  events: Array<
    | { type: 'tool-call'; name: string; summary: string }
    | { type: 'tool-result'; name: string; status: 'ok' | 'error'; evidence: string }
  >
  changedFiles: string[]
  verification: string[]
  repositoryId: string
  turnStartedAt: string
  turnCompletedAt: string
}

interface MemoryJob {
  version: 2
  jobId: string
  sessionId: string
  turnStartMessageIndex: number
  modelId: string
  repositoryId: string
  cwd: string
  createdAt: string
  sourceOccurredAt: string
  attempt: number
  explicitMemoryIntent: boolean
  projection: TurnMemoryProjection
}
```

## 5. Post-turn 写入链路

### 5.1 agentLoop 接入

修改 packages/core/src/agent/loop.ts：

1. 函数入口、写入当前 user message 前记录 turnStartMessageIndex、turnStartedAt 和 filesModified 快照。
2. 仅 completedNormally、abortSignal 未取消、options.toolFilter 不存在时进入 post-turn。
3. 先 await flushPendingMessages(state)，确保 session JSONL 已落盘。
4. 从 state.messages 的 turnStartMessageIndex 到当前尾部构造 TurnMemoryProjection。
5. 调用 memoryService.enqueuePostTurnJob()；该调用完成任务文件原子落盘后返回。
6. agentLoop 随后返回；不得 await 提取模型或 topic 写入。
7. 当前父 turn 的 abortSignal 不传给后台 worker。job 使用独立 AbortController。
8. 删除现有 void runMemoryExtractor() 调用。

options.toolFilter 是现有代码中判定子 Agent 的权威信号。子 Agent 不创建 job。

### 5.2 增量投影

新建 packages/core/src/agent/post-turn-memory.ts。

投影只保留：

- 本次 agentLoop 中的真实 user message。
- 最终 assistant 文本。
- 工具名、确定性参数摘要、成功/失败状态。
- 与持久记忆有关的短证据：canonical path、package 名、命令退出码、验证结果。
- 本 turn 新增的 changed files。
- repositoryId 和绝对时间。

裁剪顺序：

1. 删除二进制、base64、图片和已激活 skill 正文。
2. 单个 tool result 限制 1,000 字符。
3. 单个文件正文不进入 projection，只保留路径和证据摘要。
4. 总输入限制 12,000 tokens。
5. 超限时依次保留 user 原话、最终回答、成功验证、失败结果、普通工具摘要。
6. projection 写 job 前执行 secret redaction。

确定性 gate 仅跳过问候、空回答和纯 slash 控制命令。出现“记住、以后、始终、不要再、我的产品、忘记”等表达时不得跳过。

### 5.3 Durable job store

新建 packages/core/src/agent/memory-job-store.ts。

状态转换：

```text
pending --claim(rename)--> running --success/no-op--> delete payload
                              |
                              +--retryable--> pending
                              |
                              +--terminal/max attempts--> failed
```

实现要求：

- jobId = sessionId + turnStartMessageIndex + projectionHash。
- enqueue 使用同目录临时文件、fsync（支持时）和原子 rename。
- 相同 jobId 已存在时返回 no-op。
- claim 使用 pending 到 running 的原子 rename。
- 全局 extractor.lock 使用 open(..., 'wx') 获取。
- lock JSON 保存 pid、hostname、startedAt、heartbeatAt。
- 每 5 秒刷新 heartbeat；进程不存在且 heartbeat 超过 30 秒才可回收。
- 每次启动扫描 running，回收 stale lease。
- retry 使用 2s、5s、15s、30s、60s、5m、15m、30m，并加入最多 20% jitter。
- 最大 8 次；schema 持续失败、模型不存在和损坏 job 进入 failed。
- 成功后删除 job payload，在 recent-runs.jsonl 记录 jobId、终态、耗时、token、operation 数和错误分类，不记录正文。

### 5.4 Worker 与模型选择

新建 packages/core/src/agent/memory-worker.ts。

- 同一进程一个 worker，多进程依赖 extractor.lock 保证单 worker。
- 按 createdAt、jobId 稳定排序处理 pending。
- job 的 modelId 是默认提取模型。
- memory.model 非 inherit 时优先使用配置模型。
- 配置模型不可用时回退 job.modelId；两者都不可用则 retry/failed。
- worker 每次完成后继续 claim，直到 pending 为空。
- CLI 优雅退出最多 drain 5 秒；未完成 job 留盘，下次启动继续。
- provider 凭据只从当前进程配置解析，不写入 job。

### 5.5 提取器

重写 packages/core/src/agent/memory-extractor.ts。

输入固定为：

1. 稳定 extractor system prompt。
2. MemoryJob.projection。
3. MEMORY.md。
4. 紧凑 fact registry：每项只含 factId、topicId、类型和一句事实摘要；总计最多 2,000 tokens，预算内发送全部，超限时保留同类型、exact/alias/entity 命中和最近更新项。
5. 最多 3 个本地检索命中的 topic。

输出必须是结构化 MemoryOperation[]，最多 8 个 operation，输出最多 1,500 tokens，无工具调用。

提取规则：

- 保存用户身份、能力、长期目标、语言/协作偏好。
- 保存用户拥有或长期维护的产品、仓库关系、高层技术栈和非显然架构原因。
- 保存用户明确纠正或确认的工作方式。
- 保存跨会话仍有价值的 workflow、project decision 和 reference。
- 不保存当前任务、普通 diff、临时报错、依赖清单、密钥和模型推断。
- 临时项目状态不保存；明确 deadline 或长期决策除外。
- inferred 内容不得持久化。
- 提取模型在同一次调用中使用 fact registry 做语义去重和槽位复用；不得为了查重再调用 selector、embedding 或第二次提取模型。
- 新 topic 必须给出 type、description、aliases 和 keywords。
- pinned 只允许 user、portfolio、feedback 中稳定且高频的事实。
- operations 为空是成功 no-op。

## 6. 冲突、更新和删除

### 6.1 稳定槽位索引

memory-index 必须维护：

```ts
Map<
  factId,
  {
    topicId: string
    sectionId: string
    factHash: string
    observedAt: string
    evidence: EvidenceKind
    status: MemoryStatus
  }
>
```

同时维护 topic aliases、subject token 和 predicate token，用于发现不同 ID 的疑似同槽位事实。

### 6.2 裁决规则

按事实类型执行：

1. 用户身份、偏好、产品归属、个人目标：最新明确用户陈述优先。
2. 当前代码、路径、命令、已发生项目状态：当前成功工具证据优先于旧 observed 事实。
3. 用户明确表达的未来计划不能被“代码尚未实现”的工具观察覆盖。
4. feedback：最新明确纠正优先于旧 validated 事实。
5. 同证据级别时，occurredAt 更新且来源可验证的一条优先。
6. 无法确认哪条准确时，不写新值、不删旧值；operation 记为 rejected warning。

提交约束：

- upsert 只创建新 fact，或在正文 hash 相同的情况下更新证据时间。
- 同一 factId 正文 hash 变化时，宿主强制转换为 replace-conflict。
- 新 operation 命中已有 factId 时，把该 ID 的所有位置加入 remove。
- subject/predicate 唯一对应另一 factId 时，规范化为已有 ID。
- subject/predicate 对应多个候选时拒绝该 operation，不追加第二次模型调用。
- 延迟旧 job 的 occurredAt 早于现有事实时，拒绝覆盖。
- replace-conflict 在一个事务中写新值并删除所有旧值。
- 删除后 topic 没有事实和人工正文时删除整个文件。
- pinned topic 被修改时必须同时提交基于剩余 active facts 的新 summary。
- 已替换或忘记的事实不保留 active/stale/archive 副本。
- stale 只用于“可能过期但尚未确认错误”的易变事实。
- 用户明确 forget 时物理删除；session transcript/privacy 删除是独立功能。

## 7. Markdown Store 与事务

### 7.1 模块

新建：

- packages/core/src/knowledge/memory-store.ts
- packages/core/src/knowledge/memory-transaction-store.ts
- packages/core/src/knowledge/memory-index.ts
- packages/core/src/knowledge/memory-redaction.ts

memory-store 负责 parse、validate、merge、生成 MEMORY.md 和调用 transaction store，不直接执行多文件裸写。

### 7.2 Writer lock

所有以下写入共享 writer.lock：

- worker 提交 operation。
- 显式 forget。
- /memory reload 对人工编辑的接管和派生索引重建。

锁内必须重新读取目标文件并验证 expectedTopicHash。不得使用进程启动时缓存的 topic 覆盖磁盘内容。

### 7.3 多文件事务

manifest 固定包含：

```ts
interface MemoryTransactionManifest {
  transactionId: string
  baseGeneration: number
  targetGeneration: number
  writes: Array<{ target: string; staged: string; previousHash?: string; nextHash: string }>
  deletes: Array<{ target: string; previousHash: string }>
}
```

提交顺序：

1. 获取 writer.lock。
2. 恢复所有有 COMMIT、无 DONE 的旧事务。
3. 读取 schema generation，固定 targetGeneration = baseGeneration + 1。
4. 计算所有 topic 最终内容、删除列表、MEMORY.md 和 change manifest。
5. 写入 transaction/staged、manifest、deletes、MEMORY.md、change.json。
6. 校验 staged Markdown、frontmatter、fact ID 唯一性、链接和 hash。
7. fsync staged 文件和事务目录（平台支持时）。
8. 原子创建 COMMIT。
9. 幂等应用 writes 和 deletes。
10. 替换 MEMORY.md。
11. 写 changes/<targetGeneration>.json。
12. 原子写 schema.json 为固定 targetGeneration；恢复时不得再次递增。
13. 写 DONE，删除事务目录，释放锁。
14. job 只有在第 12 步成功后才能完成。

Reader 协议：

1. 读取前确认没有 COMMIT 未 DONE 事务，记录 generation A。
2. 读取 topic/index。
3. 再检查事务目录并读取 generation B。
4. A != B 或出现未完成事务时丢弃结果并重试。
5. 恢复事务前必须先获取 writer.lock；普通 reader 不得无锁 replay。

change manifest 只保存：

```ts
interface MemoryChange {
  generation: number
  reason: 'upsert' | 'replace-conflict' | 'forget' | 'manual-edit'
  changed: Array<{ topicId: string; factId: string; previousHash?: string; nextHash: string }>
  deleted: Array<{ topicId: string; factId: string; previousHash: string }>
}
```

保留最近 256 个 generation。

### 7.4 人工编辑

- 不使用 fs.watch，不执行定时目录扫描。
- MemoryService.initialize() 在 CLI 启动时读取一次 topics 并建立索引；会话运行期间默认使用该快照。
- 用户直接编辑 topics 后，执行 /memory reload 或重启 CLI 才加载新内容。
- /memory reload 获取 writer.lock，重新解析全部 topics、比较 fact hashes、重建 MEMORY.md，并提交 manual-edit generation。
- frontmatter 或 fact ID 损坏的 topic 从活动索引隔离，在 /memory status 报错。
- 不得用旧内存副本继续召回损坏 topic。
- 不得自动覆盖用户编辑的正文。
- 重启会创建新的会话和 systemPromptCache，不存在当前会话缓存失效。/memory reload 只有在 pinned Core profile 变化时才设置 systemPromptCache=null；非 pinned 编辑不改 system prompt。若被编辑事实已经作为 attachment 注入当前会话，reload 会 tombstone 旧 attachment，下一次请求允许出现一次 message-prefix cache miss；尚未注入的 topic 不影响当前请求前缀。

## 8. 召回实现（Hybrid RAG）

召回和 post-turn 提取是两条不同链路：

```text
CLI 启动
  -> 本地读取 Markdown，建立内存索引                         0 token

用户问题
  -> 本地 exact/BM25F/alias/path 检索                       0 token
  -> 强匹配：读取命中 section，直接注入主模型               最多 4,000 tokens
  -> 模糊历史问题：AI selector 只看 topic manifest          最多 8,000 input + 256 output tokens
  -> selector 返回 topic IDs，本地再读取命中 section        最多 4,000 tokens

完整 agentLoop 结束
  -> 记忆提取模型读取本轮增量 + 紧凑索引 + 最多 3 个相关 topic
  -> 生成写入 operation；不读取整个记忆库正文
```

因此，大多数明确产品名、alias、路径和代码标识符查询只运行本地检索，不产生额外模型调用。只有本地无法确定、且用户确实在询问历史时才使用 AI selector。无命中时不加载详细 topic。

这里的 exact 和 BM25F 是词法检索，不是语义检索；完整链路仍属于 Hybrid RAG：

- Retrieval：exact/BM25F 本地检索，模糊历史问题增加 AI semantic selector。
- Augmentation：只读取选中 topic 的相关 sections 并注入 requestMessages。
- Generation：主 Agent 使用当前问题和选中记忆生成回答。

本版本不实现 embedding、向量数据库或向量索引。个人记忆规模下，semantic selector 已承担语义召回：它只读取紧凑 manifest，不读取全部正文；强词法命中时完全不调用。这样避免 embedding provider、模型维度、批量重建、增量删除同步和额外隐私边界。

根 agentLoop 在第一次 runTurn 前执行初始召回：用当前 user message、最近真实消息和 repositoryId 构造 RecallQuery，调用 memoryService.recall()，把返回 attachment 写入 LoopState。后续内部模型轮次复用同一 attachment；只有第 8.7 节定义的新工具实体可以触发一次 late-bound recall。

### 8.1 索引

memory-index 从所有有效 topic 构建内存索引。索引最小单元是 H2/H3 section 和其中的 fact block。

每个 topic 索引：

- id、type、description、summary。
- aliases、keywords、applies_to、related、pinned。
- topic status、updated_at、topic hash。
- section heading path、正文、token 估算。
- 每个 fact 的 ID、hash、status、evidence、observedAt、expiresAt。

generation 变化时重建。query LRU 最多 128 项，key 为：

```text
generation + normalizedQuery + repositoryId + recentContextHash
```

### 8.2 RecallQuery

新建 packages/core/src/knowledge/memory-retriever.ts。

```ts
interface RecallQuery {
  currentUserText: string
  recentConversationText: string
  repositoryId: string
  mentionedPaths: string[]
  identifiers: string[]
  explicitHistoryIntent: boolean
  explicitForgetIntent: boolean
}
```

构造规则：

- 当前 user message 完整参与，移除 skill XML 和大段粘贴正文。
- recentConversationText 只取最近 2 条 user message 和上一条 assistant final 的前 500 字。
- 路径统一为 POSIX 分隔符，同时索引完整路径和 basename。
- Unicode NFKC、英文 case-fold。
- 拆分 camelCase、PascalCase、snake_case、kebab-case 和点号限定名。
- 英文按词项索引；代码标识符同时保留原词和拆分词。
- 中文生成连续原句、2-gram 和 3-gram。
- 短查询不得跳过。

### 8.3 候选与排序

独立 route 并行执行，每路最多 20 个候选：

1. exact：topic ID、heading、alias、完整路径、basename、repository ID、错误码、代码标识符。
2. BM25F：id/title=6、aliases=6、keywords=5、description=3、heading=2、body=1；k1=1.2、b=0.75。
3. conversation：最近上下文解析代词和省略实体。
4. type intent：产品问题到 portfolio，协作纠正到 feedback/user，历史决策到 project/workflow，入口问题到 reference。
5. pinned：只作为低权重候选。

第一次融合后，对 top topic 的 related 做一跳扩展，最多增加 2 个候选。

融合使用：

```text
rrf(candidate) = sum(routeWeight / (60 + rank))
exact=4.0
BM25F=2.5
conversation=1.5
type=1.5
relationship=0.8
pinned=0.5
```

修正：

- 当前 repository 精确匹配 applies_to：+0.15。
- 当前消息精确出现 alias：+0.20，进入 protected set。
- explicitHistoryIntent 且类型匹配：+0.10。
- stale fact：乘 0.50；同槽位存在 active fact 时不进入正常候选。
- user、portfolio、稳定 feedback 不按年龄衰减。

选择规则：

1. 唯一 exact ID/title/alias/path 命中：直接选择。
2. 非 exact 候选至少由两个独立 route 支持、当前 query term coverage >= 0.60、top1 与 top2 RRF 差值 >= 0.02：本地选择。
3. explicitHistoryIntent 或存在候选但不满足第 2 条：调用 semantic selector。
4. 普通请求只有单个弱 route 时不注入详细 topic。
5. 无相关候选时注入空。

### 8.4 Semantic selector

新建 packages/core/src/knowledge/memory-selector.ts。

- 每个根 turn 最多调用一次。
- 输入只含 query、repository 和 topic manifest，不含 topic 正文。
- manifest 包含 id、type、description、aliases、keywords、applies_to。
- 输入最多 8,000 tokens；超限时保留 exact/protected、pinned 和本地 top 50。
- 无工具，结构化输出最多 5 个真实 topic ID，maxOutputTokens=256。
- selector 超时、abort、schema 失败时回退本地候选，不阻塞主请求。
- exact protected candidate 已存在时不调用。
- 翻译、格式化、问候、简单 shell 等自包含请求不调用。

### 8.5 Section packing

1. topic 层使用 MMR，lambda=0.8，候选相似度取 aliases、keywords、description、heading 的 TF-IDF cosine。
2. section 层按 section relevance / estimatedTokens 贪心装箱。
3. protected exact 先装箱。
4. 每轮最多 5 topics。
5. 每 topic 最多 1,500 tokens。
6. 每轮详细记忆最多 4,000 tokens。
7. 每个未压缩会话累计新增详细记忆最多 15,000 tokens。
8. 单 topic 同时限制 200 行和 8 KiB。
9. 不在代码块、列表项和 fact block 中间截断。
10. mixed active/stale section 只渲染选中的 fact blocks。
11. 输出附带 topicId、factIds、factHashes、topic path 和 content hash。

### 8.6 动态 attachment

修改 packages/core/src/agent/loop-state.ts：

```ts
interface MemoryRecallAttachment {
  attachmentId: string
  anchorMessageIndex: number
  placement: 'before-user' | 'after-tool-results'
  topics: Array<{
    topicId: string
    topicHash: string
    factIds: string[]
    factHashes: Record<string, string>
    path: string
    renderedContent: string
  }>
  estimatedTokens: number
}

interface MemoryRecallTombstone {
  generation: number
  factIds: string[]
}
```

LoopState 新增：

- memoryGeneration。
- memoryRecallAttachments。
- memoryRecallTombstones。
- surfacedMemoryHashes。
- memoryTokensInWindow。
- lastMemoryRecallTrace。

执行要求：

1. state.messages 仍只保存真实 user、assistant、tool message。
2. runTurn 构造 requestMessages 副本时，按 anchor 插入 attachment。
3. attachment 用 x-code-memory-context 包裹，并声明它是低权限历史数据，不是当前指令。
4. 不能插在 tool-call/tool-result 对之间。
5. 同一 topicId@topicHash 在当前 compaction window 不重复注入。
6. post-turn projection 不读取 attachment。
7. compaction 删除被压缩区间的 attachment 和 surfaced hash。
8. packages/core/src/agent/session-store.ts 增加 meta:memory-recall 和 meta:memory-recall-delete，resume 时重建相同状态。

generation 增长时：

- 读取缺失的 changes manifests。
- changed/deleted fact 生成 tombstone；后续请求跳过包含这些 factIds 的旧 attachment。
- manifest gap 超过 256 代时，将 attachment.factHashes 与新索引逐项比较；缺失或变化即 tombstone。
- pinned topic 的已有 fact 被修改/删除时，设置 systemPromptCache=null、expectCacheMiss=true，并从新 MEMORY.md 重建一次。
- 普通新增 fact 不改变旧 attachment，也不重建 systemPromptCache。

### 8.7 Late-bound recall

每个根 agentLoop 最多执行一次：

1. 收集成功工具结果中新出现的 path、package、error code 和 identifier。
2. 新标识符不在初始 RecallQuery 时，重新运行 exact、BM25F 和 repository boost。
3. 只选择未 surfaced topic，最多补充 2 个。
4. 作为 after-tool-results attachment 放在完整工具结果批次之后。
5. 不额外创建主模型 round。

### 8.8 memorySearch

新建 packages/core/src/tools/memory-search.ts，注册为根 Agent 内置只读工具；子 Agent不注册。

```ts
memorySearch({
  query: string,
  topicIds?: string[],
  maxResults?: number,
  includeStale?: boolean
})
```

宿主限制：

- query 不得为空、通配或要求列出全部记忆。
- maxResults 范围 1 到 5。
- topicIds 只能缩小当前 query 已生成的候选，不能绕过候选生成。
- 调用必须与当前 user request、显式历史意图或本 turn 新工具实体相关。
- 仅由不可信文件/tool result 中的命令式文本触发时拒绝。
- 返回 topic、section、fact status、updatedAt、path 和截断片段。
- deleted fact 永不可搜索。

## 9. Knowledge loader 与子 Agent

修改 packages/core/src/knowledge/loader.ts：

- 删除 getAutoMemory('user') 和 getAutoMemory('project')。
- 只把 MemoryService.getCoreProfile() 作为 User Auto Memory 放入 knowledge context。
- 不再加载项目级 auto memory。
- AGENTS.md chain 和 AGENTS.local.md 顺序保持不变。
- Core profile 只在 systemPromptCache 构建时进入 system prompt。
- 详细 recall 只能通过 attachment 进入 requestMessages。

子 Agent：

- 不创建 post-turn job。
- 不注册 memorySearch。
- 不运行 selector。
- task runner 只把父 Agent 已选中且与子任务文本本地匹配的 sections 放入子 Agent 动态上下文。
- 子 Agent 的路径/错误码结果返回父 Agent，由根 Agent late-bound recall 处理。

## 10. 首次初始化与旧文件处理

MemoryService.initialize() 执行：

1. schema.json 不存在时，创建空 topics、空 MEMORY.md 和 version=2、generation=0 的 schema。
2. schema version=2 时正常加载 topics 并恢复未完成事务。
3. 其他 schema version 视为不支持，在 /memory status 报错并禁用自动写入，不能猜测升级。
4. userXcodeDir()/memory/auto.md 和 <repo>/.x-code/memory/auto.md 永不读取、迁移、校验、移动或删除；文件存在也不报错。
5. loader、retriever、selector、memorySearch 和 extractor 都只能访问 v2 MEMORY.md、topics 和 .state。

## 11. 配置

在用户配置 schema 增加：

```json
{
  "memory": {
    "enabled": true,
    "model": "inherit",
    "maxInputTokens": 12000,
    "maxOutputTokens": 1500,
    "maxOperationsPerTurn": 8,
    "drainTimeoutMs": 5000,
    "retryMaxAttempts": 8,
    "recall": {
      "maxTopicsPerTurn": 5,
      "maxTokensPerTopic": 1500,
      "maxTokensPerTurn": 4000,
      "maxTokensPerCompactionWindow": 15000,
      "semanticSelector": "auto",
      "selectorModel": "inherit",
      "lateBoundRecall": true
    }
  }
}
```

正式发布 v2 后默认值即上表；开发中的未完成版本强制 enabled=false。动态配置值不得插入已缓存的 system prompt；MemoryService 在 turn 边界读取配置。

## 12. 代码改动清单

### 12.1 删除或替换

- packages/core/src/knowledge/auto-memory.ts
  - 删除 AutoMemory、parseMemoryFile、getAutoMemory 和 initMemories；不保留 legacy 运行时分支。
- packages/core/src/agent/memory-extractor.ts
  - 删除 transcript 尾窗、MIN_TRANSCRIPT_MESSAGES、scope 输出和直接 AutoMemory.add。
  - 改为 MemoryJob -> MemoryOperation[] 的纯模型调用。
- packages/core/src/agent/loop.ts
  - 删除 fire-and-forget runMemoryExtractor。
  - 接入初始 recall、late-bound recall、durable enqueue。
- packages/core/src/knowledge/loader.ts
  - 删除 project/user AutoMemory 读取。
  - 改为 Core profile。
- packages/core/src/types/index.ts
  - 移除旧 KnowledgeFact、MemoryWriteNotice scope 结构。
  - 导出新的公共类型；更新 API export snapshot。

### 12.2 新增 core 文件

```text
packages/core/src/
  agent/
    post-turn-memory.ts
    memory-job-store.ts
    memory-worker.ts
  knowledge/
    memory-types.ts
    memory-service.ts
    memory-store.ts
    memory-transaction-store.ts
    memory-index.ts
    memory-retriever.ts
    memory-selector.ts
    memory-recall-state.ts
    memory-redaction.ts
  tools/
    memory-search.ts
```

MemoryService 是唯一编排入口：

```ts
interface MemoryService {
  initialize(cwd: string): Promise<void>
  getCoreProfile(): string
  recall(query: RecallQuery, state: LoopState): Promise<MemoryRecallAttachment | null>
  lateRecall(signals: LateRecallSignals, state: LoopState): Promise<MemoryRecallAttachment | null>
  enqueuePostTurnJob(job: MemoryJob): Promise<'created' | 'duplicate' | 'skipped'>
  search(args: MemorySearchArgs, context: MemorySearchContext): Promise<MemorySearchResult[]>
  reload(): Promise<void>
  status(): Promise<MemoryStatusReport>
  shutdown(timeoutMs: number): Promise<void>
}
```

CLI 启动时创建一个 MemoryService，并通过 AgentOptions.memoryService 注入根 agentLoop。sub-agent runner 必须设置 memoryService: undefined。

### 12.3 CLI 改动

修改：

- packages/cli/src/ui/hooks/use-agent.ts
  - 启动时 initialize MemoryService。
  - 退出时调用 shutdown(5000)。
  - 将 memory operation notice 渲染为 Remembered、Updated、Forgotten 或 Memory failed。
- packages/cli/src/ui/components/App.tsx
  - /memory：显示 topic 摘要。
  - /memory status：显示 queue、worker、generation 和 invalid topics。
  - /memory search <query>：本地检索。
  - /memory search --semantic <query>：显式 selector。
  - /memory explain：显示最近一次 route、score、过滤和 token packing。
  - /memory reload：接管人工编辑并重建派生状态。

## 13. 测试清单

### 13.1 单元测试

新增测试文件：

```text
packages/core/tests/
  post-turn-memory.test.ts
  memory-job-store.test.ts
  memory-extractor.test.ts
  memory-store.test.ts
  memory-transaction-store.test.ts
  memory-index.test.ts
  memory-retriever.test.ts
  memory-recall-state.test.ts
  memory-search.test.ts
```

必须覆盖：

- clean root stop 只创建一个 job；sub-agent、abort、error、filter、length 不创建。
- 一句话明确 remember 不被 gate 跳过。
- 第 N turn projection 不含前 N-1 turn。
- job enqueue、duplicate、claim、retry、stale lease、failed。
- secret redaction 前后两次执行。
- topic/frontmatter/fact marker 解析和格式化 round-trip。
- fact ID 唯一、fact block 边界、人工无 ID 内容保护。
- 新 explicit 覆盖旧 explicit；成功 observed 覆盖旧 observed。
- 延迟旧 job 不得覆盖更新 observedAt。
- replace-conflict 跨 topic 删除；空 topic 删除。
- 已替换 fact 不存在于 topic、MEMORY.md、index、selector manifest 和 memorySearch。
- pinned summary 与 active facts 同步。
- targetGeneration 恢复幂等，DONE 前重复 replay 不重复递增。
- COMMIT 前、应用一半、MEMORY.md 后、schema 前、DONE 前崩溃恢复。
- 两个仓库并发写全局 topics 不覆盖。
- 启动加载和 /memory reload 接管人工编辑、损坏 topic 隔离、不复用旧缓存。
- 首次启动创建空 v2 目录；旧 auto.md 存在时不读取也不报错。
- Unicode、中文 n-gram、标识符、路径 normalization。
- exact、BM25F、conversation、type、relationship route。
- RRF、repository boost、stale filtering、MMR 和 token packing。
- selector 触发矩阵与失败回退。
- attachment anchor、tool pairing、resume、compaction、tombstone。
- generation gap 的 fact-hash fallback。
- memorySearch 拒绝空 query、通配、全量枚举和候选外 topic。

### 13.2 集成与回归

- 一个 agentLoop 内 1、5、20 个模型/工具轮次都只有一个 extraction job。
- 主回答只等待 job 文件落盘，不等待提取模型。
- print mode 退出后 pending job 可在下次启动处理。
- 仓库 B claim 仓库 A job 时仍使用 job.repositoryId/applies_to，不读取 process.cwd() 作为来源。
- 动态 attachment 不进入 post-turn projection。
- systemPromptCache 在普通 recall/update 时字节稳定。
- pinned fact replace/forget 产生一次预期 cache miss，后续稳定。
- tool-call/tool-result pairing 在 attachment 前后保持合法。
- API export snapshot 按预期更新。

### 13.3 Recall golden dataset

每个核心 topic 至少包含：

- 精确 ID 和 alias。
- 中文/英文语义改写。
- 完整路径、basename、package 和代码标识符。
- 跨仓库查询。
- 依赖最近上下文的代词查询。
- 工具执行后才出现标识符的 late-bound 查询。
- 相似 topic 消歧。
- 不少于正样本 50% 的无关负样本。
- replace/forget 前后索引快照。
- mixed active/stale section。

发布门槛：

| 指标                             |     要求 |
| -------------------------------- | -------: |
| exact/alias Topic Recall@5       |   >= 98% |
| 语义改写 Topic Recall@5          |   >= 92% |
| 跨仓库 Topic Recall@5            |   >= 95% |
| Section Recall@5                 |   >= 90% |
| 无关负样本不注入                 |   >= 90% |
| replaced/forgotten fact 召回泄漏 |       0% |
| 每轮新增详细记忆 token P95       | <= 4,000 |
| 500 topics 本地召回 P95          | <= 30 ms |
| 普通请求 selector 触发率         |    < 20% |

## 14. 发布门禁

Memory v2 只能在以下条件全部满足后默认启用：

1. pnpm typecheck、pnpm lint、pnpm test、pnpm build 全部通过。
2. 第 13 节测试和 golden dataset 门槛全部通过。
3. 首次启动能创建空 v2 存储；旧 auto.md 的存在不影响启动和写入。
4. /memory status 能区分 pending、running、failed、no-op、warning 和 success。
5. 正常退出、异常退出和多进程并发不丢 job、不重复写。
6. 用户产品、技术栈、偏好和跨仓库关系可以写入并召回。
7. 新且准确的事实提交后，所有可召回路径中的旧事实为零。
8. MEMORY.md 和 topics 可直接人工检查、编辑和复制。
9. 未完成任一存储、队列或召回链路时，memory.enabled 保持 false；不发布部分功能模式。
