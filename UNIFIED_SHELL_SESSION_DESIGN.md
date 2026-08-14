# Unified Shell Session 设计方案

> 状态：Draft v4 / 已按第三轮静态 review 修订，可进入实现前终审
>
> 目标版本：待定
>
> 参考实现：本地 `../codex-cli`，commit `fe614a6`
>
> x-code-cli 基线：commit `228434f`

## 1. 摘要

x-code-cli 已经通过 `shell({ runInBackground: true })`、`shellOutput` 和 `killShell` 支持显式后台
Shell，但它与 Codex CLI 的 unified exec 仍有明显差异：普通长命令不会自动转为后台会话、等待通过固定
间隔轮询完成、没有可交互 stdin/PTY、没有专用的后台终端 UI 事件和可靠的会话清理。

本方案建议保留现有 `shell`、`shellOutput`、`killShell` 工具名以兼容已有模型提示和代码，同时将底层
`BackgroundShellRegistry` 替换为统一的 `UnifiedShellSessionManager`，并由 manager 持有一套常驻的
`ShellSessionEventHub`：

- 所有未被 permission/special-command 层拦截的外部 Shell 进程通过同一个会话管理器启动。
- 普通命令先等待默认 10 秒；仍未退出时返回 `shellId`，进程继续运行。
- `shellOutput` 使用通知驱动的一次等待获取增量输出；内部不做固定间隔状态查询。
- stdout、root exit、tree exit 和失败先更新 session 状态，再通过带 generation 的 lifecycle signal 唤醒工具
  调用，并发布结构化领域事件。
- CLI 常驻订阅 Core 事件，root/tree 生命周期变化时无需等待模型再次调用 `shellOutput` 就能立即更新 TUI。
- 空输入等待通过 Core 事件驱动 TUI，显示 `Waiting/Waited for background terminal`。
- Esc 只中断当前 agent turn 或等待，不终止已经注册的后台进程。
- `/ps` 查看后台终端，`/stop` 终止后台终端。
- `/clear`、`/resume`、sub-agent 结束和 CLI 退出时可靠回收进程。
- 第一阶段保证 Windows、macOS、Linux 的非 PTY 行为一致；PTY/ConPTY 在后续阶段加入。

目标用户体验：

```text
shell("pnpm lint")
       │
       ├─ 10 秒内结束
       │      └─ 返回 output + exitCode
       │
       └─ 10 秒后仍运行
              ├─ 返回 shellId
              ├─ 进程继续运行
              └─ TUI 显示后台终端 footer
                         │
                         ▼
              shellOutput({ shellId })
                         │
                         ├─ TUI: Waiting for background terminal
                         ├─ await output/completion/deadline 通知
                         └─ 历史: Waited for background terminal · pnpm lint

              root process exit/close
                         │
                         ├─ root-exited（仍保留 tree target）
                         ├─ 任一平台启动 root-exited-residual termination flight
                         ├─ POSIX group / Windows Job Object 归零确认
                         │
                         └─ ShellSessionEventHub: exited
                                  ├─ lifecycleChanged 唤醒 pending shellOutput
                                  └─ 立即更新 footer + 完成摘要
```

## 2. 审核时需要确认的关键决策

以下决策会影响用户可见语义，建议在开始实现前明确批准或调整：

1. 普通 `shell` 不再使用默认 30 秒硬超时；改为默认等待 10 秒后返回 `shellId`。只有显式传入
   `timeout` 才表示硬运行上限。
2. 进程启动并注册后，Esc 只中断等待，不杀进程。终止进程使用 `/stop` 或 `killShell`。
3. 保留 `shellOutput` 名称，不新增 Codex 同名 `write_stdin`；功能语义与之对齐。
4. `shellOutput` 和 `killShell` 从 deferred tools 移到始终加载的核心工具集合。
5. 达到 64 个 live session 时拒绝新命令，不像 Codex 那样回收 live LRU，以避免静默杀死用户的 dev
   server。
6. 第一阶段只支持 pipe mode；完整 PTY 和 Windows ConPTY 作为独立阶段交付。
7. 后台会话只在当前 CLI 进程和当前 LoopState 内存中存在，不跨 CLI 重启、`/clear` 或 `/resume`
   恢复。
8. Core 必须提供常驻、强类型的 `ShellSessionEventHub`。禁止通过 `setInterval` 或循环 `setTimeout` 查询
   进程状态；deadline timer 只能作为一次等待的超时唤醒源。
9. 持久化的 `LoopState.sessionId` 只表示逻辑会话，不能作为运行时 manager 身份。每次创建/hydrate
   LoopState 都生成不持久化的 `managerInstanceId`；事件过滤、订阅绑定和 UI 去重必须同时使用它。
10. shell id 只保证 `bg_` 前缀，后半部分包含 manager generation 和计数器，不再承诺严格的 `bg_N`。
11. POSIX process group 与 Windows Job Object supervisor 属于第一阶段正确性要求；`taskkill /T` 只能作为有全局
    deadline 的 emergency fallback，不能提供 tree-confirmed 结论。PTY/ConPTY 不负责补救进程树清理。
12. `yieldTimeMs: 0` 是 x-code-cli 的 immediate sentinel，在任何 clamp 之前解析；Windows 10 秒 floor 不影响
    显式后台兼容路径。
13. `shellOutput` 和 `killShell` 都是已有 shell 的 transport：不触发自己的 Pre/Post hooks，但可以原子提交
    原始 `shell` 的最终 PostToolUse。
14. sub-agent 的 tool allowlist 对 `shell` 做 transport dependency closure，自动包含 `shellOutput` 和
    `killShell`；显式 deny 与该依赖冲突时配置必须 fail closed。
15. root process exit 与 managed tree exit 是两个状态；只有 `treeConfirmedExited` 后才能移除 shutdown target、
    resolve completion 或发布 terminal `exited`。
16. Windows 若没有“创建 suspended root → assign Job Object → resume”的可靠 provider，unified shell 功能不得以
    “三平台无 managed descendants”名义发布；本方案选择把该 provider 作为阶段一 gate。
17. spawn 分成同步 `handleAttached`、异步 `spawnReady` 和显式 `activate()`。正常 session 只有 provider ready、
    manager 提交 running/`started`、再 activate 后才能向模型返回 shell id；ready failure 仅在 cleanup 无法确认时
    作为安全例外暴露可管理的 residual id，绝不能返回 terminal 又隐藏 live target。
18. `start()`、`interact()` 和 tool-facing terminate 返回带 `FinalObservationLease` 的判别联合；dispatcher 在写入
    匹配 tool result 后调用 `ack()`，异常时调用 `release()`，manager 不接触模型 transcript。
19. 一次性 `managerDraining` Promise 改为带原因和 generation 的 `lifecycleChanged` signal；draining、
    termination-failed 和 completion 都有显式分支，禁止 resolved-Promise busy-loop。
20. shell Pre 前捕获不可变 Hook registry snapshot/generation，最终 Post 必须使用同一 snapshot；refresh 只影响
    后续新 command。
21. EventHub 的 output 队列使用明确的 byte/event cap、只淘汰 output delta 的算法和有界 recent-output snapshot；
    控制事件永不因 noisy output 丢失。
22. 任一平台收到 root exit 且 tree 非空时都启动同一个 single-flight
    `terminateTree('root-exited-residual')`；Windows 最终用 `TerminateJobObject()` 并等待 `tree-empty`。
23. initial `start()` wait 与 `shellOutput` 共用 lifecycle-aware observation loop；manager draining、termination failure、
    completion、abort 和 deadline 都是显式唤醒分支。
24. `outputFinalized` 只可由全部 stream EOF，或 tree confirmed 后 trailing grace 到期触发；tree live 时不能因静默
    50–100ms 提前关闭 decoder。
25. POSIX `SIGHUP` 进入与 SIGTERM 相同的 graceful shutdown coordinator；仅 SIGKILL、断电等不可捕获终止属于保证
    边界之外。

## 3. 背景和参考实现

### 3.1 Codex CLI

Codex 的 unified exec 并不要求模型提前判断命令是否应在后台执行。所有命令先通过同一套
`UnifiedExecProcessManager` 启动：

1. `exec_command` 默认等待 10 秒。
2. 进程在初始等待开始前写入 process store。
3. 命令在等待窗口内退出时直接返回退出码和输出。
4. 命令仍存活时返回 session id。
5. 模型随后通过 `write_stdin` 发送输入或使用空输入等待输出。
6. TUI 通过独立的 process begin/output/end 和 terminal interaction 事件跟踪运行状态。

参考文件：

- `../codex-cli/codex-rs/core/src/tools/handlers/shell_spec.rs`
- `../codex-cli/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs`
- `../codex-cli/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs`
- `../codex-cli/codex-rs/core/src/unified_exec/process_manager.rs`
- `../codex-cli/codex-rs/core/src/unified_exec/process.rs`
- `../codex-cli/codex-rs/core/src/unified_exec/head_tail_buffer.rs`
- `../codex-cli/codex-rs/core/src/unified_exec/async_watcher.rs`
- `../codex-cli/codex-rs/tui/src/chatwidget/command_lifecycle.rs`
- `../codex-cli/codex-rs/tui/src/history_cell/exec.rs`
- `../codex-cli/codex-rs/tui/src/bottom_pane/unified_exec_footer.rs`

Codex 中与本方案直接相关的参数和限制：

```text
initial exec default yield       10,000 ms
initial exec range               250–30,000 ms
Windows initial yield floor      10,000 ms
empty write_stdin minimum         5,000 ms
background poll maximum         300,000 ms
non-empty write maximum          30,000 ms
retained output                   1 MiB
maximum process entries              64
```

Codex 对等待的实现不是每隔固定时间检查一次状态，而是等待 output notify、exit token、deadline 或暂停状态
变化。输出到达会唤醒并 drain 缓冲区，但只要进程仍在运行且 deadline 未到，等待会继续，从而减少模型反复
poll 的次数。

Codex 实际上有两条互补的通知路径：

1. **进程内唤醒**：`output_notify`、`output_closed_notify` 和 cancellation/exit token 唤醒当前正在等待的
   `write_stdin`；`collect_output_until_deadline()` 使用 `select` 等待这些信号和单次 deadline，不做周期查询。
2. **领域事件推送**：独立 async watcher 持续发布 `ExecCommandOutputDelta`，进程结束后只发布一次
   `ExecCommandEnd`；`TerminalInteraction` 描述等待或输入交互，TUI 直接消费这些事件。

因此“进程结束了发事件”和“模型通过工具读取最终结果”是两件事：前者立即刷新 TUI，后者在已有等待调用中
立即完成，或由模型下一次调用取得最终 tool result。Codex 不会为了通知模型而在任意时刻异步插入一条 tool
result；x-code-cli 也应保持这个协议边界。

### 3.2 x-code-cli 当前实现

当前后台 Shell 由以下文件实现：

- `packages/core/src/tools/background-shell.ts`
- `packages/core/src/tools/shell.ts`
- `packages/core/src/tools/shell-provider.ts`
- `packages/core/src/agent/tool-execution.ts`
- `packages/core/src/agent/loop-state.ts`

当前能力：

- `shell({ runInBackground: true })` 立即返回 `bg_N`。
- stdout/stderr 合并到一个 1 MiB ring buffer。
- `shellOutput` 使用 moving cursor 返回新增输出。
- `shellOutput({ block: true })` 可以等待退出或 timeout。
- `killShell` 可以调用 execa `kill()`。
- registry 绑定到 LoopState，不同 agent 不能访问彼此的 shell id。

现存问题：

- 普通 `shell` 仍由 execa 等待至退出，默认 30 秒 timeout 会终止长命令。
- 后台模式依赖模型主动设置 `runInBackground`。
- `shellOutput` 每 200ms 检查一次 `entry.status`。
- 没有等待通知、interaction lock 或 trailing-output flush。
- 没有 stdin/PTY。
- 进程退出后条目不会自动删除。
- 没有活跃会话数量限制。
- `/clear` 和 `/resume` 直接丢弃旧 LoopState，旧进程只能等待 30 分钟 timeout 或 CLI 退出。
- sub-agent 完成时没有显式清理其后台进程。
- `shellOutput` 和 `killShell` 可能处于 deferred 状态，模型收到 shell id 后不一定能立即调用。
- 注释中的 “detached” 与实际实现不一致；当前 `ShellSpawnOptions` 没有 `detached`。
- `proc.kill()` 不能在全部平台上保证终止 Shell wrapper 的完整子进程树。
- 字符串 ring trim 没有输出省略标记，也没有可靠记录被丢弃的字节数。

现有 `packages/core/tests/background-shell.test.ts` 的 5 个集成测试可以验证 spawn、buffer、drain、kill 和
id 分配，但尚未覆盖 agent tool handler、abort、hooks、UI、`/clear`、`/resume` 或跨平台进程树。

## 4. 目标与非目标

### 4.1 必须实现

- 普通长命令超出 yield 时间后自动转为后台会话。
- 后台进程跨 agent turn 存活。
- 事件驱动的输出等待。
- shell id、增量 drain、退出码和输出省略信息。
- Esc 中断等待但保留进程。
- 空输入等待的专用 Waiting/Waited TUI。
- 后台进程 footer、`/ps`、`/stop`。
- `/clear`、`/resume`、sub-agent 结束和 CLI 退出时清理。
- POSIX process group / Windows Job Object process tree 的 grace + force termination，并报告部分失败。
- root exit 与 tree-confirmed exit 独立建模；普通同组/job child 不能因 root 先退出而逃逸。
- 输出、进程数量和已完成条目的资源限制。
- 权限、authority、hooks 和 tool-call/result 顺序正确。
- system prompt 和工具 schema 保持 byte-stable。
- Windows、macOS、Linux 的非 PTY 行为一致。

### 4.2 后续 PTY 阶段

- PTY。
- 对交互式程序写 stdin。
- Windows ConPTY。
- Ctrl+C 等终端控制输入。

### 4.3 非目标

- 后台进程跨 CLI 重启恢复。
- tmux/screen 式持久终端。
- Codex 的远程 exec-server。
- 完整复制 Codex sandbox、网络代理和权限提升体系。
- 在 system prompt 中动态插入运行中的进程列表。
- 第一阶段支持 terminal resize。
- 在 CLI runtime 无法执行任何 handler 的终止（POSIX SIGKILL、断电、kernel crash）后提供可确认的 graceful
  cleanup；Windows Job kill-on-close 仍提供更强的被动保护，但不据此扩大跨平台承诺。

## 5. 工具 API

项目继续使用 camelCase，避免破坏当前工具命名约定。

### 5.1 `shell`

目标输入：

```ts
interface ShellInput {
  command: string

  /** 初始等待时间，默认 10000；0 是 immediate sentinel。 */
  yieldTimeMs?: number

  /** 可选硬运行上限。省略时不设置硬超时。 */
  timeout?: number

  /** 工作目录；相对路径以 LoopState.projectCwd 解析。 */
  cwd?: string

  /** 模型输出预算。 */
  maxOutputTokens?: number

  /** 阶段四开放。 */
  tty?: boolean

  /** 旧接口兼容；true 在未显式传 yieldTimeMs 时选择 immediate。 */
  runInBackground?: boolean
}
```

返回语义：

| 条件                                  | 结果                                                              |
| ------------------------------------- | ----------------------------------------------------------------- |
| 在 `yieldTimeMs` 内退出               | 输出、退出码，无 shell id                                         |
| 到达 yield deadline 仍存活            | 当前输出、shell id                                                |
| 用户中断等待且进程已注册              | 原子 yield，返回 shell id 和 `waitInterrupted: true`              |
| 显式硬超时                            | 终止进程，返回 timeout 状态和最终输出                             |
| spawnReady 失败且 cleanup confirmed   | 工具错误；无 started/id，失败 tombstone 在 lease ack 后删除       |
| spawnReady 失败且 cleanup unconfirmed | 工具错误 + 可管理 residual id；tree confirmed 前不得伪装 terminal |

默认值：

```ts
const INITIAL_YIELD_MS = 10_000
const MIN_INITIAL_YIELD_MS = 250
const MAX_INITIAL_YIELD_MS = 30_000
const WINDOWS_INITIAL_YIELD_FLOOR_MS = 10_000
const MAX_NODE_TIMER_MS = 2_147_483_647
```

公开数值先转换成内部 tagged policy，不能直接调用 `clamp()`：

```ts
type InitialWaitPolicy = { kind: 'immediate' } | { kind: 'timed'; ms: number }

function normalizeInitialWait(input: ShellInput, platform: NodeJS.Platform): InitialWaitPolicy {
  if (input.yieldTimeMs === 0) return { kind: 'immediate' }
  if (input.yieldTimeMs === undefined && input.runInBackground === true) return { kind: 'immediate' }

  const requested = input.yieldTimeMs ?? INITIAL_YIELD_MS
  const platformMinimum = platform === 'win32' ? WINDOWS_INITIAL_YIELD_FLOOR_MS : MIN_INITIAL_YIELD_MS
  return { kind: 'timed', ms: clamp(requested, platformMinimum, MAX_INITIAL_YIELD_MS) }
}
```

兼容规则：

```text
runInBackground: true 且未传 yieldTimeMs → immediate sentinel
显式 yieldTimeMs: 0                   → immediate sentinel，不参与 clamp
显式 yieldTimeMs > 0                  → 优先于 runInBackground，再按平台范围 clamp
runInBackground: false                 → 不覆盖显式 yieldTimeMs
显式 timeout          → 硬运行上限
省略 timeout          → 不再使用当前的默认 30 秒杀进程
```

这有意不同于 Codex 对所有 `yield_time_ms` 直接 clamp 的行为：x-code-cli 必须兼容现有
`runInBackground: true` 的立即返回。`0` 只是输入层 sentinel，manager API 中不存在含义模糊的数值 0。

schema 只接受 finite safe integer：`yieldTimeMs >= 0`，hard `0 < timeout <= MAX_NODE_TIMER_MS`，
`maxOutputTokens > 0`。负数、NaN、Infinity、小数和超过 Node 单次 timer 上限的 hard timeout 在进入 hook/manager
前拒绝；hook 修改后按相同规则重新验证。deadline 计算使用 monotonic clock，`occurredAt`/持久展示时间才使用
wall clock。

`cwd` 在运行 PreToolUse 前先做一次解析，在 hook 修改输入后再做最终解析。最终 `effectiveCwd` 必须是存在的
directory，并通过 `realpath`/平台等价方式规范化；NUL、文件路径、不可访问路径直接报错且不得 spawn。详见
第 17 节。

`timeout` 的行为变化需要在 CHANGELOG 中明确说明。保留默认 30 秒硬 timeout 会使普通长命令在自动 yield
前后仍可能被杀死，与目标语义冲突。

### 5.2 `shellOutput`

目标输入：

```ts
interface ShellOutputInput {
  shellId: string

  /** 阶段四：PTY 输入。空字符串表示只等待。 */
  chars?: string

  /** 等待窗口。 */
  yieldTimeMs?: number

  maxOutputTokens?: number

  /** 旧接口兼容。 */
  block?: boolean
  timeout?: number
}
```

tool handler 转为内部 `InteractShellRequest` 时必须附加真实 `toolCallId`；它不是模型输入字段，只用于配对
`wait-started`/`wait-finished` 和定位 CLI tool row。

默认和限制：

```text
empty chars default       5,000 ms
empty chars range         5,000–300,000 ms
non-empty chars default     250 ms
non-empty chars range       250–30,000 ms
```

旧参数映射：

```text
省略 block/yieldTimeMs             → empty chars: timed(5,000)，non-empty chars: timed(250)
显式 block: false 且未传 yieldTimeMs → immediate sentinel
block: true 且未传 yieldTimeMs       → timed(timeout ?? 30,000)
block: true, timeout: 0               → immediate sentinel（兼容旧 deadline 语义）
显式 yieldTimeMs: 0                  → immediate sentinel
显式 yieldTimeMs > 0                 → 按 empty/non-empty chars 对应范围 clamp
新旧参数同时存在                      → yieldTimeMs 优先
```

```ts
function normalizeInteractWait(input: ShellOutputInput, hasChars: boolean): WaitPolicy {
  if (input.yieldTimeMs === 0) return { kind: 'immediate' }
  if (input.yieldTimeMs !== undefined) return clampInteractTimed(input.yieldTimeMs, hasChars)
  if (Object.hasOwn(input, 'block') && input.block === false) return { kind: 'immediate' }
  if (input.block === true) {
    return input.timeout === 0 ? { kind: 'immediate' } : clampInteractTimed(input.timeout ?? 30_000, hasChars)
  }
  return { kind: 'timed', ms: hasChars ? 250 : 5_000 }
}
```

与初始等待相同，`immediate` 是 tagged policy，不受 empty chars 的 5 秒最小值影响；只有正数 timed wait 才应用
5 秒或 250ms 的下限。因此显式 `block: false` 仍立即返回，但完全省略 `block` 从当前的立即返回改为默认等待 5
秒；normalizer 必须用字段是否存在来区分二者，不能继续写 `input.block ?? false`。该兼容变化进入第 24 节和回归
测试。

`shellOutput.yieldTimeMs` 和 legacy `timeout` 同样只接受 finite safe integer 且 `>= 0`；正数最终最多 clamp 到
300,000ms，因此不会超过平台 timer 上限。

等待语义：

- 等待期间有输出时唤醒并 drain，但继续等待到 deadline、显式 lifecycle 中断或 composite terminal。
- 不进行固定间隔状态轮询。
- root exit 只触发状态重判，不结束等待；第 8 节定义的 composite terminal 提交后才提前结束。
- 用户中断只结束等待，不终止进程。
- 每次只返回上一次 drain 后的新输出。
- 同一 shell 的交互串行；不同 shell 允许并行。

### 5.3 `killShell`

```ts
interface KillShellInput {
  shellId: string
}
```

行为：

- 请求优雅终止。
- 等待短暂 grace period。
- 未退出则强制终止。
- 尽可能终止整个进程树，而不只是 Shell wrapper。
- 返回最终状态、最后一段未读取输出以及是否确认整棵进程树退出。
- 未知 id 返回工具错误。
- 已退出但尚未回收的 id 返回退出状态，不重复发送信号。
- 无法确认终止时返回结构化失败；不得把“已发送 kill”表述为“已停止”。
- `killShell` 的 tool wait 被 turn abort 时只提前闭合当前 tool call；已启动的 manager-owned grace/force flight
  继续运行并最终发布 `exited` 或 `termination-failed`，不能把 abort signal 传给 tree cleanup。

### 5.4 内部返回对象

```ts
interface ShellExecutionResult {
  chunkId: string
  wallTimeMs: number
  output: string
  /** 当前 tool call 写入 transcript 时使用，不允许 formatter 再猜。 */
  isError: boolean
  originalBytes: number
  omittedBytes: number

  shellId?: string
  exitCode?: number
  signal?: string

  running: boolean
  rootExited: boolean
  treeConfirmedExited: boolean
  /** spawn 未 ready 且 provisional tree cleanup 无法确认；只用于继续管理残余 target。 */
  cleanupResidual: boolean
  lifecycle: 'running' | 'manager-draining' | 'root-exited' | 'termination-failed' | 'exited' | 'spawn-failed'
  timedOut: boolean
  waitInterrupted: boolean
  managerDraining: boolean
  failure?: { code: ShellFailureCode; message: string }
  terminationReason?: TerminationReason
  terminationConfirmed?: boolean
}

interface FinalObservationLease {
  readonly claimId: string
  readonly observerToolCallId: string
  readonly origin: ShellHookOrigin
  /** 原始 shell PostToolUse 使用的 terminal payload；可与 killShell 自身 isError 不同。 */
  readonly post: { output: string; isError: boolean }

  /** 同步、no-throw、幂等；只在匹配 tool result 已 append 后调用。 */
  ack(): void

  /** 同步、no-throw、幂等；tool result 尚未 append 的异常路径调用，允许后续 observer 重试。 */
  release(): void
}

type ShellObservation =
  | { kind: 'running'; result: ShellExecutionResult }
  | { kind: 'terminal'; result: ShellExecutionResult; lease: FinalObservationLease }
```

`running` 严格等于 `treeConfirmedExited === false`；root 已退出但同组/job child 尚存时仍是 running observation。
`terminal` lease 在 ack/release 前持有 final claim；manager 只维护 session/lease 状态，不能写
`LoopState.messages`。cleanup confirmed 的 spawnReady 失败可以返回 terminal lease 以配对已经执行的 shell Pre/Post，但它不发布
`started`、不暴露 shell id，且必须先确认没有残留 tree，再把 starting entry 转为不占 live capacity 的 failure
tombstone。若 provisional tree 清理无法确认，则只能返回 `kind: 'running'`、`cleanupResidual: true`、
`lifecycle: 'termination-failed'` 和可用于 `shellOutput`/`killShell`/`/stop` 的 residual shell id；原始 Post 继续 pending，
在该 residual 最终 tree-confirmed observation 时按同一 lease transaction 提交。

`isError` 映射固定如下：

| 结果                                     | 当前 tool result `isError` | 原始 shell Post `isError` |
| ---------------------------------------- | -------------------------- | ------------------------- |
| 正常 yield / wait deadline，tree 仍 live | `false`                    | 尚不发送                  |
| turn abort / manager draining            | `true`                     | 尚不发送                  |
| termination-failed，tree 仍 live         | `true`                     | 尚不发送                  |
| tree confirmed，root exit code 0         | `false`                    | `false`                   |
| 非零 exit、非预期 signal、hard timeout   | `true`                     | `true`                    |
| spawnReady failure，cleanup confirmed    | `true`                     | `true`                    |
| spawnReady failure，cleanup unconfirmed  | `true`                     | 尚不发送                  |
| `killShell` confirmed/already-exited     | `false`                    | 按原 command 终态         |
| `killShell` failed/still-running         | `true`                     | 尚不发送                  |

因此非零退出、timeout 和 termination failure 不再由输出字符串或 formatter 推断。`shellOutput` 首次观察非零终态
时也返回 `isError: true`；这是第 24 节列出的行为变化。

模型输出由单一 formatter 生成，避免三个工具产生不同格式。

运行中：

```text
Chunk ID: a3f21c
Wall time: 10.002s
Process running with shell ID bg_7f3a91c2d4e6b810a42f09dc318bee77_1
Output:
Linting packages...
```

完成：

```text
Chunk ID: b84c10
Wall time: 4.218s
Process exited with code 0
Output:
Done in 14.2s
```

没有新输出：

```text
Process bg_7f3a91c2d4e6b810a42f09dc318bee77_1 still running
Output:
(no new output)
```

spawn cleanup residual：

```text
Command failed to start; process-tree cleanup could not be confirmed.
Residual shell ID: bg_7f3a91c2d4e6b810a42f09dc318bee77_1
Use shellOutput or killShell to inspect/retry cleanup.
```

UI 不允许通过解析这些文本判断状态，必须消费结构化 session 事件。

### 5.5 终止返回对象

```ts
type ShellFailureCode =
  | 'invalid-cwd'
  | 'spawn-failed'
  | 'stdin-unavailable'
  | 'termination-failed'
  | 'termination-unconfirmed'
  | 'manager-disposed'
  | 'unknown-shell-id'

interface ShellFailure {
  code: ShellFailureCode
  message: string
}

type TerminationReason =
  | 'kill-tool'
  | 'stop-command'
  | 'hard-timeout'
  | 'clear'
  | 'resume'
  | 'subagent-finished'
  | 'cli-shutdown'
  | 'print-exit'
  | 'manager-dispose'
  | 'spawn-failure-cleanup'
  | 'double-sigint'
  | 'sighup'
  | 'fatal-exit'
  | 'root-exited-residual'

interface TerminationBudget {
  gracefulMs: number
  forceMs: number
  confirmMs: number
}

interface ProcessTerminationResult {
  gracefulAttempted: boolean
  forceAttempted: boolean
  rootExited: boolean
  treeConfirmedExited: boolean
  exitCode?: number
  signal?: string
  failure?: { code: ShellFailureCode; message: string }
}

interface ShellTerminationResult {
  managerInstanceId: string
  shellId: string
  reason: TerminationReason
  disposition: 'terminated' | 'already-exited' | 'failed' | 'still-running'
  gracefulAttempted: boolean
  forceAttempted: boolean
  rootExited: boolean
  treeConfirmedExited: boolean
  terminationConfirmed: boolean
  exitCode?: number
  signal?: string
  failure?: { code: ShellFailureCode; message: string }
  output: string
}

interface TerminateAllResult {
  managerInstanceId: string
  reason: TerminationReason
  requested: number
  confirmed: number
  alreadyExited: number
  results: ShellTerminationResult[]
}

interface EmergencyTerminationResult {
  reason: TerminationReason
  requested: number
  results: Array<{
    managerInstanceId: string
    shellId: string
    disposition: 'already-exited' | 'force-sent-unconfirmed' | 'deadline-exhausted' | 'failed'
    failure?: { code: ShellFailureCode; message: string }
  }>
}
```

`confirmed` 只统计 `disposition === 'terminated' && terminationConfirmed === true`；竞态中已经
`treeConfirmedExited` 的条目单独计入 `alreadyExited`，root-only exit 不计入。`failed` 与 `still-running` 从
`results` 派生，不能只返回计数。`/stop` 只用 `confirmed` 生成
“Stopped N”；`already-exited` 不冒充本次 stop，其他项逐个显示 shell id 和失败原因，并设置命令结果为 partial
failure。dispose 成功条件是每个 requested target 都落在 confirmed 或 already-exited，而不是只检查发送过 signal。

同步 emergency API 返回 `EmergencyTerminationResult`，绝不能把成功发送 signal/taskkill 等同于
`terminationConfirmed`；只有进入 async `terminateTree()` 的 grace/force/confirm 流程才给出 confirmed 结论。

## 6. Core 架构

```text
shell / shellOutput / killShell tools
                  │
                  ▼
        UnifiedShellSessionManager
          │          │           │
          │          │           └─ lifecycle / cleanup
          │          └─ ShellSessionEventHub ─────► CLI/TUI subscriber
          │                       │
          │                       └─ started / residual-registered / yielded / output / root-exited / failure / exited
          │
          └─ ShellProvider
                  │
          ┌───────┴────────┐
          │                │
  pipe tree provider  PTY tree provider
          │                │
          └──── output / close / error
                         │
                         ├─ append bounded buffers
                         ├─ wake pending shell/shellOutput waits
                         └─ publish ordered domain events
       第一阶段          阶段四
```

建议新增：

```text
packages/core/src/tools/shell-session/
  manager.ts
  session.ts
  event-hub.ts
  output-buffer.ts
  wait-notifier.ts
  types.ts
```

当前 `packages/core/src/tools/background-shell.ts` 保留工具 schema 和兼容导出，registry 实现迁移到新目录。

### 6.1 Manager API

```ts
interface TerminateAndObserveRequest {
  shellId: string
  observerToolCallId: string
  reason: 'kill-tool'
  budget?: TerminationBudget
  turnAbortSignal?: AbortSignal
}

class UnifiedShellSessionManager {
  readonly managerInstanceId: string

  start(request: StartShellRequest): Promise<ShellObservation>

  interact(request: InteractShellRequest): Promise<ShellObservation>

  /** UI/lifecycle path；只终止，不 claim Post。 */
  terminate(shellId: string, reason: TerminationReason, budget?: TerminationBudget): Promise<ShellTerminationResult>

  /** killShell tool path；终止后若 terminal，同时返回 dispatcher 可提交的 final lease。 */
  terminateAndObserve(request: TerminateAndObserveRequest): Promise<ShellObservation>

  list(): ShellSessionSummary[]

  terminateAll(reason: TerminationReason, budget?: TerminationBudget): Promise<TerminateAllResult>

  dispose(reason: TerminationReason, budget?: TerminationBudget): Promise<TerminateAllResult>

  subscribe(listener: ShellSessionListener, options?: { replayCurrent?: boolean }): () => void
}
```

Manager 仍绑定到 LoopState：

```ts
projectCwd: string
shellSessions: ShellSessionController
```

`UnifiedShellSessionManager` 实现该窄接口；CLI 不依赖具体类。

这保证：

- 每个 root runtime manager generation 隔离。
- 每个 sub-agent 隔离。
- 不能用一个 manager 的 shell id 读取另一个 agent/manager 的输出。
- 动态会话信息不会进入 `systemPromptCache`。

### 6.2 两层通知系统（必须）

通知系统不是 UI 附件，而是 manager 的核心并发原语。它分成两层，职责不能混在一起：

```text
child stdout / close / error
             │
             ▼
    atomic session state update
       │                  │
       │                  └─ ShellSessionEventHub
       │                         └─ CLI subscriber → render action
       │
       └─ VersionedAsyncSignal / completion promise
                  └─ pending start()/interact() await → tool result
```

**第一层：session-local wake-up**

- `outputAvailable` 在新输出进入 buffer 后唤醒所有相关 waiter。
- `lifecycleChanged` 是带 generation 的 signal，覆盖 `spawn-ready`、`root-exited`、`tree-confirmed`、
  `manager-draining(reason)` 和 `termination-failed(failure)`；waiter 被唤醒后读取并分支处理当前 session state。
- ready session 的 `completion` 只在 root exit、tree-confirmed 和 final output flush 三者都成立后 resolve 一次；
  failed-launch residual 则在 tree-confirmed + output final 后 resolve。root exit 本身不能 resolve completion。
- dispose 把每个 live session 转为带 reason 的 manager-draining lifecycle 并 notify；shutdown target 可在全部 tree
  termination 确认后移除，但 manager `closed` 还必须等待各 session output finalization、`exited` enqueue 和 EventHub
  drain 完成。
- `outputAvailable` 和 `lifecycleChanged` 都使用递增 generation。`waitAfter(observedGeneration)` 在 generation 已
  变化时立即返回，避免“检查完 state、注册监听前刚好变化”的 lost wake-up；不能把一次 resolve 后永久 ready 的
  Promise 放回循环。
- 这些信号只协调进程和工具 handler，不直接绘制 UI。

建议类型：

```ts
type ShellLifecycleChange =
  | { kind: 'spawn-ready' }
  | { kind: 'root-exited'; exitCode?: number; signal?: string }
  | { kind: 'tree-confirmed' }
  | { kind: 'manager-draining'; reason: TerminationReason }
  | { kind: 'termination-failed'; reason: TerminationReason; failure: ShellFailure }

interface LifecycleSnapshot {
  generation: number
  change: ShellLifecycleChange
}
```

**第二层：session domain events**

- manager 对每个事件分配单调递增的 `seq`，通过 `ShellSessionEventHub` 发布。
- CLI 在一个 LoopState 成为 active 时订阅一次，在 `/clear`、`/resume` 或卸载旧 LoopState 时 unsubscribe。
- 订阅必须覆盖 turn 之间的空档，不能依赖一次 `agentLoop()` 调用的临时 `AgentCallbacks`；否则命令恰好在
  两条用户消息之间退出时，CLI 会漏掉完成事件。
- `subscribe({ replayCurrent: true })` 先发送同一事件序列中的 `snapshot`，再发送后续增量事件，解决 CLI
  重挂载时的 subscribe/list 竞态。
- listener 的异常由 hub 隔离并写 debug log，不能影响进程读取、状态提交或其他 listener。

**禁止的实现**

```ts
setInterval(() => checkProcessStatus(), 200)

while (session.running) {
  await delay(200)
  checkProcessStatus()
}
```

允许使用 yield deadline、用户指定 wait deadline、hard timeout 和 trailing-output grace 的一次性 timer；timer
到期只是一个唤醒源，不负责查询状态。

**事件投递与背压**

```ts
const MAX_OUTPUT_EVENT_BYTES = 8 * 1024
const MAX_PENDING_OUTPUT_BYTES = 256 * 1024
const MAX_PENDING_OUTPUT_EVENTS = 128
const MAX_RECENT_OUTPUT_BYTES = 16 * 1024
const MAX_EVENTS_PER_DRAIN = 64
const MAX_OUTPUT_PREDECESSORS_BEFORE_CONTROL = 16
```

- `started`、`residual-registered`、`yielded`、`root-exited`、`wait-started`、`wait-finished`、
  `termination-failed`、`exited` 和 `snapshot` 是 control event，永不因 output flood 丢弃。
- 相邻且同 session/stream 的 `output` 先合并，单 event 最多 8 KiB。全 manager pending output 同时受 256 KiB 和
  128 events 两个上限约束；超限时只从队列中淘汰最旧 output event，绝不淘汰 control event。
- 所有 byte cap 都按 UTF-8 byte length 计算，chunk/eviction/recent-tail 截取使用 `StringDecoder`，不能切断多字节
  字符。control payload 只携带已有的 bounded command preview 和 bounded recent output；不得把完整 transcript
  复制进 event queue。
- 每次淘汰把 bytes 累加到该 session 的 `uiOmittedBytes`；下一条保留的 output 带 `omittedBytesBefore`，最终
  `exited` 和 snapshot 也带最多 16 KiB 的 sanitized `recentOutput` 及累计 omitted bytes，因此 UI 不依赖完整
  delta 恢复尾部。
- control event enqueue 前，若它前方仍有超过 16 个 pending output events，继续淘汰最旧 output 直到满足上限。
  淘汰会留下 `seq` gap，CLI 只要求新事件 `seq > lastSeq`，不能要求连续。
- process stdout callback 只做 buffer append、signal notify 和 event enqueue，不同步执行 React render 或大量
  ANSI 清理。EventHub 每个 event-loop tick 最多 drain 64 个事件或 4ms（先到者为准），随后用 `setImmediate`
  续批；listener 异常逐个隔离。
- provider 在 `activate()` 前把 output/root/tree 通知保存在 attempt-local ordered frame buffer；manager 正常路径在
  `spawnReady` 后先提交 running/`started`，residual 路径先提交 `residual-registered`/`termination-failed`，再调用
  `activate()` flush。即使 ready/output/root-exit 同批到达，registration control event 也始终排在 frame 前。
- `exited` 必须排在该 session 的最终 retained output 后；发布 `exited` 后不得再发布该 session 的 `output`。
  即使发生淘汰，control fast lane 也保证它不会被 noisy process 的无界 backlog 阻塞。

root 与 tree 结束处理的固定顺序：

1. 观察 root exit/close，原子设置 `rootExited`、exit metadata，拒绝新 stdin，notify `lifecycleChanged` 并发布
   `root-exited`；此时 session 仍可能 `running: true`。
2. tree provider 独立确认 managed tree：POSIX 检查保存的 PGID；Windows 等待 Job Object active-process-zero
   notification。shutdown target 此时继续保留，不能因 root handle 的 `exitCode` 已设置而删除。
3. 任一平台发现 root 已退出而 tree 仍 live，都立即启动同一个 manager-owned、per-session single-flight
   `terminateTree('root-exited-residual')`。POSIX 对保留 PGID 做 grace/force；Windows 对保留 Job 做可用的 grace，
   随后 `TerminateJobObject()`，并且只有 `tree-empty` 才算 confirmed。失败统一转 `termination-failed`、notify
   lifecycle、发布失败事件并保留 target，不发布 `exited`。
4. stdio finalization 与 tree confirmation 并行，但 trailing grace 只能在 `treeConfirmedExited` 提交后启动：优先等待
   每个 stdout/stderr stream 的真实 EOF/close；若 provider 在 tree confirmed 后仍未交付 EOF，等待一次 50–100ms
   grace，再 detach/destroy stream、调用对应 `StringDecoder.end()` 并把尾部写入 unread/transcript。tree 仍 live 时
   无论静默多久都不能用 grace 设置 `outputFinalized=true`。
5. 只有第 8 节的 ready-terminal 或 failed-launch-terminal 谓词成立，才原子提交 composite terminal state、resolve
   `completion`。shutdown registry 可以在 tree-confirmed 时移除 target，但不能更早。
6. terminal transition 捕获当前 `activeInteraction.finished` 作为 exit publish barrier；handler 在 `finally` 中
   发布匹配 `wait-finished` 并 resolve barrier。
7. barrier 后 enqueue 且仅 enqueue 一个 `exited`，其中包含 root metadata、tree confirmation、recent output 和
   omitted bytes。没有 active interaction 时同一轮继续。
8. 保留 tombstone，直到 final observation lease ack 或 retention 到期。

`outputFinalized` 的精确定义是：所有已登记 stream 均已收到 EOF 且 decoder 已 `end()`，或者
`treeConfirmedExited=true` 后单次 trailing grace 到期并完成强制 decoder flush。Windows supervisor 必须保证已读取的
stdout/stderr frames 先于对应 EOF/control completion 交付；activation buffer 和 EventHub 继续保持原始 frame 顺序。

这套顺序保证 root 先退出、普通同组/job child 仍运行时 footer 和清理 target 都不会消失；同时 Waiting 先闭合为
Waited，再显示 background-finished。exit watcher 绝不能通过争抢 `interactionLock` 推断 interaction 已完成，只能
等待独立的 `activeInteraction.finished` barrier。

### 6.3 Runtime identity 与 resume 隔离

需要区分三种身份：

| 身份                | 生命周期                          | 持久化 | 用途                        |
| ------------------- | --------------------------------- | ------ | --------------------------- |
| `ownerSessionId`    | 逻辑 transcript session           | 是     | session 文件、用户 resume   |
| `managerInstanceId` | 一次 LoopState runtime generation | 否     | 事件过滤、订阅绑定、UI 去重 |
| `shellId`           | 一次 manager 内的 managed process | 否     | 模型读取/终止某个 shell     |

`hydrateLoopState()` 不能继续先 `createLoopState()`、再覆盖 `state.sessionId`，否则 manager 会捕获错误 owner。
改为：

```ts
createLoopState(initialMode, {
  ownerSessionId: loaded.sessionId,
  projectCwd,
})
```

普通新 session 省略 `ownerSessionId` 时才生成逻辑 id。无论新建还是 hydrate，manager 都必须生成新的
`managerInstanceId`，hydrate 不得覆盖或持久化它。建议使用 `crypto.randomUUID()`；测试通过注入 id factory
固定值。

shell id 是不透明 capability locator，格式为：

```text
bg_<full manager UUID bytes>_<monotonic counter>

例如：bg_7f3a91c2d4e6b810a42f09dc318bee77_1
```

nonce 使用 `managerInstanceId` 的完整 UUID bytes（去掉分隔符；UUID v4 提供 122 个随机 bit），manager id
factory 在同一 CLI 进程内记录已发出的 generation 并在碰撞时重试。跨 CLI 重启依赖 UUID 的加密随机唯一性；
显示层可以缩短 command，但不能截断传给工具的 shell id。旧 transcript 中的 `bg_1` 与新格式不兼容，也不会
命中新进程。

所有 `ShellSessionEvent`、`ShellSessionSummary` 和 snapshot 都带 `managerInstanceId`。CLI 接受事件必须同时
满足：

```ts
event.ownerSessionId === activeState.sessionId &&
  event.managerInstanceId === activeState.shellSessions.managerInstanceId
```

订阅 ref 比较 `managerInstanceId` 或 event-source 对象身份，不能只比较 `ownerSessionId`。因此 A → B → A
resume、直接 resume 当前逻辑 session，以及旧 manager 的延迟 event-loop task 都不会污染新 manager。

manager dispose 时先停止接受新 start，但保持 EventHub 到终止结果发布完成；确认可以切换后再关闭 hub 并使旧
subscription token 失效。已经 enqueue 的旧事件即使稍后执行，也会因 subscription generation 和
`managerInstanceId` 双重检查被丢弃。

## 7. Session 数据结构

```ts
type HandleAttachmentResult =
  | { kind: 'attached' }
  | { kind: 'failed-before-handle'; failure: { code: ShellFailureCode; message: string } }

interface ShellSession {
  ownerSessionId: string
  managerInstanceId: string
  id: string
  originToolCallId: string
  command: string
  requestedCwd?: string
  effectiveCwd: string
  tty: boolean

  /** `starting` 登记后、provider 同步返回 handle 前短暂为空。 */
  process?: ManagedProcess
  /** 同步 handle attachment 与异步 spawn readiness 分开。 */
  handleAttached: Deferred<HandleAttachmentResult>
  spawnReady: Promise<SpawnReadyResult>
  activation: 'pending' | 'active' | 'discarded'
  spawnOutcome: 'pending' | 'ready' | 'failed'
  cleanupResidual: boolean
  status:
    | 'starting'
    | 'running'
    | 'root-exited'
    | 'terminating'
    | 'termination-failed'
    | 'finalizing'
    | 'exited'
    | 'failed'

  spawnRequestedAt: number
  startedAt?: number
  lastInteractionAt: number
  rootExitedAt?: number
  treeConfirmedAt?: number
  exitedAt?: number
  exitedSeq?: number
  hardTimeoutAt?: number

  rootExited: boolean
  treeConfirmedExited: boolean
  outputFinalized: boolean
  exitCode?: number
  signal?: string
  failure?: { code: ShellFailureCode; message: string }
  timedOut: boolean
  managerDrainingReason?: TerminationReason
  terminationReason?: TerminationReason
  terminationConfirmed?: boolean
  terminationFlight?: Promise<ShellTerminationResult>

  /** 初始 shell 调用是否已返回 shell id。 */
  yielded: boolean

  /** 覆盖一次完整 interact（含通知等待），保证同 session 不出现两个并发 transport 调用。 */
  interactionLock: AsyncMutex

  /** finalization 捕获其 finished promise，保证 wait-finished 先于 exited。 */
  activeInteraction?: {
    toolCallId: string
    eventEmitted: boolean
    finished: Deferred<void>
  }

  /** 新输出到达时递增 generation 并唤醒 waiter。 */
  outputAvailable: VersionedAsyncSignal

  /** spawn/root/tree/draining/failure 的带原因、带 generation 状态变化。 */
  lifecycleChanged: VersionedAsyncSignal<ShellLifecycleChange>

  /** 第 8 节 composite terminal 成立后只 resolve 一次。 */
  completion: Deferred<ShellCompletion>

  /** 下一次 shell/shellOutput 调用读取并 drain。 */
  unreadOutput: HeadTailOutputBuffer

  /** 用于 TUI 最近输出、退出摘要和诊断，不 drain。 */
  transcript: HeadTailOutputBuffer

  hookOrigin: ShellHookOrigin
  finalObservation: FinalObservationState
}
```

“前台”和“后台”不是两种进程类型，只是 `yielded` 状态不同。

## 8. 状态机

```text
starting
  ├─ handleAttached ──► await spawnReady
  │                       ├─ error + tree confirmed ──► failed tombstone（无 started/yielded/id）
  │                       ├─ error + tree unconfirmed ─► termination-failed residual（无 started；返回管理 id）
  │                       └─ ready ──► commit running + started ──► activate/flush frames
  ├─ spawnManaged sync throw ──► settle handleAttached + remove starting → failed tombstone
  └─ dispose/abort-before-ready ──► cancel attempt → await ready/error + cleanup

running
  ├─ deadline ──► yielded=true（仍 running）
  ├─ terminate/hard timeout ──► terminating
  │                               ├─ tree confirmed ──► finalizing ──► exited
  │                               └─ unconfirmed ─────► termination-failed（target retained）
  └─ root exit ──► root-exited（不是 terminal）
                      ├─ tree already empty ─────────► finalizing ──► exited
                      └─ residual tree ──► terminating(root-exited-residual)
                                             ├─ confirmed ──► finalizing ──► exited
                                             └─ failed ─────► termination-failed
```

正交不变量：

```text
ready terminal/exited = spawnOutcome === ready && rootExited && treeConfirmedExited && outputFinalized
failed-launch terminal = spawnOutcome === failed && treeConfirmedExited && outputFinalized
shutdown target removable = treeConfirmedExited
running result = !treeConfirmedExited
```

退出后的条目保留为短期 tombstone：

```text
exited
  ├─ 最终 tool result + 原始 PostToolUse 均提交，lease.ack() → remove
  ├─ 保留时间到期 → remove
  └─ manager 达到容量限制 → 仅回收非 claimed；pending 先标记 abandoned
```

主要状态场景：

| 场景                                       | 行为                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| 初始等待中快速退出                         | 提交 final observation，ack 后移除，不返回 id          |
| 初始 deadline 时仍运行                     | 返回 id，`yielded = true`                              |
| yield 后、首次 wait/read 前 tree confirmed | UI 收到 exit；entry 保留，供模型读取最终输出           |
| 空输入等待到期后仍运行                     | 返回同一个 id 和增量输出                               |
| 空输入等待被 exit 唤醒                     | claim final observation，提交/ack 后回收               |
| wait 被 Esc 中断                           | 返回 id 和 `waitInterrupted`，进程保留                 |
| hard timeout                               | 终止进程，返回 timeout 状态                            |
| killShell                                  | 返回结构化终止结果；确认后可提交 final observation     |
| spawnReady 失败且 cleanup confirmed        | 不发布 started/id；terminal lease ack 后回收 tombstone |
| spawnReady 失败且 cleanup unconfirmed      | 不发布 started；返回 termination-failed residual id    |
| starting 期间 manager dispose              | 拒绝注册或注册后立即终止，不允许逃逸                   |
| yield 后无人读取且 hard timeout            | manager timer 独立终止，发布 exited 并保留 tombstone   |
| root 先退出、同组/job child 存活           | 保留 target；自动清理 residual tree，确认后才 exited   |

## 9. 启动算法

`manager.start()`：

1. 接收已通过 hook、authority 和 permission 的 `PreparedShellRequest`；manager 不重新解释 cwd。
2. 检查 manager 仍接受新 session，分配包含 manager nonce 的不重复 shell id，并先登记 `starting` entry。
3. 创建 manager 自己拥有的 lifecycle/termination controller，不能复用 turn abort signal。
4. 在 `try/catch` 中调用 `spawnManaged()`。它同步返回
   `ManagedSpawnAttempt { handle, ready, activate }`；provider 从调用开始就把 output/root/tree frame 写入自己的有序
   activation buffer，不能直接调用 manager listener。
5. 返回 attempt 后，在同一 JavaScript 调用栈内写入 handle、注册 provisional shutdown target、连接 attempt
   listener 并以 `{ kind: 'attached' }` resolve `handleAttached`；这一步只表示已有可清理对象，不表示 OS spawn 成功。若
   `spawnManaged()` 同步 throw，manager 必须以 `failed-before-handle` resolve `handleAttached`、删除 live `starting`
   entry、确认没有
   target，再建立不占 live capacity 的 failure tombstone/terminal lease。provider contract 禁止“创建 OS handle
   后再同步 throw”；这类错误必须通过 `attempt.ready` reject，以便 manager 已持有 cleanup handle。
6. await `attempt.ready`：POSIX provider 在 ChildProcess `spawn` event 成功时 resolve、`error`（如 ENOENT）时
   reject；Windows provider 只有在 suspended root 已成功 assign Job Object 并 resume 后才 resolve。即使同一个
   binary read callback 随后解析到 output/root-exit，所有 frame 仍留在 activation buffer。
7. dispose 或 turn abort 在 ready 前发生时调用 idempotent `attempt.cancelBeforeReady(reason)`，并与 ready/error 做
   单一仲裁。cleanup confirmed 才能返回无 id 的失败；cleanup unconfirmed 走第 8 步 residual promotion，不能删除
   target 或返回隐藏 live tree 的 terminal result。
8. spawnReady failure 先执行 manager-owned `terminateTree('spawn-failure-cleanup')`。tree absent/confirmed 时把 starting entry 转为
   failure tombstone，把 activation buffer 中的 output 直接纳入 terminal failure result（不发布 domain event），返回
   `isError: true` 的 terminal observation lease，不发布 `started`/`yielded`、不暴露 id。
   cleanup 在 budget 后仍 unconfirmed 时，把 provisional entry 原子提升为
   `status='termination-failed'`、`cleanupResidual=true` 的可管理 residual：发布 `residual-registered` 和
   `termination-failed` 后调用 `attempt.activate()` flush buffered frames，返回 `kind:'running'` 的 error observation 及
   shell id。它可由 `shellOutput`、`killShell`、`/ps`、`/stop` 和 shutdown registry 管理，tree confirmed 前绝不能
   返回 terminal lease。
9. ready 成功后进入一个不含 `await` 的 activation commit：再次检查 dispose/cancel 仲裁，原子设置 running、
   `startedAt`、hard-timeout timer并 enqueue `started`，然后调用 no-throw/idempotent `attempt.activate()`。activate
   按原 frame 顺序 flush；因此 `ready → output → root-exit` 同批到达时，manager 仍先观察到 `started`。若取消已经
   获胜，则不发布 started；cleanup-confirmed 时只把 buffered output 纳入失败结果并丢弃 domain control frames，
   cleanup-unconfirmed 时按 residual anchor 后 activate，始终通过 handle 完成 cleanup。
10. immediate policy 调用 `transitionToYielded('explicit-background')`；timed policy 调用第 10 节与
    `shellOutput` 共用的 `observeSessionUntil()`，等待 output、`lifecycleChanged`、completion、deadline 或 turn
    abort，不能使用只含三个 Promise 的专用 initial wait。
11. initial observation 的任何 non-terminal return 都必须先暴露可管理状态：deadline/abort 分别调用
    `transitionToYielded('deadline' | 'turn-abort')`；manager draining 或 termination failure 分别调用
    `transitionToYielded('manager-draining' | 'termination-failed')`，再返回 shell id、当前 output 和结构化状态。
    `transitionToYielded()` 对 ready session 至多成功一次；cleanup residual 使用独立的 `residual-registered`，不伪造
    `started`/`yielded`。
12. completion 先到时 claim final observation 并返回 `ShellObservation.kind='terminal'`；dispatcher 完成原始 Post
    和当前 tool result 后调用 lease `ack()`，manager 自己不提交 transcript。
13. hard-timeout timer 归 manager 所有，yield 或 turn 结束不取消；即使再也没有模型调用也会尝试终止进程树。
    确认后设置 `timedOut`/`terminationReason` 并发布 `exited`；无法确认则发布 `termination-failed`、唤醒 initial/
    transport observation 并保留 handle。

activation 的时序边界：

```text
provider read callback:  ready ─ output ─ root-exit
                          │       │          │
                          └─ resolve ready   └─ 全部留在 activation buffer
                                      │
manager continuation:        commit running + enqueue started
                                      │
                                  activate()
                                      │
EventHub:                       started ─ output ─ root-exited
                                                   └─ root-exited-residual flight
```

进程一旦成功启动并注册，就不能把 `options.abortSignal` 作为 execa 的 `cancelSignal`。必须将：

```text
取消当前等待
```

与：

```text
终止底层进程
```

设计为两个独立操作。

这不等于丢弃 `options.abortSignal`：tool-execution 必须把它传给 Pre/Post hook 和 `start()`/`interact()` 的
turn-wait context，用来唤醒并闭合当前 tool call；只禁止把同一个 signal 直接交给 provider/execa 杀进程。所有
abort 分支仍提交匹配 tool result。

即使 turn 被中断，工具 handler 也必须产生与原始 tool call 匹配的 tool result，避免下一次 provider 请求出现
orphan tool call。

abort 在 spawn request 前发生时直接返回 matched interrupted result；handleAttached 后、spawnReady 前发生时必须
cancel attempt 并等待 ready/error 与 cleanup 仲裁。若 ready 先成功，先转 yielded 再返回有效 id；若 cancel/error
胜出，只在 tree absent/confirmed 后返回无 id 的 error；cleanup unconfirmed 时按第 8 步返回明确标记的 residual id。
任何路径都不能把尚未 ready 的 command 伪装成正常 running session。

## 10. 通知驱动的统一 observation wait 算法

废弃当前 200ms polling。ready 后的 initial `start()` wait 与 `shellOutput` 必须调用同一个
`observeSessionUntil()`；区别只在 wait policy、是否发布 Waiting/Waited，以及 initial non-terminal return 是否先
transition-to-yielded。一次调用可以在协议层等待最多 300 秒，但内部是事件驱动 `await`，不是每隔 200ms 查询
状态：

```ts
interface ObservationWaitContext {
  source: 'initial' | 'transport'
  toolCallId: string
  deadline: number
  turnAbortSignal?: AbortSignal
  request: StartShellRequest | InteractShellRequest
}

async function observeSessionUntil(session: ShellSession, context: ObservationWaitContext): Promise<ShellObservation> {
  const accumulated = new HeadTailOutputBuffer(context.request.maxOutputBytes)

  return session.interactionLock.runExclusive(async () => {
    const active = context.source === 'transport' ? maybeBeginInteraction(session, context) : undefined
    const deadlineWake = createDeadlineWake(context.deadline)
    const abortWake = createAbortWake(context.turnAbortSignal)
    try {
      while (true) {
        const outputGeneration = session.outputAvailable.generation
        const lifecycle = session.lifecycleChanged.snapshot()

        if (session.isTerminal()) {
          const claim = claimFinalObservationLease(session, context.toolCallId, accumulated.snapshot())
          if (claim.kind === 'claimed') {
            return { kind: 'terminal', result: claim.result, lease: claim.lease }
          }
          await claim.settled
          continue
        }

        accumulated.append(drainRunningOutput(session))
        if (session.status === 'termination-failed') {
          exposeInitialNonTerminal(session, context, 'termination-failed')
          return terminationFailedObservation(session, accumulated.snapshot())
        }
        if (session.managerDrainingReason !== undefined) {
          exposeInitialNonTerminal(session, context, 'manager-draining')
          return managerDrainingObservation(session, accumulated.snapshot())
        }
        if (deadlineReached(context.deadline)) {
          exposeInitialNonTerminal(session, context, 'deadline')
          return runningResult(accumulated.snapshot())
        }
        if (context.turnAbortSignal?.aborted) {
          exposeInitialNonTerminal(session, context, 'turn-abort')
          return interruptedResult(accumulated.snapshot())
        }

        await Promise.race([
          session.outputAvailable.waitAfter(outputGeneration),
          session.lifecycleChanged.waitAfter(lifecycle.generation),
          session.completion.promise,
          deadlineWake.promise,
          abortWake.promise,
        ])
      }
    } finally {
      deadlineWake.dispose()
      abortWake.dispose()
      if (active !== undefined) finishInteraction(session, active)
    }
  })
}
```

`exposeInitialNonTerminal()` 对 transport 是 no-op；对 initial wait 则在返回前原子
`transitionToYielded(reason)`，保证 manager-draining 或 hard-timeout cleanup failure 即使发生在默认 10 秒 deadline
前，也立即闭合原始 shell tool call并给出可管理 id。cleanup residual 在进入该 loop 前已经通过
`residual-registered` 暴露，不调用该 helper。

running output 可以在每次唤醒时 drain，但必须追加到本次调用的有界 `accumulated`，不能在继续等待时丢弃；
terminal output 只能 peek，并与已累计 output 一起放进返回给 dispatcher 的 lease。第 18 节在 Post hook 和 tool
result 成功后 `ack()` 才 drain；异常时 `release()`。manager 不调用 transcript helper。否则“先 drain、再执行
Post”会在 abort/异常时永久丢失最终输出。

`waitAfter()` 必须先比较 generation，再注册 waiter，并在注册后重新比较一次；或者使用语义等价的原子实现。
这样即使输出恰好出现在 drain 与 await 之间，也不会睡到 deadline。Node 的单线程执行模型不能代替这个不变量，
因为 buffer lock、adapter 和未来 PTY provider 都可能引入异步边界。

规则：

- 输出到达先 append buffer，再递增 generation、唤醒 waiter 和 enqueue `output` 事件。
- 有输出后继续等待剩余窗口。
- composite terminal 完成后 resolve `completion`；root exit 或 stdio close 单独发生都只 notify lifecycle。
- initial/transport 两条路径都把 `lifecycleChanged.waitAfter(generation)` 放进 race；不能让 initial wait 退化为只等
  deadline/completion/abort 的第二套算法。
- `manager-draining` 被观察后立即返回当前累计输出，设置 `managerDraining=true`、`waitInterrupted=true` 和
  `isError=true`，不再次进入 wait loop。
- `termination-failed` 被观察后立即返回 `running=true`、结构化 failure 和 `isError=true`；不等待调用自己的
  deadline。
- 只有 tree confirmed 后 stdio EOF 仍无法可靠观察时，才给未结束 stream 一次 50–100ms trailing-output grace；tree
  live 时禁止启动该 timer 或调用 `StringDecoder.end()`。
- 同一 shell 的 `interact` 在整个通知等待期间持有 interaction lock；进程 output/finalization 不获取该锁。
- finalization 只捕获当时的 `activeInteraction.finished`，在它 resolve 后发布 `exited`；不能等待 mutex 本身。
- 不同 shell 的等待可以并行。
- timer 和 abort listener 在所有返回路径中清理。
- manager 进入 draining 后通过 lifecycle generation 唤醒已有 wait；新 start 失败。为处理 partial failure，新的只读 status/drain 和
  terminate 仍允许，但不能再次长等待、写 stdin 或启动进程；全部 composite final、EventHub drained 并 closed 后
  所有访问返回 disposed error。

这里仍可能出现多次模型级 `shellOutput` 调用：例如模型选择 5 秒 wait，而进程运行 2 分钟。但每次调用都是
通知驱动等待；Core 不产生固定频率的状态查询。默认等待窗口应足够长，以减少模型往返。

当前 tool dispatcher 只并行执行 `task`，但 manager 仍应保证跨 session 并发安全，为后续并行 transport tools
留出空间。

只有真正进入 timed empty wait 或执行非空 chars 的调用发布 `wait-started`；immediate empty read 不制造
Waiting/Waited UI。只要发布了 start，`finishInteraction()` 就必须在所有 return/throw/abort/dispose 路径发布匹配
的 `wait-finished`。已经 terminal 后才开始的 observation 不参与此前 `exited` 的 barrier。

## 11. 输出缓冲

废弃“字符串 + cursor”结构，使用两个独立 head/tail buffer：

```text
unreadOutput
  下一次 shell/shellOutput 返回后 drain

transcript
  不 drain，用于 TUI 最近输出、退出摘要和诊断
```

默认限制：

```ts
const OUTPUT_MAX_BYTES = 1024 * 1024
const HEAD_BYTES = 512 * 1024
const TAIL_BYTES = 512 * 1024
```

超过限制时返回：

```text
<head>
... 1532847 bytes omitted ...
<tail>
```

实现要求：

- 记录 `originalBytes` 和 `omittedBytes`。
- 按 UTF-8 bytes 而不是 JavaScript UTF-16 字符数限制。
- 在 UTF-8 code point 边界切割。
- stdout/stderr 按 Node 收到事件的顺序合并。
- 每个 stream 使用独立 `StringDecoder`，避免 chunk 截断中文字符。
- UI 输出移除 OSC、危险控制序列和不可见终端命令。
- debug log 只记录字节数、状态、shell id 和 exit code，不记录实际输出。
- 模型输出继续经过 `truncateToolResult()` 的第二层限制。

## 12. Core 到 CLI 的事件协议

事件源是 LoopState 生命周期内常驻的 `ShellSessionEventHub`，不是单次 turn 的回调。Core 向 CLI 暴露只读
订阅能力：

```ts
interface ShellSessionEventSource {
  readonly managerInstanceId: string
  subscribe(listener: ShellSessionListener, options?: { replayCurrent?: boolean }): () => void
}
```

```ts
interface ShellSessionSummary {
  managerInstanceId: string
  ownerSessionId: string
  shellId: string
  originToolCallId: string
  command: string
  requestedCwd?: string
  effectiveCwd: string
  tty: boolean
  status:
    | 'starting'
    | 'running'
    | 'root-exited'
    | 'terminating'
    | 'termination-failed'
    | 'finalizing'
    | 'exited'
    | 'failed'
  yielded: boolean
  spawnOutcome: 'pending' | 'ready' | 'failed'
  cleanupResidual: boolean
  spawnRequestedAt: number
  startedAt?: number
  rootExited: boolean
  treeConfirmedExited: boolean
  outputFinalized: boolean
  rootExitedAt?: number
  treeConfirmedAt?: number
  exitedAt?: number
  exitCode?: number
  signal?: string
  failure?: { code: ShellFailureCode; message: string }
  timedOut: boolean
  terminationReason?: TerminationReason
  terminationConfirmed?: boolean
  exitedSeq?: number
  recentOutput: string
  omittedBytes: number
  uiOmittedBytes: number
}

interface ShellSessionEventBase {
  /** 同一 manager 内全局单调递增。 */
  seq: number
  ownerSessionId: string
  managerInstanceId: string
  occurredAt: number
}

type ShellSessionEvent = ShellSessionEventBase &
  (
    | {
        kind: 'snapshot'
        sessions: ShellSessionSummary[]
      }
    | {
        kind: 'started'
        shellId: string
        originToolCallId: string
        command: string
        requestedCwd?: string
        effectiveCwd: string
        tty: boolean
        startedAt: number
      }
    | {
        kind: 'residual-registered'
        shellId: string
        originToolCallId: string
        command: string
        effectiveCwd: string
        failure: { code: ShellFailureCode; message: string }
      }
    | {
        kind: 'yielded'
        shellId: string
        yieldAfterMs: number
        reason: 'explicit-background' | 'deadline' | 'turn-abort' | 'manager-draining' | 'termination-failed'
      }
    | {
        kind: 'output'
        shellId: string
        stream: 'stdout' | 'stderr'
        chunk: string
        truncated?: boolean
        omittedBytesBefore?: number
      }
    | {
        kind: 'root-exited'
        shellId: string
        exitCode?: number
        signal?: string
        treeConfirmedExited: false
      }
    | {
        kind: 'wait-started'
        shellId: string
        toolCallId: string
        chars: string
      }
    | {
        kind: 'wait-finished'
        shellId: string
        toolCallId: string
        chars: string
        running: boolean
      }
    | {
        kind: 'termination-failed'
        shellId: string
        reason: TerminationReason
        attempt: number
        failure: { code: ShellFailureCode; message: string }
        stillRunning: true
      }
    | {
        kind: 'exited'
        shellId: string
        exitCode?: number
        signal?: string
        failure?: { code: ShellFailureCode; message: string }
        durationMs: number
        wasYielded: boolean
        timedOut: boolean
        terminationReason?: TerminationReason
        terminationConfirmed: true
        spawnOutcome: 'ready' | 'failed'
        cleanupResidual: boolean
        rootExited: boolean
        treeConfirmedExited: true
        recentOutput: string
        uiOmittedBytes: number
      }
  )
```

事件契约：

- 每个事件都带 `ownerSessionId`、`managerInstanceId` 和 `seq`。CLI 同时比较逻辑 session 与 active manager；
  任一不匹配都直接丢弃。
- 每个 spawnReady 成功的 session 恰好一个 `started`，可选一个 `yielded`、一个 `root-exited`、零到多个
  `output`；只有 composite terminal 时发布且仅发布一个 `exited`。spawnReady failure 不发布 started；cleanup
  confirmed 时不发布任何 live-session event，cleanup unconfirmed 时先发布且仅发布一个 `residual-registered`，再
  发布 `termination-failed`。residual tree 未确认前不伪造 `exited`。
- 终止无法确认时可发布多个带 attempt 的 `termination-failed`；它不是 terminal event，session handle 必须保留。
- ready session 满足 `started.seq < exited.seq`；如果存在 `yielded`/`root-exited`，它们也必须位于 started 与
  exited 之间。cleanup residual 则满足 `residual-registered.seq < termination-failed.seq < exited.seq`。一个
  session 的所有 retained `output` 必须位于其 registration control event 与 `exited` 之间。没有 yield 的快速命令
  同样有结构化 `exited`，但 CLI 不追加 background-finished 行；root-exited 绝不移除 footer。
- 每个 `wait-started` 必须用实际 `toolCallId` 匹配恰好一个 `wait-finished`，包括 abort、dispose 和异常路径；
  CLI 直接用它定位 `agent-tool-lifecycle.ts` 中待隐藏/替换的工具行，不另造不兼容的 interaction id。
- 如果 exit 唤醒了 active wait，对应 `wait-finished.seq < exited.seq`；finalization 捕获并等待
  `activeInteraction.finished` barrier 保证这个顺序，不依赖 mutex waiter 的调度顺序。
- `snapshot` 与后续事件使用同一有序队列。CLI 先应用 snapshot，再只接受更大的 `seq`，允许 output eviction
  造成的 gap，重复投递幂等。
- 事件是运行时状态，不进入 system prompt，也不参与 session 持久化。

`snapshot.seq` 是订阅瞬间的 high-water mark，不额外占用一个全局序号；它包含所有 live session 和 retention
期内已 yield 的 tombstone。manager 在同一同步临界区内先注册 listener、捕获 state/seq，再把 snapshot 放入
该 listener 的私有队列，因此后续增量事件的 `seq` 必然更大。CLI 以
`managerInstanceId + shellId + exited.seq` 去重完成摘要。

yield deadline 与 process completion 竞争时，由 manager 的同一状态转换函数串行决定：completion 先提交则
`wasYielded: false`；`yielded` 先发布则最终 `exited.wasYielded: true`。不能根据两个 Promise callback 的到达
顺序分别修改状态。

CLI 在创建 active LoopState 时注册 listener。切换时先 dispose 旧 manager并接收其最终事件；全部终止确认后才
unsubscribe 并绑定新 manager。不要每次调用 `agentLoop()` 都新增 listener，也不要依赖 `AgentCallbacks` 是否
正好处于活跃 turn。print mode 可以不绘制 footer，但仍持有 manager 引用并在 finally dispose。

`use-agent.ts` 使用一个 session-scope ref，而不是 turn-local closure：

```ts
const shellEventSubscriptionRef = useRef<{
  ownerSessionId: string
  managerInstanceId: string
  unsubscribe: () => void
} | null>(null)

function bindShellSessionEvents(state: LoopState): void {
  const managerInstanceId = state.shellSessions.managerInstanceId
  if (shellEventSubscriptionRef.current?.managerInstanceId === managerInstanceId) return

  shellEventSubscriptionRef.current?.unsubscribe()
  const unsubscribe = state.shellSessions.subscribe(dispatchShellSessionEvent, { replayCurrent: true })
  shellEventSubscriptionRef.current = { ownerSessionId: state.sessionId, managerInstanceId, unsubscribe }
}
```

在首次 `createLoopState()` 后且调用 `agentLoop()` 前、hydrate、`/resume` 和 `/clear` 创建新 state 后调用该
helper。listener 只能捕获稳定的 reducer dispatch/ref，不能捕获某一轮的 abort controller、tool row 或
`AgentCallbacks`。

异步 output/exit 事件只允许改变 UI 状态，不能异步修改 `LoopState.messages`。模型 transcript 只能在工具
调用边界修改，否则可能破坏 assistant/tool result 的严格排序。

当 managed tree 结束时：

- 如果 `shell`/`shellOutput` 正在等待，`completion` 立即结束该 handler，正常写入匹配的 tool result。
- 如果没有工具调用在等待，`exited` 仍立即到达 CLI、移除 footer 并追加完成摘要；最终输出保留在 tombstone。
- 不自动开启新一轮 LLM 请求，也不伪造一条异步 tool result。模型下次读取该 shell id 时取得最终结果。

root 单独结束但 tree 未确认时只发送 `root-exited` 和 lifecycle wake-up；CLI 保留 footer/target，模型观察到的
result 仍为 `running: true`。只有 Job/group confirmed 后才进入上述 terminal 路径。

迁移完成后，现有不带 session id 的全局 `onShellOutput(chunk)` 可以删除，或在过渡期作为 foreground
compatibility adapter。

## 13. TUI 设计

所有可见输出都必须在 `ChatInput.tsx` 的 cell buffer 中绘制，不能新增可见 Ink children。

### 13.1 AgentState

```ts
interface BackgroundTerminalView {
  managerInstanceId: string
  shellId: string
  command: string
  effectiveCwd: string
  status: 'running' | 'root-exited' | 'terminating' | 'termination-failed' | 'exited'
  spawnOutcome: 'ready' | 'failed'
  cleanupResidual: boolean
  exitCode?: number
  failure?: { code: ShellFailureCode; message: string }
  timedOut: boolean
  terminationReason?: TerminationReason
  terminationConfirmed?: boolean
  exitedSeq?: number
  rootExited: boolean
  treeConfirmedExited: boolean
  startedAt?: number
  recentLines: string[]
}

interface ShellWaitStreak {
  managerInstanceId: string
  shellId: string
  toolCallId: string
  command?: string
}
```

```ts
backgroundTerminals: BackgroundTerminalView[]
shellWaitStreak: ShellWaitStreak | null
```

### 13.2 等待状态

收到 `wait-started` 且 `chars === ''`：

```text
● Waiting for background terminal (3s · esc to interrupt)
  └ pnpm lint
```

它替换普通 `shellOutput(bg_7f3a91c2d4e6b810a42f09dc318bee77_1)` live tool row。

### 13.3 Waited 历史

同一个 shell 的连续空等待合并成一个 streak：

```text
• Waited for background terminal · pnpm lint
```

flush 时机：

- 当前 turn 完成。
- assistant 文本开始输出。
- 另一个 shell 开始等待。
- 同一个 shell 收到非空 stdin。
- shell 退出。
- turn 被中断。
- 用户触发 `/clear` 或 `/resume`。

非空输入显示：

```text
↳ Interacted with background terminal · node repl
  └ console.log("hello")
```

### 13.4 Footer

CLI 在收到 `yielded` 或 `residual-registered` 后把 session 计入后台终端；`started` 本身不会让普通的 10 秒内命令
闪现 footer。cleanup residual 使用警告样式并明确这是“启动失败后的待清理 target”，不能显示成成功启动的 command。
存在运行中的后台终端时：

```text
1 background terminal running · /ps to view · /stop to close
```

多个：

```text
3 background terminals running · /ps to view · /stop to close
```

Footer 放在输入框上方、普通 status/todo 区域附近，使用 dim 样式，并通过 cell width 工具进行跨平台、
跨字符宽度截断。

### 13.5 异步退出

stdout scrollback 是 append-only，不能修改已经提交的启动行。因此 managed tree 达到 composite terminal 时追加：

```text
• Background terminal finished · pnpm lint · exit 0 · 14.2s
```

如果进程在初始 yield 前退出，Core 仍发布结构化 `exited` 以闭合事件序列，但 `wasYielded: false`。CLI 继续
使用普通 Shell 工具结果，不追加后台完成摘要。

收到 `root-exited` 但 `treeConfirmedExited=false` 时不追加 finished、不移除 footer；状态可显示为：

```text
• Root exited; cleaning up background process tree · pnpm lint
```

只有后续 tree-confirmed `exited` 才完成该行。

收到 `termination-failed` 时不移除 footer，改为警告状态并保留 `/stop` 重试入口：

```text
• Could not confirm background terminal stopped · pnpm dev · /stop to retry
```

`cleanupResidual=true` 时显示更具体的状态：

```text
• Command failed to start; cleanup is unconfirmed · pnpm lint · /stop to retry
```

该 residual 后续收到 tree-confirmed `exited` 时移除 footer；可追加
`Background process cleanup completed`，但不把它表述为 command 成功完成。

### 13.6 UI 与模型 transcript

`Waiting`、`Waited`、footer 和异步退出摘要是 display-only 状态，不应写成新的模型 user/assistant 消息。
对应的 `shellOutput` tool call/result 仍在模型 transcript 中，保证 provider 协议完整。

空 `shellOutput` 的普通工具行应像 `toolSearch` 一样从 live UI 和 scrollback 中隐藏，由专用等待展示替代。

## 14. `/ps` 与 `/stop`

### 14.1 `/ps`

展示最多 16 个运行中的进程：

```text
Background terminals

  • bg_7f3a91c2d4e6b810a42f09dc318bee77_1 · pnpm lint · 14s
    ↳ Checking package core...
  • bg_7f3a91c2d4e6b810a42f09dc318bee77_2 · pnpm dev · 2m 11s
    ↳ Local: http://localhost:5173
```

数据从 manager `list()` 获取，不依赖 UI 缓存。

包括：

- manager instance（内部匹配；默认不完整显示）
- shell id
- command
- requested/effective cwd
- elapsed
- yielded/status/spawnOutcome/cleanupResidual/rootExited/treeConfirmedExited/exit metadata
- termination reason/confirmed/failure
- 最近 1–3 行清理过控制字符的输出

### 14.2 `/stop`

```text
/stop
```

停止当前 LoopState 下的全部后台终端。

扩展支持：

```text
/stop bg_7f3a91c2d4e6b810a42f09dc318bee77_1
```

只停止指定 shell。

结果：

```text
Stopped 2 background terminals.
```

部分失败：

```text
Stopped 1 background terminal; 1 could not be confirmed stopped.
  • bg_7f3a91c2d4e6b810a42f09dc318bee77_2 · termination-unconfirmed · process tree may still be running
```

或：

```text
No running background terminals.
```

文案只使用 `TerminateAllResult.confirmed`，失败项保留 manager handle 供重试；不能根据 requested 数量输出
“Stopped N”。

命令涉及：

- `packages/cli/src/ui/app/command-content.ts`
- `packages/cli/src/ui/app/App.tsx`
- 新增 `packages/cli/src/ui/app/commands/background-terminal.ts`

## 15. 生命周期

| 操作                   | 后台进程行为                                        |
| ---------------------- | --------------------------------------------------- |
| Esc / Ctrl+C 中断 turn | 保留进程，只中断当前等待                            |
| 下一条用户消息         | 保留并可继续 wait/read                              |
| `/compact`             | 保留                                                |
| `/rewind`              | 保留，但提示进程的后续文件写入不受 rewind 保护      |
| `/clear`               | dispose 成功后才丢弃 LoopState；部分失败则保留      |
| `/resume`              | dispose 成功后才切换；新 manager 使用新 instance id |
| CLI 正常退出           | shell grace + force 优先，随后普通 drain            |
| SIGTERM / POSIX SIGHUP | 进入同一个幂等 graceful shutdown coordinator        |
| 第二次 Ctrl+C          | 同步 best-effort force kill 后立即退出，不承诺确认  |
| sub-agent 完成         | runner `finally` 中结构化 dispose                   |
| print mode 完成/异常   | `finally` dispose 它持有的最终 LoopState            |
| root 自然退出          | 保留 tree target；tree confirmed 后才进入 tombstone |
| CLI 重启后恢复 session | 旧 shell id 不恢复，返回明确错误                    |

### 15.1 `/clear`、`/resume` 与 manager dispose

`/clear` 和 `/resume` 当前同步切换状态，需要改为 async。顺序：

1. manager 原子设置 `acceptingStarts = false`，让 starting session 进入 dispose 路径。
2. 保持当前 event subscription，调用 `dispose(reason, budget)`；退出/失败仍可更新 TUI。
3. 如果所有 live session 都 tree-confirmed/already-tree-exited，继续等待 bounded output finalization、enqueue
   `exited` 并 drain EventHub，之后才关闭旧 hub；CLI unsubscribe 后再替换 LoopState。root-exited 但 tree live
   不属于 already-exited。
4. 如果存在 `failed`/`still-running`，显示每个 shell id 和原因，保留旧 LoopState/manager 以及终止句柄，不执行
   clear/resume。manager 保持 draining（不再接受新 shell），用户可以再次 `/stop` 或退出 CLI。

`dispose()` 对一次 in-flight 调用做 single-flight，React cleanup、slash command、signal handler 和 hard timeout
并发时不重复发信号。全部 tree confirmed 且 output/event drain 完成后 memoize success 并关闭 EventHub；部分失败时保留 hub、残余 process handle 和
`dispose-failed` 状态，后续 `/stop` 或 shutdown 可以重试 residual set。不能在终止前先关 hub，否则 UI 看不到
失败。

旧 id 错误：

```text
Background shell <id> is no longer available in this manager generation. Shell sessions do not survive /clear, /resume, or CLI restart.
```

### 15.2 Interactive CLI shutdown

当前 `gracefulShutdown()` 把所有 finalizer 放进共享 1.5 秒 race，不能保证 manager 有 grace + force 时间。改为
两阶段 coordinator，并修改 `packages/cli/src/index.ts`、`app.tsx` 和 `use-agent.ts`：

```ts
const SHELL_SHUTDOWN_BUDGET: TerminationBudget = {
  gracefulMs: 1_000,
  forceMs: 1_000,
  confirmMs: 250,
}
const ORDINARY_DRAIN_BUDGET_MS = 1_500
const CLI_SHUTDOWN_HARD_CAP_MS = 4_000
const EMERGENCY_RESERVE_MS = 500
const EMERGENCY_PER_PROCESS_FALLBACK_MAX_MS = 75
```

1. `useAgent` 向 CLI 注册 `CliCleanupController`，其中 shell manager termination 与 session/memory/fork drain
   是两个方法，不再只有一个不可分优先级的 `getCleanupFn()`。
2. 正常 `/exit`、Ink unmount、首个 SIGINT、SIGTERM，以及 POSIX SIGHUP 都进入同一个 single-flight coordinator。
3. 第一阶段独占 shell budget，调用 active manager `dispose('cli-shutdown')`；所有 session 并行 grace → force →
   confirm。
4. 第二阶段再并行 saveSession、memory、fork、MCP、peer、browser 和 SessionEnd drains，预算上限仍为 1.5 秒，但
   实际 deadline 取 `min(phaseStart + 1_500, shutdownStart + 3_500)`，为 emergency 预留 500ms。
5. `shutdownStart + 3_500ms` watchdog 停止等待普通 drain并进入 emergency；
   `shutdownStart + 4_000ms` 是包括 emergency 在内的绝对 deadline，不是在 4 秒后再额外开始逐 target timeout。
6. 无论 async 阶段正常完成还是 watchdog 触发，任何 `process.exit()` 前都检查 registry。仍有 target 时调用
   `forceTerminateManagedShellsSync(reason, absoluteDeadline)`；记录 `force-sent-unconfirmed`、`failed` 和
   `deadline-exhausted`，不能计为 stopped。恢复 terminal 后退出，若原退出码为 0 但仍有未确认 target 则改为非零。

`main().catch` 在 cleanup controller/targets 已存在时也必须走 `gracefulShutdown(1)`，不能直接 `process.exit(1)`。
真正无法 await 的 `uncaughtExceptionMonitor` 至少调用
`forceTerminateManagedShellsSync('fatal-exit', performance.now() + 500)` 再恢复 terminal，让 fatal path 不完全依赖
execa cleanup。

`SIGTERM` 新增显式 handler；`process.platform !== 'win32'` 时同时注册 `SIGHUP`，使用 termination reason
`sighup` 和相同 4 秒 coordinator。handler 注册后必须移除 Node 的默认立即退出行为，并保持事件循环直到 cleanup
完成或 absolute deadline；这覆盖 terminal close/SSH disconnect 的可捕获路径。SIGKILL、断电或 runtime 崩溃到
无法执行 monitor 的场景仍不承诺 graceful confirmation，但 Windows Job kill-on-close 与 POSIX emergency registry
继续提供 best effort。

SIGTERM/SIGHUP handler 在 interactive/print mode 分支前安装；优先调用 active cleanup controller，没有 controller
但 registry 有 target 时仍执行同步 emergency fallback。因此 print mode 不能因没有 React ref 而绕过 SIGHUP cleanup。
SIGHUP 路径先启动 shell termination，再做普通 drain；terminal 已断开时的 EPIPE/render failure 必须隔离，不能中断
manager cleanup。

第二次 Ctrl+C 是 emergency path：创建 `performance.now() + 500ms` 的全局 absolute
deadline，POSIX 对保留的 PGID 发 SIGKILL；Windows 优先调用 Job provider 的同步 force/close，只有 provider
不可用时才以 supervisor PID 调用 `spawnSync(taskkill.exe, ..., { timeout: min(75, remaining) })`。每次操作后重算
remaining，deadline 到达后其余 target 标记 `deadline-exhausted` 并立即恢复 terminal/退出。该路径只能 best
effort，不能声称满足 graceful no-orphan 验收。

registry 位于 Core shell-session 模块，manager 在 process handle 出现/确认退出时同步 add/remove。Core 向 CLI
暴露窄化的
`forceTerminateManagedShellsSync(reason: TerminationReason, absoluteDeadline: number): EmergencyTerminationResult`
runtime helper，使
interactive 与 print mode 都不依赖 React ref 是否已经注册。

registry 只保存在当前进程内，不写 session/PID 文件。target 在 `handleAttached` 的同一调用栈登记，保存
manager/shell identity 和 provider-owned tree locator：POSIX PGID，或 Windows supervisor/Job handle。只有
`treeConfirmedExited` 状态提交后才移除；root child 的 `exitCode`/`signalCode` 不能触发 remove 或 skip。所有分支
只消费 spawn 时登记的精确 target，不接受用户输入 PID、glob 或重建出来的旧 PID。

sync helper 必须 no-throw、逐 target 捕获错误并在每次调用前检查 monotonic absolute deadline。Windows fallback
的 `spawnSync` timeout 只能使用剩余全局时间与 75ms 的较小值，最多 64 个 target 也不能演化成
`64 × perTargetTimeout`。成功发送 force 仍只返回 `force-sent-unconfirmed`；只有 async tree provider 的确认事件
才能返回 confirmed。

### 15.3 Print mode

`runPrintMode()` 必须在调用 `agentLoop()` 前显式创建/hydrate 一个 LoopState，并把引用提升到外层 `try/finally`：

```ts
const state = initialSession ? hydrateLoopState(initialSession, mode) : createLoopState(mode)
try {
  await agentLoop(prompt, model, options, callbacks, state)
  await saveSession(state, model)
} finally {
  const shutdownStartedAt = performance.now()
  const absoluteDeadline = shutdownStartedAt + CLI_SHUTDOWN_HARD_CAP_MS
  const result = await state.shellSessions.dispose('print-exit', SHELL_SHUTDOWN_BUDGET)
  await finalizePrintShellCleanup(result, absoluteDeadline)
  await drainUntil(memoryDrain(), absoluteDeadline - EMERGENCY_RESERVE_MS)
}
```

`finalizePrintShellCleanup()` 复用 interactive coordinator 的 residual 规则：若 async grace/force 后 registry 仍有
target，退出前把同一个 `absoluteDeadline` 传给同步 emergency force，记录未确认 id，并把原本成功的 print exit
code 改为非零。该函数不得为每个 target 创建新的 timeout 或延长 deadline。这样
agentLoop 抛错、SIGINT abort、模型留下未读取 shell id 或 saveSession 失败时都仍能找到最终 manager；partial
failure 也不会被静默吞掉。

## 16. 容量与回收

```ts
const MAX_ACTIVE_SESSIONS = 64
const COMPLETED_RETENTION_MS = 5 * 60 * 1000
```

回收顺序：

1. 已退出且 final-observation lease 的 `ack()` 已提交。
2. 已退出、final observation 仍 pending 且超过 retention；记录 abandoned 后回收。
3. 最久未使用且不处于 `claimed` 的 exited session。
4. 如果 64 个全部是 live session，拒绝启动新 session。

这里 live 按 `treeConfirmedExited === false` 定义；root-exited residual tree 仍占 live capacity，不能当 completed
entry 淘汰。

`claimed` entry 不参与普通 TTL 回收；observer handler 必须在 `finally` 中 ack 或 release。manager shutdown 才可
把残留 claim 标为 abandoned，避免 Post hook 执行中 tombstone 被删除。

拒绝信息应包含 `/ps` 和 `/stop` 提示。

这里有意不完全复制 Codex：容量压力下不静默终止 live LRU，避免杀掉用户仍在使用的 dev server 或构建
进程。

## 17. 权限与 Authority

### 17.1 Shell request preparation

不能把 raw `cwd` 只传给 provider。所有后续安全决策必须消费同一个最终 `PreparedShellRequest`：

```ts
interface PreparedShellRequest {
  command: string
  requestedCwd?: string
  effectiveCwd: string
  projectCwd: string
  initialWait: InitialWaitPolicy
  hardTimeoutMs?: number
  tty: boolean
  hookInput: Record<string, unknown>
}
```

固定顺序：

1. `LoopState.projectCwd` 在创建/hydrate 时从 CLI invocation cwd 捕获，不随 `process.chdir()` 变化。
2. 对 raw `cwd ?? projectCwd` 做 preliminary resolve、directory/access 检查和 realpath canonicalization。
3. 把 canonical cwd 放入 hook args，以该 cwd 执行一次原始 `shell` 的 PreToolUse；hook 可以修改
   command/yield/timeout，但不能改变 cwd。
4. 对 hook 修改后的完整输入重新解析和验证。若 hook 删除/替换 cwd 后解析结果与 preliminary cwd 不同，拒绝
   执行；相同 cwd 仍重新 stat/realpath 以防 TOCTOU，不直接复用第 2 步对象。
5. central authority、loop guard、permission、特殊命令拦截和 provider 全部使用同一个 final request。
6. session 保存 final request 与 launch-time security/hook context，供最终 PostToolUse 恢复。

任何一步失败都不得 spawn。路径解析使用 `node:path`、`fs.realpath`/`stat`，不假设 POSIX 分隔符或大小写语义。
限制 Pre hook 改 cwd 是为了保证单次 Pre 事件、authority、permission、Post 和 provider 看到同一目录；若未来要
支持 hook 重定向 cwd，需要新增独立 preflight hook，不能重复触发现有 PreToolUse。

### 17.2 Permission 与规则身份

- `shell` 启动前按 final command + `effectiveCwd` 执行现有命令分类和权限检查。
- permission API 拆分 `projectCwd` 与 `executionCwd`：前者决定项目权限文件位置，后者参与规则匹配。
- `AllowRule` 的 shell 规则增加 canonical `cwd` 字段；command prefix/exact 相同但 cwd 不同不能命中。
- `.x-code/local/permissions.json` 仍写在 `projectCwd`，不会因为命令进入子目录就在任意目录创建权限文件。
- permission dialog 同时显示 command、requested cwd 和 canonical effective cwd。
- 自动 yield 不重新询问权限。
- `shellOutput`/`killShell` 不重新分类原始 command，但仍检查 shell id 属于当前 manager。
- `killShell` 和非空 stdin 属于 local mutation；空输入 wait/read 属于 sensitive read。

建议规则形态：

```ts
interface ShellAllowRule extends AllowRule {
  tool: 'shell'
  cwd: string
}
```

`sessionRulesMatch()`、`buildAllowRule()`、`persistRule()` 和 label/preview 测试必须一起更新，避免只把 cwd 显示给
用户却仍按 command-only 复用批准。

### 17.3 Peer-tainted authority

- `evaluateToolAuthority()` 接收 final `effectiveCwd`，不能继续硬编码 `process.cwd()`。
- shell 的 `canonicalCallSha256` 和 outbound payload 都包含 `{ command, cwd }`；approval 回验使用相同对象。
- 空输入 wait/read 仍属于 sensitive read，继续经过 central authority。
- 非空 stdin 或 `killShell` 的 authority preview 必须显示：
  - manager instance 与完整 shell id
  - 原始 session command
  - session `effectiveCwd`
  - 将写入的完整 chars 或 termination reason
- peer-tainted transport 只允许 allow-once，不能复用不完整 payload 的批准。

### 17.4 Hooks、provider 与特殊命令的 cwd

- PreToolUse/PostToolUse 的 `session.cwd` 均为该 command 的 final `effectiveCwd`；Pre hook 改 cwd 会被拒绝。
- manager/provider spawn 的 cwd 只能来自 `PreparedShellRequest.effectiveCwd`。
- `sed -i` 特殊拦截保留在 manager 之前，但位于 Pre hook、authority、loop guard 和 permission 之后；解析文件
  路径时以 `effectiveCwd` 为基准。
- checkpoint 文件仍写入 `projectCwd` 对应的 session store；被修改文件的绝对路径按 `effectiveCwd` 解析。
- hook 修改后的 command 如果变成可拦截的 `sed -i`，同样走拦截；拦截成功时不创建 shell session，直接走
  普通最终 shell result/PostToolUse。
- 解析或 IO 失败才回落到 unified manager。请求 immediate/background 不得绕过这层保护。

因此“所有 Shell 命令进入 manager”准确含义是：所有未被现有安全/编辑语义拦截的**外部进程**共用 manager，
而不是把 manager 提前到 permission 和 sed checkpoint 之前。Codex 也在进入 unified process manager 前保留
特殊命令拦截。

### 17.5 输出安全

- 命令输出可能包含 secrets，不写入 debug log。
- UI 展示前清理控制序列。
- authority preview、permission dialog 和 `/ps` 内容使用现有 terminal-safe 文本路径。
- 不接受跨 `managerInstanceId` 的 shell id。

## 18. Hooks

当前全局 PreToolUse 位于 bypass handler 之前，因此仅增加一个 result helper 不够。先给每种工具定义显式
policy，再由 dispatcher 决定是否进入通用 hook 路径：

| 工具          | 自身 PreToolUse | 自身 PostToolUse | 观察终态时提交原始 shell Post |
| ------------- | --------------- | ---------------- | ----------------------------- |
| `shell`       | 一次            | 终态首次观察一次 | 是                            |
| `shellOutput` | 禁用            | 禁用             | 是                            |
| `killShell`   | 禁用            | 禁用             | 是                            |
| UI `/stop`    | 不适用          | 不适用           | 否，仅保留 final observation  |

`shellOutput` 和 `killShell` 都是已批准 command 的 transport。`killShell` 仍经过 authority 的 local-mutation
检查，但不形成第二对 plugin hooks；这与 Codex `write_stdin` 明确返回 `pre_tool_use_payload() = None` 的做法
一致。

建议 dispatcher 增加静态 policy：

```ts
const TOOL_HOOK_POLICY = {
  shell: { pre: 'self', post: 'deferred-original' },
  shellOutput: { pre: 'none', post: 'observe-original' },
  killShell: { pre: 'none', post: 'observe-original' },
} as const
```

transport policy 必须在现有全局 PreToolUse block **之前**检查，不能只在 bypass handler 内跳过，否则 Pre
已经发出。

### 18.1 Launch-time hook context

`HookBus.replaceRegistry()` 当前会在 `/plugin refresh` 时原地换 registry，因此 generation number 本身不够；必须
捕获可执行的 immutable hook snapshot。建议给 HookBus 增加：

```ts
interface ToolHookSnapshot {
  generation: number
  toolName: string
  preHooks: readonly RegisteredHook[]
  postHooks: readonly RegisteredHook[]
}

interface HookBus {
  captureToolSnapshot(toolName: string): ToolHookSnapshot
  emitToolSnapshot(
    snapshot: ToolHookSnapshot,
    phase: 'pre' | 'post',
    event: Extract<HookEvent, { name: 'PreToolUse' | 'PostToolUse' }>,
    options?: EmitOptions,
  ): Promise<HookDecision[]>
}
```

snapshot 在 shell Pre 前从同一 `HookRegistry` 复制并 freeze 两个已按 matcher 过滤的有序数组；
`replaceRegistry()` 递增 generation 并只影响之后 capture 的 command。旧 snapshot 强引用原 `RegisteredHook`
配置，因此 refresh/uninstall 期间 Post 仍尝试同一组 hook；脚本已经被删除时按该 snapshot 中的 failure policy
处理，不能静默改投新 registry。

session 保存不可变的实际启动上下文，而不是只有 call id/args：

```ts
interface ShellHookOrigin {
  toolCallId: string
  toolName: 'shell'
  effectiveArgs: Record<string, unknown> // Pre hook 修改并重新验证后，实际执行的输入
  effectiveCwd: string
  modelId: string
  authority: ExecutionAuthority
  authorityApprovedOnce: boolean
  preToolUse: 'executed' | 'skipped-peer-tainted' | 'not-configured'
  hookRegistryGeneration: number
  hookSnapshot: ToolHookSnapshot
}

type FinalObservationState =
  | { status: 'pending' }
  | { status: 'claimed'; claimId: string; observerToolCallId: string }
  | { status: 'acked'; claimId: string; observerToolCallId: string }
  | { status: 'abandoned'; reason: TerminationReason | 'retention-expired' }
```

Post payload 使用 `ShellHookOrigin.toolCallId`、实际执行的 `effectiveArgs`、launch-time model/authority 和
`effectiveCwd`，并通过 `hookSnapshot.postHooks` 执行。不能使用观察时 `shellOutput` 的 args、当前 model、当前
cwd/authority 或 refresh 后 HookBus 的当前 registry。

### 18.2 Final observation transaction

初始 `shell`、`shellOutput` 或 `killShell` 首次看到 terminal session 时，manager 与 dispatcher 按以下边界执行：

1. manager 在 `interactionLock` 内执行 `pending → claimed`，peek 最终 output/metadata，并返回
   `{ kind: 'terminal', result, lease }`；没有 lease 的普通 `ShellExecutionResult` 不能代表一个待提交终态。
2. 若当前调用发过 `wait-started`，manager 在返回前发布匹配 `wait-finished`、resolve interaction barrier 并释放
   lock。claim/lease 继续保护 tombstone，async `exited` 不等待 plugin hook。
3. dispatcher 使用 `lease.origin.hookSnapshot` 和 `lease.post` 至多执行一次原始 shell PostToolUse。即使只配置
   Post 而未配置 Pre 也允许；Pre 因 peer-taint 跳过时 Post 同样跳过，Pre deny 时没有 session。
4. hook 修改后的 output 成为当前 observer 的 model-visible output；`result.isError` 使用第 5.4 节固定映射，不能
   因 hook 改文本而重新猜测。
5. dispatcher 同步 append 与当前 observer `toolCallId/toolName` 匹配的 tool result；该 append 是 transaction 的
   commit point。
6. append 成功后，在同一同步调用栈且任何 UI callback 之前立即调用 `lease.ack()`；它 drain final unread output、
   标记 Post 已提交、resolve claim settlement 并允许回收 tombstone。UI notification 在 ack 后通过 no-throw adapter
   发出，callback 异常只能记日志，不能把已提交 lease 重新 release 或追加第二条 tool result。
7. append 前发生不可恢复异常则在 `finally` 调用 `lease.release()`，恢复 pending 并让后续 observer 重试。

dispatcher 伪代码：

```ts
async function commitShellObservation(ctx: HandlerCtx, observation: ShellObservation): Promise<void> {
  if (observation.kind === 'running') {
    pushToolResult(
      ctx.state,
      ctx.callbacks,
      ctx.toolCallId,
      ctx.toolName,
      observation.result.output,
      observation.result.isError,
    )
    return
  }

  const { result, lease } = observation
  let settled = false
  try {
    const output = await runOriginalShellPostFromSnapshot(lease.origin, lease.post, ctx.options.abortSignal)
    appendAckAndNotifyTerminalResult(ctx, output, result.isError, lease)
    settled = true
  } catch (error) {
    if (isAbortError(error, ctx.options.abortSignal)) {
      appendAckAndNotifyTerminalResult(ctx, result.output, result.isError, lease)
      settled = true
      return
    }
    throw error
  } finally {
    if (!settled) lease.release()
  }
}

function appendAckAndNotifyTerminalResult(
  ctx: HandlerCtx,
  output: string,
  isError: boolean,
  lease: FinalObservationLease,
): void {
  appendShellToolResult(ctx.state, ctx.toolCallId, ctx.toolName, output, isError)
  lease.ack() // no-throw；紧跟 transcript append，中间不能 await/callback
  notifyShellToolResultNoThrow(ctx.callbacks, ctx.toolCallId, output, isError)
}
```

另一个 observer 遇到 `claimed` 时由 manager 等待该 claim 的 settlement signal：ack 后 session 已消费，返回明确的
already-observed/unknown-id tool error；release 后重新竞争 lease。它不能复制 peeked final output 或并行运行
第二次 Post hook。

lease `ack()`/`release()` 都是无 await、no-throw、幂等的内存状态转换；不能把可能失败的 IO 放在 tool result
append 与 ack 之间。

Post hook 被 turn abort 中断时不能直接丢弃 tool result。handler 应降级使用未修改的 base output、记录 debug
错误并完成 ack；否则会留下 orphan tool call。所有 observer 之后只得到已 ack 的 terminal status，不会重复
原始 PostToolUse。

异步 exit watcher 只提交 session 状态和 UI `exited`，不异步修改 transcript，也不运行可改写 tool output 的
PostToolUse。如果后台进程在 manager dispose 前从未被模型最终观察，Post 保持 pending 并记录
`finalObservation=abandoned` 诊断；这与 Codex 的 transport/final-observation 边界一致。

## 19. Deferred tools 与 prompt caching

从 deferred catalog 中移除：

```ts
shellOutput
killShell
```

理由：

- 它们是 `shell` 返回 shell id 后立即需要的 transport tools。
- Codex 始终同时暴露 `exec_command` 和 `write_stdin`。
- 两个 schema 较小。
- 避免 `NoSuchToolError → toolSearch → retry`。
- 工具 schema 始终固定，不会因为运行中的进程变化破坏 prompt prefix。

禁止将 shell id、命令、运行时间或进程列表插入 system prompt。动态信息只通过工具结果和 UI side
channel 传递。

工具集合的变化只发生在版本/功能开关边界，不能在某个进程启动后动态扩展工具列表。

### 19.1 Sub-agent transport dependency closure

sub-agent 的显式 allowlist 当前可能只有 `shell`。自动 yield 后，`shell` 必须和两个 transport tools 视为一个
静态能力组：

```ts
const SHELL_TOOL_CLOSURE = ['shell', 'shellOutput', 'killShell'] as const

if (allowSet.has('shell')) {
  allowSet.add('shellOutput')
  allowSet.add('killShell')
}
```

closure 在 `buildTools()` 应用 allowlist 前完成，并在构建 byte-stable tool surface 时固定。规则：

- 内置和自定义 agent 只要允许 `shell`，就自动获得 `shellOutput`/`killShell`，无需逐个修改所有定义。
- transport 只能访问 sub-agent 自己 fresh LoopState 的 manager，不能扩大到 parent shell。
- 显式 deny `shellOutput` 或 `killShell` 与 allow `shell` 冲突时，registry validation fail closed：拒绝该 agent
  定义或移除整个 shell capability，并给出明确诊断；不能留下会返回不可管理 shell id 的半套工具面。
- plan/read-only filter 可以限制 command，但不能剥掉已启动 shell 的读取和清理 transport。
- sub-agent runner 的 `finally` 无条件调用结构化 `dispose('subagent-finished')`，即使模型从未读取 shell id。

这项 closure 是静态 allowlist 派生，不按运行中 session 动态加工具，因此不会破坏 prompt cache。

## 20. 跨平台进程管理

### 20.1 第一阶段：pipe mode

继续复用现有 shell provider：

- macOS/Linux：用户 Shell `-c`。
- Windows：PowerShell `-EncodedCommand` 和 UTF-8 输出设置。

扩展 provider：

```ts
interface ManagedShellSpawnOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  buffer: false
  isolatedProcessTree: true
}

interface ManagedShellProvider {
  /** 同步附着 cleanup handle；OS spawn 成功由 attempt.ready 异步确认。 */
  spawnManaged(command: string, options: ManagedShellSpawnOptions): ManagedSpawnAttempt
}

interface SpawnReadyResult {
  rootPid: number
  treeKind: 'posix-process-group' | 'windows-job-object'
}

interface ManagedSpawnAttempt {
  handle: ManagedProcess
  ready: Promise<SpawnReadyResult>
  /** no-throw/idempotent；只在 manager 已提交 started 或 residual-registered anchor 后按原序 flush domain frames。 */
  activate(): void
  cancelBeforeReady(reason: TerminationReason | 'turn-abort-before-ready'): Promise<ProcessTerminationResult>
}

interface ManagedProcess {
  rootPid?: number
  stdin?: Writable
  stdout?: Readable
  stderr?: Readable

  waitForRootExit(): Promise<ExitStatus>
  waitForTreeExit(): Promise<void>
  probeTree(): Promise<'live' | 'confirmed-exited' | 'unknown'>
  terminateTree(reason: TerminationReason, budget: TerminationBudget): Promise<ProcessTerminationResult>
  forceTreeSync(deadlineAt: number): 'already-exited' | 'force-sent-unconfirmed' | 'deadline-exhausted' | 'failed'
}
```

POSIX adapter 在 ChildProcess `spawn` event resolve ready、`error` event reject；不能把 `execa()` 返回对象本身当作
ready。Windows adapter 的 handle 是 supervisor，ready 来自 Job assignment 成功的控制帧。两者都必须在返回
attempt 前安装 `spawn`/`error`/protocol listener，避免事件先到而丢失；但 listener 在 `activate()` 前只能更新
provider-owned handle 状态并把 manager-facing output/root/tree frame 放进有界 ordered activation buffer。

`ready` 与 `activate()` 是两个不同 gate：`ready` 证明 OS process/Job 已可管理，`activate()` 才允许向 manager 交付
domain frame。正常路径必须先原子提交 running 和 enqueue `started`；cleanup residual 路径必须先 enqueue
`residual-registered` 与首个 `termination-failed`，之后才可同步调用 `activate()`。activate flush 期间新到 frame 追加到
同一队列尾部，flush 完成后才切到 direct delivery，不能发生越序。activation buffer 复用 session output 的 1 MiB
head/tail cap 并记录 omitted bytes；control frame 不丢。cleanup-confirmed 路径不 activate，而是把 buffered output
直接取入 terminal failure result；tree cleanup 始终可通过 `ManagedProcess.waitForTreeExit()`/`terminateTree()` 工作。

`spawnManaged()` 仅允许在尚未创建任何 OS handle/child 时同步 throw。一旦创建了可存活资源，就必须返回 attempt，
让错误异步落到 `ready` 并由 manager 已登记的 provisional target 清理。

managed spawn 不接收 turn abort signal，也不让 execa 自己执行 hard timeout；两者都可能只杀 wrapper。显式 hard
timeout 由 manager timer 触发统一的 `terminateTree('hard-timeout')`。短命令和后台命令使用同一
`buffer: false` streaming 路径。

### 20.2 进程树终止

这是第一阶段 blocking requirement，不能只依赖 `proc.kill()`，也不能推迟到 PTY。

POSIX：

- spawn 时使用 `detached: true` 建立独立 process group，并在执行用户 command 前记录 group id。
- manager 存活期间不对 root child 调用 `unref()`；CLI 退出必须先走显式 cleanup，而不是让 detached child 静默
  脱离事件循环。
- 优雅终止对 `-pid` 发送 SIGTERM，等待 `gracefulMs`。
- 仍存活则对 group 发送 SIGKILL，等待 `forceMs + confirmMs`。
- `ESRCH` 可视为已退出；`EPERM` 或 deadline 后仍可探测到 group 必须返回 unconfirmed/failed。
- root exit callback 只设置 `rootExited`，不得删除 PGID target。随后对 `kill(-pgid, 0)` 做一次确认：group 已空才
  设置 tree-confirmed；仍 live 则自动执行 `terminateTree('root-exited-residual')`。
- POSIX 没有“process group empty”事件，因此 grace/force 的 confirm 窗口允许使用 25ms 起、最高 100ms 的有界
  backoff 调用 `kill(-pgid, 0)`。这是显式 tree cleanup 的 bounded confirmation，不得复用于普通 output/wait
  状态查询。
- 所有负 pid 操作必须封装在 POSIX provider，不能泄漏到公共逻辑或测试。

Windows：

- 第一阶段新增 audited native Job Object supervisor；仅靠 root PID + `taskkill /T` 无法在 root 先退出后可靠定位
  descendants，不能作为正常 provider。
- supervisor 创建带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 且禁止 breakaway 的 Job Object，以
  `CREATE_SUSPENDED` 创建 PowerShell/root，先 `AssignProcessToJobObject()`，成功后才 resume 并发送 `ready`。任何
  assign/resume failure 都在 root 执行用户 command 前失败并清理 Job。
- command stdout/stderr 使用独立 pipe；supervisor 通过额外 control pipe 发送 `ready`、`spawn-error`、
  `root-exit(exitCode)` 和 `tree-empty`。`tree-empty` 来自 Job completion-port 的 active-process-zero 通知，是
  `treeConfirmedExited` 的唯一正常依据。
- Job handle 只由 supervisor 持有且不可继承给 root/descendants。supervisor 把 CLI control pipe EOF 视为 parent
  death，立即关闭 Job handle 并退出；因此 CLI crash/force exit 也会触发 kill-on-close，而不是留下独立存活的
  supervisor。
- `root-exit` frame 到达且 Job 尚未 `tree-empty` 时，manager 必须立即启动与 POSIX 同名的
  `terminateTree('root-exited-residual')` single-flight，不能只继续被动跟踪 descendants。graceful path 对 Job 内仍
  存活进程发送受支持的软终止；force path 使用 `TerminateJobObject()`。只有收到 `tree-empty` 才返回 confirmed；
  root-exit 本身不关闭 Job handle、不移除 registry target。
- CLI 进程异常退出时，control pipe EOF 促使 supervisor 关闭 Job handle 并触发 kill-on-close；同步 emergency
  优先调用 provider wrapper 的 `forceTreeSync()` 关闭 pipe/handle，`taskkill supervisor /T /F` 只是带全局 deadline
  的最后 fallback，并返回 `force-sent-unconfirmed`。
- helper/native artifact 必须覆盖受支持的 Windows 架构、打包 smoke test 和真实 parent→child CI。helper 缺失、
  protocol 不匹配或 Job assignment 不可用时，spawnReady fail closed；不能静默降级后继续宣称 tree guarantee。

本方案固定实现边界为一个小型 Rust supervisor executable，而不是让 TypeScript 直接重写 Windows spawn：release
CI 为 Windows x64/arm64 构建 `xc-shell-supervisor.exe`，CLI 按 `process.arch` 加载随包 artifact。helper 用带
version/magic/length 的 binary frame 在 stdio 上复用 control、stdout、stderr 和 lifecycle channel，原始 output
作为 bytes frame 传输，不走 JSON 行协议。TypeScript provider 校验 protocol version 和 artifact hash；unsupported
arch 或 artifact 缺失返回明确 spawn failure。这样用户安装不依赖本地 Rust toolchain，同时 Job handle、suspended
CreateProcess 和 completion-port 逻辑被隔离在可独立审计/故障注入的边界。

终止策略按 `process.platform` 选择，而不是按用户 shell 类型选择；Windows 上即使 `SHELL` 指向 Git
Bash/MSYS，也必须走 Job provider，不能对 PID 使用 POSIX group signal。

如果 POSIX 使用 `detached: true` 建立新进程组，需要注意 execa 在 detached 模式下不会使用其默认 exit
cleanup。此时 manager、CLI shutdown 和 signal handler 必须成为主要清理路径。

manager 对同一 session 的所有 terminate 请求做 single-flight；后来的 `/stop`、hard timeout、dispose 共享同一
Promise，但保留第一个获胜的 `terminationReason`。所有 session 并行终止，使 shutdown budget 不随 session
数量线性增长。

termination flight 使用 manager-owned controller。调用方的 turn abort 只取消对该 Promise 的等待并产生匹配
tool result，不取消 flight 本身；CLI lifecycle 调用则持续等待到其 budget/deadline。flight 失败结算后清除
in-flight slot，后续显式 retry 才能创建新 attempt。

第一阶段验证 root 正常存活、root 先退出和显式 terminate 三种情况下的 managed descendants 全部退出。POSIX
命令主动 setsid/double-fork 脱离 PGID 仍属于明确的非目标边界；Windows Job 不开放 breakaway，无法 assign 时
spawn fail closed。任何无法确认的状态都作为部分失败报告，而不是静默成功。

### 20.3 后续阶段：PTY

```ts
interface PtyProcess extends ManagedProcess {
  write(chars: string): Promise<void>
  resize?(cols: number, rows: number): Promise<void>
}
```

建议评估 `node-pty`：

- POSIX PTY。
- Windows ConPTY。
- Node 22 预构建包可用性。
- pnpm 安装与 workspace 打包。
- 三平台 CI 的 native module 稳定性。

只有 Windows、macOS、Linux CI 全部通过后，才在公开 schema 中启用 `tty: true`。

非 PTY session：

- `chars === ''`：允许等待。
- `chars === '\x03'`：映射为 interrupt/terminate。
- 其他非空输入：返回 `stdin is unavailable for non-TTY shell session`。

PTY session：

- 允许任意输入。
- write 和 drain 在 interaction lock 内完成。

## 21. 文件改动范围

### 21.1 Core 新增

```text
packages/core/src/tools/shell-session/manager.ts
packages/core/src/tools/shell-session/session.ts
packages/core/src/tools/shell-session/event-hub.ts
packages/core/src/tools/shell-session/output-buffer.ts
packages/core/src/tools/shell-session/wait-notifier.ts
packages/core/src/tools/shell-session/shutdown-target-registry.ts
packages/core/src/tools/shell-session/providers/posix-process-group.ts
packages/core/src/tools/shell-session/providers/windows-job.ts
packages/core/src/tools/shell-session/providers/windows-supervisor-protocol.ts
packages/core/src/tools/shell-session/types.ts
packages/core/native/windows-job-supervisor/Cargo.toml
packages/core/native/windows-job-supervisor/src/main.rs
```

### 21.2 Core 修改

```text
packages/core/src/tools/background-shell.ts
packages/core/src/tools/shell.ts
packages/core/src/tools/shell-provider.ts
packages/core/src/tools/index.ts
packages/core/src/index.ts
packages/core/src/agent/loop.ts
packages/core/src/agent/loop-state.ts
packages/core/src/agent/session-store.ts
packages/core/src/agent/snapshot.ts
packages/core/src/agent/tool-execution.ts
packages/core/src/agent/tool-search/catalog.ts
packages/core/src/agent/sub-agents/built-in.ts
packages/core/src/agent/sub-agents/registry.ts
packages/core/src/agent/sub-agents/runner.ts
packages/core/src/hooks/bus.ts
packages/core/src/hooks/registry.ts
packages/core/src/types/index.ts
packages/core/src/permissions/index.ts
packages/core/src/permissions/authority.ts
packages/core/src/permissions/session-store.ts
packages/core/src/permissions/persistence.ts
```

### 21.3 CLI 新增

```text
packages/cli/src/ui/app/commands/background-terminal.ts
```

### 21.4 CLI 修改

```text
packages/cli/src/index.ts
packages/cli/src/print.ts
packages/cli/src/app.tsx
packages/cli/src/ui/agent/use-agent.ts
packages/cli/src/ui/agent/agent-tool-lifecycle.ts
packages/cli/src/ui/agent/use-agent-display.ts
packages/cli/src/ui/agent/use-agent-display-helpers.ts
packages/cli/src/ui/chat-input/types.ts
packages/cli/src/ui/chat-input/reducer.ts
packages/cli/src/ui/chat-input/ChatInput.tsx
packages/cli/src/ui/render/stdout-writer.ts
packages/cli/src/ui/utils.ts
packages/cli/src/ui/app/App.tsx
packages/cli/src/ui/app/command-content.ts
packages/cli/esbuild.config.js
```

Core 不依赖 CLI 或 UI。Core 只定义领域事件，CLI 决定如何绘制。

### 21.5 Native/packaging 修改

```text
package.json
packages/core/package.json
packages/cli/package.json
.github/workflows/pr-check.yml
.github/workflows/release.yml
packages/cli/tests/package/install-smoke.test.ts
```

release workflow 构建 Windows x64/arm64 helper、生成 hash manifest，并把 artifact 同时复制到 core package 与 CLI
bundle 的 `dist/native/windows/<arch>/`。非 Windows PR 至少运行 protocol/fake-provider 和 package-content 测试；
Windows CI 必须运行真实 Job Object tree test。发布包缺任一受支持 artifact 即失败，不能在 npm install 时临时
下载未校验二进制。

### 21.6 最低测试文件范围

```text
packages/core/tests/background-shell.test.ts
packages/core/tests/shell-session-manager.test.ts
packages/core/tests/shell-output-buffer.test.ts
packages/core/tests/shell-provider.test.ts
packages/core/tests/agent-loop.test.ts
packages/core/tests/hooks.test.ts
packages/core/tests/permissions.test.ts
packages/core/tests/permission-persistence.test.ts
packages/core/tests/peer-authority.test.ts
packages/core/tests/session-store.test.ts
packages/core/tests/snapshot.test.ts
packages/core/tests/api-exports.test.ts
packages/core/tests/__snapshots__/api-exports.test.ts.snap
packages/cli/tests/agent-tool-lifecycle.test.ts
packages/cli/tests/turn-coordinator.test.ts
packages/cli/tests/pty/tui-interrupt.test.ts
```

CLI shutdown/print 的 coordinator 若无法通过现有测试 seam 隔离，应新增专用 lifecycle 测试文件；不能仅以手工
退出验证替代。测试断言按第 22 节组织，最终文件名可在实现时做最小调整。

## 22. 测试方案

### 22.1 Output buffer

新增 `packages/core/tests/shell-output-buffer.test.ts`：

- 小输出不截断。
- 超限保留 head/tail。
- omitted byte 数正确。
- drain 后归零。
- 中文字符不会在 chunk/slice 边界损坏。
- 单个大 chunk 正确截断。
- stdout/stderr 合并顺序稳定。
- ANSI/OSC 清理。

### 22.2 Manager

新增 `packages/core/tests/shell-session-manager.test.ts`：

- 快速退出不返回 shell id。
- 超过 yield 自动返回 shell id。
- `runInBackground: true` 立即返回。
- `yieldTimeMs: 0` 在 POSIX/Windows 都走 immediate sentinel，不被最小值或 Windows floor clamp。
- 正数 initial wait 和 empty/non-empty transport wait 分别按定义范围 clamp。
- 省略 `block/yieldTimeMs` 的空 `shellOutput` 默认 timed 5 秒；显式 `block:false` 与 `yieldTimeMs:0` 立即返回。
- 空输入 wait/read 返回增量输出。
- wait 期间退出会被 completion 事件提前唤醒。
- turn abort 在返回 id 前原子设置 yielded 并发布 reason=`turn-abort`。
- abort 发生在 spawn request 前不返回 id；handleAttached 后、spawnReady 前会 cancel/settle，绝不返回未 ready id。
- `spawnManaged()` 在创建 handle 前同步 throw：`handleAttached` resolve 为 `failed-before-handle`、starting entry 删除、无 shutdown target，
  failure tombstone 仍可闭合 Pre/Post lease。
- fake provider 同步返回 handle、异步触发 ENOENT error且 cleanup confirmed：不发布 started/yielded、不返回 id，
  临时 entry/target 在 cleanup + lease ack 后消失。
- fake provider 的 spawnReady failure + cleanup unconfirmed：返回 `cleanupResidual=true` 的可管理 id，严格发布
  `residual-registered → termination-failed`，`shellOutput`/`killShell`/`/stop` 可继续操作；不得返回 terminal lease。
- provider 在同一个 callback/frame batch 交付 `ready → output → root-exit`：ready 前全部进入 activation buffer，manager
  先提交 `started`，activate 后严格发布 `started → output → root-exited` 并启动 residual termination flight。
- hard timeout 在 yield 后无人再次读取时仍终止进程并保留 final tombstone。
- starting 期间 dispose 不允许迟到的 process 逃逸。
- ready/activate 后、initial 10 秒 wait 中调用 dispose：`manager-draining` lifecycle 立即唤醒 start，原始 tool call
  返回 matched draining observation，不等 yield deadline。
- hard timeout 在 initial yield deadline 前触发且 tree cleanup failure：`termination-failed` lifecycle 立即唤醒 start，
  返回 error + 可管理 id，不等 yield deadline。
- ready session 的 root exit、tree confirmation、output finalization 三者独立；任一缺失都不 resolve completion。
  failed-launch residual 不要求伪造 root exit，但仍必须等待 tree confirmation + output finalization。
- root 已退出但 tree live 时 observation 仍 `running:true/rootExited:true/treeConfirmedExited:false`，registry target
  保留。
- kill/terminateAll 返回 confirmed、failed 和 still-running 的结构化结果。
- 部分 dispose 失败保留 residual handle，后续 retry 只处理 residual set。
- `killShell` 等待被 turn abort 后 termination flight 继续，当前 tool call 有匹配 result，最终仍发布 exit/failure。
- 同 session 两次 interact 串行。
- 不同 session 可并行。
- completed retention 回收。
- 64 个 live session 后拒绝新进程。
- `terminateAll()` in-flight single-flight；成功结果幂等，部分失败后只重试 residual set。
- cleanup-confirmed spawn failure 不返回 id；cleanup-unconfirmed 只能返回显式 `cleanupResidual` id，不能隐藏 target。
- tree live 时即使 stdout/stderr 静默超过 100ms 也不 final；真实 EOF 可立即 final，或 tree-confirmed 后单次 trailing
  grace 才 end decoder。所有 trailing output 排在 `exited` 前。
- dispose 在 tree confirmed 后仍等待 bounded output finalization 和 EventHub drain；不能先 close hub 而丢失最后 output/
  `exited`。
- dispose 唤醒所有 waiter。
- manager-draining lifecycle 只唤醒一次并立即返回 draining result；用受控 iteration counter 证明没有 microtask
  busy-loop，`setImmediate`/root-exit handler 仍可运行。
- termination-failed lifecycle 立即唤醒长 timeout 的 `shellOutput`，返回 running + structured failure，而不是等
  observer deadline。
- 不使用 interval 或循环 timeout 查询进程状态。
- output generation 变化不会发生 lost wake-up。
- ready session 的 terminal 事件顺序为 `started → output* → exited`；cleanup residual 为
  `residual-registered → termination-failed → output* → exited`，两者的 `exited` 都恰好一次。
- final output 全部排在 `exited` 前，`exited` 后没有 output。
- exit 唤醒 active wait 时，匹配的 `wait-finished` 排在 `exited` 前且无锁死。
- exit watcher 等待独立 interaction barrier，不与持锁等待 completion 的 handler 争 mutex；immediate empty read
  不发布 Waiting/Waited 事件。
- `subscribe({ replayCurrent: true })` 的 snapshot 与后续事件无竞态。
- listener 抛错不影响 session 状态和其他 listener。
- 注入超过 10 MiB output 而暂停 drain 时，pending output 始终 `<=256KiB` 且 `<=128 events`，control event 不丢。
- flood 后 `exited` 在至多 16 个 retained output predecessor 后投递；snapshot/exited 的 recentOutput 不超过 16KiB，
  omitted bytes 正确，seq gap 可接受。
- unsubscribe 后不再收到事件。
- yield deadline 与 exit 同时发生时，`yielded`/`wasYielded` 顺序确定且不矛盾。
- 相同逻辑 `ownerSessionId` 的两个 manager 有不同 `managerInstanceId` 和 shell id。
- hydrate 在构造 LoopState 时传入持久化 owner id，manager 创建后不再覆盖其 owner；每次 hydrate 都产生新 generation。
- snapshot 包含完整 `ShellSessionSummary`、`managerInstanceId`、spawnOutcome/cleanupResidual、termination metadata 和
  `exitedSeq`。
- summary/snapshot 明确区分 rootExited 与 treeConfirmedExited；root-only exit 不被恢复成 exited footer，failed-launch
  residual 不被恢复成正常 started command。

测试命令使用 Node，避免 POSIX 假设：

```text
node -e "setTimeout(() => console.log('done'), 500)"
```

不得在通用测试中依赖 `sleep`、bash、POSIX signal 或 `/tmp` 路径。

### 22.3 Tool execution

扩展 tool-execution 测试：

- `shell` running 结果不触发 PostToolUse。
- 最终 wait/read 触发一次原始 shell PostToolUse。
- 重复 wait/read 不重复 PostToolUse。
- `shellOutput` 和 `killShell` 都不触发自己的 Pre/PostToolUse。
- kill/final wait 观察终态时使用原始 call id、hook-modified args、launch cwd/model/authority 生成 Post payload。
- 两个并发 final observer 只有一个 `claimPostToolUse()` 成功。
- manager terminal observation 必须携带 lease；dispatcher 写入匹配 tool result 后 ack，写入前异常 release。普通
  `ShellExecutionResult` 无法绕过 lease 提前回收。
- 模拟 `callbacks.onToolResult` 在 transcript append 后抛错：lease 已在 callback 前 ack，错误只记录日志，不追加
  重复 tool result、也不重复 Post。
- quick exit 的 `start()`、terminal `interact()` 与 `killShell terminateAndObserve()` 都走同一 lease commit helper；
  UI `/stop` 不 claim lease。
- spawn cleanup residual 的初始 error observation 不提前触发 Post；后续 `killShell`/wait 首次观察 tree-confirmed
  terminal 时提交原始 spawn-failure Post 且仅一次。
- Post hook/tool-result 提交前 tombstone 不删除；ack 后才回收。
- Post hook abort/throw 仍生成匹配 tool result，claim 被 ack 或 release，不留下 orphan。
- shell Pre 前捕获 Hook snapshot；Pre 与 Post 之间执行 `/plugin refresh` 后，旧 command 的 Post 仍只运行旧
  snapshot，新 registry 只用于下一条 command。
- hook snapshot generation、hook-modified args、cwd/model/authority 一起从 lease origin 恢复。
- peer-tainted wait/read 和写 stdin 经过 authority。
- abort 后仍生成匹配 tool result。
- `shellOutput` 和 `killShell` 始终在工具集合中。
- sub-agent allowlist 只有 `shell` 时自动获得两个 transport tools。
- allow shell 但显式 deny transport 时 fail closed，不产生半套工具面。
- system prompt cache 在 session 创建前后 byte-stable。
- 未知和过期 shell id 返回明确错误。
- omitted `block`、显式 `block:false`、`block:true/timeout` 和 `yieldTimeMs` 的优先级逐项回归。
- `isError` 映射覆盖 exit 0、非零 exit、signal、hard timeout、draining、termination-failed、spawn failure 及
  kill confirmed/failed；formatter 不从文本重新推断。
- raw cwd 在 Pre 前后重新验证；hook 尝试改变 cwd 时拒绝且不 spawn；各组件收到同一 final cwd。
- shell authority canonical hash 和 approval preview 包含 canonical cwd；修改 cwd 后旧 approval 校验失败。
- command 相同但 cwd 不同不命中 session/persisted allow rule；permissions 文件仍位于 project cwd。
- 旧版无 cwd 的 persisted allow rule 迁移后只绑定 `projectCwd`，不能成为任意目录 wildcard。
- requested cwd 下的相对 `sed -i` 在 manager 前被拦截，并进入 `/rewind` checkpoint。
- hook 把普通 command 改成 `sed -i` 后仍拦截；background/immediate 参数不能绕过拦截。

### 22.4 Cross-platform process tree

- 用 Node parent → Node grandchild fixture 验证终止完整树，不依赖 `sleep` 或 bash。
- POSIX 验证独立 process group 的 graceful 与 SIGKILL fallback。
- POSIX fixture 让 group leader/root 先退出，普通同组 child 重定向 stdio 后继续存活；断言 target 不移除、不会
  提前 exited，residual group 被 grace/force 清理后才 tree-confirmed。
- POSIX tree-confirmation probe 只在 terminate/root-exit cleanup 窗口按 bounded backoff 运行，不进入普通 wait。
- Windows helper 验证 suspended create → Job assign → resume；assign failure 时用户 command 从未执行且
  spawnReady fail closed。
- Windows fixture 让 root 先退出、Job child 继续运行；不调用 `/stop`，断言 manager 自动启动
  `root-exited-residual` flight、执行 `TerminateJobObject()`，且收到 tree-empty 后才 confirmed。另测 kill-on-close、
  x64/arm64 artifact/protocol/hash。
- Windows supervisor 的 CLI control pipe 被关闭时，即使 root 已退出，也会关闭唯一且不可继承的 Job handle；
  fixture 断言仍存活的 Job child 被 kill-on-close 回收。
- fake provider 注入 EPERM、Job termination failure和 tree-empty 缺失，验证 `/stop` 不误报 stopped。
- emergency registry 在 handleAttached/tree-confirmed 时 add/remove；root exit 不 remove，
  `force-sent-unconfirmed` 不计入 confirmed。
- 64 个 Windows fallback target 每个模拟阻塞：总同步 emergency 时长受单一 absolute deadline 限制，未尝试项为
  `deadline-exhausted`，不是 `64 × timeout`。
- 多个 session 并行 terminate，整体时间受单个 budget 限制而非线性累加。
- hard timeout、`/clear`、`/resume`、sub-agent finally、print exit 和 normal CLI exit 都复用相同 tree API。

这里允许平台条件测试，因为 process group signal 与 Windows Job Object 本身无法等价模拟；通用 manager 语义仍
使用同一组 fake-provider 测试。

### 22.5 CLI lifecycle

- `wait-started` 显示 Waiting。
- `wait-finished` 生成 Waited。
- 同 session 多次空等待只写一次。
- 切换 session flush 前一个 streak。
- 非空 stdin 显示 Interacted。
- footer 数量正确。
- `residual-registered` 即使没有 started/yielded 也创建警告 footer 和 `/stop` 入口；对应 failed-launch `exited`
  移除 footer，但不显示 command-success 文案。
- `root-exited` 不移除 footer；只有 tree-confirmed `exited` 才移除并追加完成摘要。
- 终端宽度不足时安全截断。
- `/ps` 列出命令和最近输出。
- `/stop` 和 `/stop <opaque-shell-id>`。
- `/clear`、`/resume` 只有在旧进程全部确认停止后才替换 LoopState；部分失败保留旧 manager。
- Esc 不停止后台进程。
- A → B → A resume 与直接 resume 当前逻辑 session 都重新绑定新 `managerInstanceId`。
- ownerSessionId 相同但 managerInstanceId 旧的延迟事件不污染新 UI。
- 没有 active agent turn 时，`exited` 仍立即移除 footer 并追加完成摘要。
- `wasYielded: false` 的 `exited` 不生成后台完成摘要。
- 重新挂载后用 snapshot 恢复 footer，且不重复完成摘要。
- `wait-started.toolCallId` 精确隐藏/替换对应 tool row。
- 正常退出、SIGTERM 和 POSIX SIGHUP 先执行 shell budget，再执行普通 drain budget。
- POSIX CLI fixture 在 managed group 存活时接收 SIGHUP：single-flight coordinator 在退出前完成 group cleanup；该测试
  同时注入 stdout EPIPE 并断言不打断 cleanup。该测试平台条件化，因为 Windows 没有等价的 SIGHUP contract。
- CLI 正常 drain 完成或总 hard cap 到达时，只要 registry 仍有 target 就先调用同步 emergency force；未确认终止的
  id 记录为失败，不能计入 stopped。
- graceful shutdown 在 3.5 秒进入 emergency reserve，包含最多 500ms sync cleanup 后仍不超过 4 秒 absolute
  deadline（允许测试调度容差）。
- `main().catch` 有 active manager 时走 graceful shutdown；fatal monitor 调用同步 emergency helper。
- print mode 在 success、agentLoop throw、SIGINT/SIGTERM/POSIX SIGHUP abort 和 save failure 下都 dispose 最终 state manager；partial
  failure 进入 emergency force 并产生非零退出码。
- 第二次 Ctrl+C 调用同步 emergency registry 后退出，并明确只断言 best effort、不纳入 graceful guarantee。

### 22.6 PTY

阶段四启用：

- 启动 REPL。
- 写 stdin。
- 接收 echo/output。
- Ctrl+C。
- 正常 exit。
- Windows ConPTY Unicode。
- resize，如果公开该能力。

平台条件测试只用于无法等价测试的 PTY/信号能力，并在测试中写明原因。

## 23. 实施阶段

### 阶段一：进程正确性

- 新 manager、非持久化 `managerInstanceId` 和不透明 shell id。
- `ShellSessionEventHub`、有序事件队列和 session-local notifier。
- 带 generation/reason 的 lifecycleChanged；draining/failure/completion 显式分支且无 busy-loop。
- 256KiB/128-event output queue cap、control fast lane 和 16KiB recent-output snapshot。
- HeadTailOutputBuffer。
- 事件驱动 wait。
- handleAttached/spawnReady/activate 三阶段 spawn gate；异步 ENOENT 不越过 started，unconfirmed cleanup 暴露 residual id。
- root exit 与 tree-confirmed exit 分离；任一平台自动启动 root-exited-residual flight，target 只在 tree confirmed 后移除。
- output finalization 只接受真实 stream EOF 或 tree-confirmed 后 bounded trailing grace。
- POSIX process group 与 Windows Job Object supervisor tree provider；`taskkill` 仅为 deadline-bound emergency
  fallback。
- 结构化 `terminateAll()`、部分失败、residual retry 和 `dispose()`。
- `/clear`、`/resume`、sub-agent、interactive/SIGTERM/POSIX SIGHUP/print CLI exit 清理。
- starting/dispose、hard-timeout-without-reader 和 emergency target registry。
- 数量上限和 tombstone。
- 保留当前 `runInBackground` 用户行为。

完成门槛：现有后台 Shell 测试通过；manager identity、三阶段 spawn gate、root-before-child-exit、process tree、部分
终止失败和所有退出路径测试通过；除明确标记为 best-effort 的 double Ctrl+C、不可捕获 runtime death 与 POSIX
主动 setsid/double-fork 外，三平台不遗留 managed descendants。Windows Job helper 的真实 CI/packaging test 未通过
时阶段一不得完成。

### 阶段二：自动 yield

- 普通 `shell` 默认等待 10 秒。
- initial wait 与 transport 共用 lifecycle-aware observation loop。
- immediate sentinel 与正数 clamp 语义固定。
- 移除默认 30 秒硬 timeout。
- running result 返回 shell id。
- Esc 原子 transition-to-yielded 后只取消等待。
- `shellOutput` 新参数和兼容适配。
- 省略 `shellOutput.block` 默认等待 5 秒；显式 `block:false` 保持 immediate。
- requested/effective cwd preparation 贯穿 authority、permission、hooks、sed 和 provider。
- transport-specific hook policy 与 claim/ack final observation transaction。
- manager→dispatcher `ShellObservation`/`FinalObservationLease` API 和固定 `isError` 映射。
- launch-time immutable Hook snapshot/generation，refresh 不拆散 Pre/Post pair。
- transport tools 改为始终加载，并为 sub-agent allowlist 做 dependency closure。
- 保留 `sed -i`/checkpoint 特殊路径。

完成门槛：持续超过 10 秒的 `pnpm lint` 不会被杀死，模型能在下一轮继续 wait/read。

### 阶段三：TUI 对齐

- CLI 常驻订阅 `ShellSessionEvent`。
- Waiting/Waited streak。
- background footer。
- `/ps`、`/stop`。
- async exit 摘要。
- 隐藏空 `shellOutput` 普通工具行。

完成门槛：用户看到：

```text
• Waited for background terminal · pnpm lint
```

### 阶段四：PTY

- `node-pty`/ConPTY。
- `tty` 参数。
- 非空 stdin。
- PTY terminal control input 和 resize；复用阶段一已有的 tree termination。
- 三平台 CI。

## 24. 兼容与迁移

### 24.1 工具兼容

- 保留 `runInBackground`。
- 保留 `shellOutput.block` 和 `shellOutput.timeout`。
- 保留 `bg_` 前缀，但迁移为包含 manager nonce 的不透明 id；不保留严格 `bg_N` 形态。
- 保留 `killShell`。
- 不引入 snake_case 工具名。
- `runInBackground: true`、显式 `yieldTimeMs: 0` 和 `block: false` 通过 immediate sentinel 保留立即返回。

### 24.2 行为变化

- `shell.timeout` 从“省略时默认 30 秒”变为“只有显式设置才是硬 timeout”。
- `shellOutput({ shellId })` 从当前立即返回改为默认通知等待 5 秒；显式 `block:false` 或 `yieldTimeMs:0` 仍立即
  返回。tool schema/description 与 CHANGELOG 必须明确该差异。
- `shellOutput` 首次观察非零 exit、signal 或 hard timeout 时将 tool result 标为 `isError:true`；running deadline
  仍是成功结果，termination-failed/draining 是错误结果。
- Esc 不再自动杀死已成功启动的 Shell session。
- 后台进程不再固定 30 分钟后自动终止；由 session 生命周期和显式 timeout 管理。
- `/clear` 和 `/resume` 会主动停止当前 session 的后台进程。
- `cwd` 成为 permission/authority identity 的一部分；相同 command 在另一个 cwd 可能重新询问。
- root process exit 不再等价于 shell session 完成；仍有 managed child 时 footer/target 保留并自动清理 residual
  tree。

### 24.3 Session resume

模型 transcript 中可能保留旧 `shellId`，但 OS 进程不恢复。首次访问旧 id 时返回明确错误，引导模型重新
执行命令。不能尝试按 pid 重连，因为 pid 可能已复用，且无法验证进程归属。

旧 permissions 文件中的 shell rule 没有 cwd。加载时只把它绑定到当前 `projectCwd`，不能迁移成 cwd wildcard；
下次写入时使用带 cwd 的新 schema/version。无法安全解析的旧规则跳过并记录 debug warning。

### 24.4 API export

manager 实现、buffer、hook snapshot 内容和内部 session 类型保持 internal。`LoopState.shellSessions` 对 CLI
暴露窄化的 `ShellSessionController`；Core 导出 controller/event/summary、`ShellObservation`、不透明
`FinalObservationLease` 接口、termination result，以及 emergency shutdown 所需的带 absolute deadline
`forceTerminateManagedShellsSync()`。不导出 manager 实现或可伪造 lease 的 constructor。该运行时 export 必须
更新 `packages/core/tests/api-exports.test.ts` 快照。

## 25. 风险与缓解

| 风险                                         | 缓解                                                             |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Esc 语义变化导致用户误以为命令已停止         | Waiting 状态和 footer 明确显示 `/stop` 提示                      |
| `/clear`/`/resume` 竞态产生孤儿进程          | async dispose；部分失败不替换 LoopState                          |
| turn abort 产生 orphan tool call/footer 缺失 | 先原子 yield + event，再提交 matched running result              |
| noisy process 占用内存                       | 双 1 MiB head/tail buffer、完成条目 TTL、session 上限            |
| stdout 含终端控制序列                        | Core UI 输出清理，禁止原始控制字符直写 stdout                    |
| kill 只结束 Shell wrapper                    | provider-specific process-tree termination 和集成测试            |
| root 退出后 child 仍存活                     | 双状态；任一平台自动 root-exited-residual flight                 |
| resolved draining Promise 触发 busy-loop     | versioned lifecycle signal + 显式 return 分支                    |
| ready 同批 output/root event 越过 started    | provider activation buffer；started commit 后 activate/flush     |
| handle 返回后异步 ENOENT                     | handle/ready/activate 分离；unconfirmed cleanup 暴露 residual id |
| detached process 绕过 execa cleanup          | manager shutdown、SIGTERM/SIGHUP handler、sub-agent finally 清理 |
| CLI 共享 drain timeout 挤掉 force-kill 预算  | shell termination 独占第一阶段预算，普通 drain 后置              |
| double Ctrl+C 跳过 async cleanup             | 同步 emergency registry best effort，并明确不保证确认            |
| 64 个 Windows fallback 线性耗时              | 单一 absolute deadline、500ms reserve、剩余时间逐次扣减          |
| deferred tool 尚未加载                       | `shellOutput`、`killShell` 始终加载                              |
| 动态进程状态破坏 prompt cache                | 动态状态只通过工具结果和 UI 事件传递                             |
| background exit 异步修改模型消息顺序         | 异步 watcher 只更新 UI，不修改 `LoopState.messages`              |
| output 到达与 waiter 注册竞态导致漏唤醒      | generation notifier，并测试 drain/subscribe 边界                 |
| initial wait 忽略 lifecycle                  | 与 transport 共用 observation loop                               |
| tree live 时提前结束 decoder                 | EOF 或 tree-confirmed 后 bounded trailing grace                  |
| turn 之间退出或 resume 复用逻辑 session id   | 常驻订阅、snapshot、`managerInstanceId` 过滤                     |
| 老 transcript id 命中新 manager              | manager nonce 写入不透明 shell id，不恢复/复用                   |
| requested cwd 与安全判断/执行目录不一致      | 单一 PreparedShellRequest 贯穿所有路径                           |
| final drain 早于 Post hook 提交              | claim/peek/commit/ack transaction，claimed tombstone 不回收      |
| plugin refresh 拆散 shell Pre/Post           | launch-time immutable hook snapshot + generation                 |
| manager 与 dispatcher 无法交接 final claim   | ShellObservation + 不透明 FinalObservationLease                  |
| sub-agent 自动 yield 后缺少 transport        | shell allowlist dependency closure，冲突 fail closed             |
| Windows 终止失败却显示 Stopped               | 结构化 termination result，只统计 confirmed                      |
| noisy output 堵塞 UI 事件队列                | 256KiB/128-event cap、output-only eviction、control fast lane    |
| Windows root-exit 后 taskkill 无法找 child   | suspended root + Job Object supervisor；无 helper 则 fail closed |
| PTY native module 在 Node 22/Windows 不稳定  | 独立阶段和功能门控，三平台 CI 后才开放 schema                    |
| 容量回收误杀用户服务                         | live session 满时拒绝新命令，不回收 live LRU                     |

## 26. 可观测性

`DEBUG_STDOUT=1` 时记录结构化元数据：

```text
shell-session.spawn-request manager=7f3a91c2d4e6b810 id=... provider=posix-process-group
shell-session.spawn-ready manager=7f3a91c2d4e6b810 id=... rootPid=12345 tree=posix-process-group
shell-session.start manager=7f3a91c2d4e6b810 id=bg_7f3a91c2d4e6b810a42f09dc318bee77_1 commandBytes=9 cwdHash=... tty=false
shell-session.activate manager=7f3a91c2d4e6b810 id=... bufferedFrames=3 bufferedBytes=214
shell-session.cleanup-residual manager=7f3a91c2d4e6b810 id=... cause=spawn-failed treeConfirmed=false
shell-session.yield manager=7f3a91c2d4e6b810 id=bg_7f3a91c2d4e6b810a42f09dc318bee77_1 wallMs=10003 outputBytes=214 reason=deadline
shell-session.wait manager=7f3a91c2d4e6b810 id=bg_7f3a91c2d4e6b810a42f09dc318bee77_1 wallMs=5001 outputBytes=0 running=true wake=deadline
shell-session.root-exit manager=7f3a91c2d4e6b810 id=... code=0 treeConfirmed=false
shell-session.terminate manager=7f3a91c2d4e6b810 id=... reason=root-exited-residual provider=windows-job-object
shell-session.tree-confirmed manager=7f3a91c2d4e6b810 id=... provider=posix-process-group residualCleanup=true
shell-session.exit manager=7f3a91c2d4e6b810 id=bg_7f3a91c2d4e6b810a42f09dc318bee77_1 code=0 treeConfirmed=true wallMs=14218
shell-session.terminate manager=7f3a91c2d4e6b810 id=bg_7f3a91c2d4e6b810a42f09dc318bee77_1 reason=stop-command confirmed=true
shell-session.termination-failed manager=7f3a91c2d4e6b810 id=... attempt=1 reason=stop-command code=termination-unconfirmed
shell-session.final-observation manager=7f3a91c2d4e6b810 id=... transition=pending-to-claimed observerCallHash=... hookGeneration=4
shell-session.final-observation manager=7f3a91c2d4e6b810 id=... transition=claimed-to-acked
shell-session.event-output-dropped manager=7f3a91c2d4e6b810 id=... bytes=8192 pendingBytes=253104 pendingEvents=127
shell-session.emergency reason=double-sigint requested=64 attempted=9 deadlineExhausted=55 wallMs=498
shell-session.dispose manager=7f3a91c2d4e6b810 active=2 exited=1 failed=0 reason=resume
```

禁止记录：

- 完整 command。
- stdout/stderr 内容。
- stdin chars。
- 环境变量。
- 绝对 cwd 明文。

可记录 command bytes、输出 bytes、哈希、持续时间和状态。

## 27. 验收标准

功能只有在以下条件全部满足时才算完成：

1. `pnpm lint` 超过 10 秒后继续运行，并返回 shell id。
2. 模型可以在进程运行期间继续执行其他工具。
3. 后续空输入 wait/read 在 TUI 显示 Waiting/Waited，而不是普通 `shellOutput` 行。
4. 同一个 shell 的连续空等待在历史中合并。
5. wait/read 只返回自上次 drain 后的新增输出。
6. managed tree confirmed 后返回 root 的真实 exit code；root-only exit 不伪装 terminal。
7. Esc 不杀进程，并且不会留下 orphan tool call。
8. `/stop` 对完整进程树执行 grace + force；确认失败时返回 partial failure，不误报 stopped。
9. `/clear`、`/resume`、sub-agent、print、SIGTERM、POSIX SIGHUP 和正常 CLI exit 不遗留 managed descendants；double Ctrl+C
   仅承诺已执行同步 best effort。
10. 超大输出时 model/session buffer 与 EventHub queue 都有明确 byte/event 上限，并显示 omission marker。
11. 工具 schema 和 system prompt 不包含动态 session 数据。
12. transport tools 不需要额外 `toolSearch`。
13. PreToolUse/PostToolUse 次数、时机和 launch-time Hook registry generation 符合设计。
14. Windows、macOS、Linux 的非 PTY 测试全部通过。
15. PTY 上线时三平台 PTY 测试全部通过。
16. `pnpm typecheck`、`pnpm lint` 和相关测试通过。
17. 修改 Core 后执行 `pnpm build`，验证 CLI 实际使用更新后的 `packages/core/dist`。
18. Core 不存在固定间隔的普通进程状态轮询；等待只由 output、versioned lifecycle、completion、abort 或 deadline
    唤醒。POSIX group probe 仅存在于 bounded tree-confirmation window。
19. 后台 managed tree 在两个 agent turn 之间确认退出时，TUI 立即收到且仅收到一次 `exited`，无需模型再次读取；
    root-only exit 只发 `root-exited`。
20. pending initial `start()` wait 与 `shellOutput` 都被 completion、manager-draining 或 termination-failed lifecycle
    立即唤醒；final retained output 先于 `exited`，且不存在 lost wake-up/busy-loop。
21. 每次 create/hydrate 都生成新的 `managerInstanceId`；相同逻辑 session resume 后旧 id/事件不能命中新 manager。
22. `yieldTimeMs: 0`/`runInBackground`/`block: false` 立即返回；turn abort 返回 id 时已发布且仅发布一次
    `yielded(reason='turn-abort')`。
23. final cwd 在 authority、permission、allow rule、Pre/Post hooks、provider 和 sed/checkpoint 中完全一致。
24. `shellOutput`/`killShell` 不产生自己的 hooks；final observation 对原始 shell Post 做原子 claim/ack 且至多一次。
25. 最终 tool result 和 Post hook 未提交前 tombstone 不回收，hook abort 不产生 orphan tool call。
26. 允许 `shell` 的所有 sub-agent 都具有两个 transport tools；冲突 allow/deny 配置 fail closed。
27. handleAttached/spawnReady/activate 各边界的 dispose/abort 和 yield 后无人读取的 hard timeout 均有集成测试，
    不能泄漏进程或越序事件。
28. `ShellSessionSummary` 足以仅凭 snapshot 恢复 root/tree 状态、footer、退出状态和去重，不依赖旧 UI cache。
29. root 先退出而普通同组/Job child 继续运行时，任一平台都自动启动 `root-exited-residual` flight；shutdown
    target/footer 保留，tree confirmed 前 completion 和 `exited` 都不发生。
30. 异步 ENOENT/spawn error 不发布 started/yielded；cleanup confirmed 不返回 id，cleanup unconfirmed 只能返回明确
    `cleanupResidual` id，不能隐藏或删除 live target。
31. `start()`/`interact()`/tool-facing terminate 的 terminal 分支都携带不可伪造 lease；dispatcher append 后 ack，
    append 前异常 release，manager 不修改 transcript。
32. `/plugin refresh` 发生在 shell Pre/Post 之间时，两者仍使用同一 immutable snapshot；新 hooks 只处理下一条
    command。
33. EventHub pending output 不超过 256KiB/128 events，recent output 不超过 16KiB；flood 后 control event 仍按
    有界 predecessor 规则投递。
34. 64 个 emergency target 共享 absolute deadline；CLI 4 秒 hard cap 包含 emergency reserve，不按 target 数量
    线性延长。
35. `shellOutput({ shellId })` 默认等待 5 秒；显式 `block:false`/`yieldTimeMs:0` 立即返回，并有参数回归测试。
36. Windows 发布包只有在 Job Object supervisor 的 x64/arm64 build、hash、package smoke 与真实 tree CI 全通过
    后才能宣称非 PTY 三平台无 managed descendants。
37. provider 同批交付 ready/output/root-exit 时，manager 事件仍严格为 `started → output → root-exited`；任何
    manager-facing frame 都不能越过 activate gate。
38. `spawnManaged()` 同步 throw 会 settle `handleAttached` 并删除 starting entry；provider 创建 OS resource 后只允许
    通过可清理 attempt 的 async ready rejection 报错。
39. tree live 时不能因 trailing timer 设置 `outputFinalized`；所有 stream EOF，或 tree-confirmed 后一次 bounded grace
    完成 decoder flush，才允许发布 `exited`。

## 28. 推荐交付边界

建议将阶段一到阶段三作为同一功能交付：

- 只有阶段一：内部更可靠，但用户仍无法获得 Codex 的自动后台体验。
- 只有阶段一和二：模型可使用后台 session，但用户看不到 Waiting/Waited 和进程状态。
- 完成阶段一到三：完整覆盖 lint/build/test 等非交互式长命令场景，也是本需求的主要目标。
- 阶段四：增加真正的交互式终端能力，不阻塞主要需求交付。

最终推荐架构是“一个 Shell 工具入口、一个统一 session manager、一套独立 UI 事件”，而不是继续维护
foreground shell 和 background shell 两条生命周期不同的执行路径。

## 29. Draft v2 review 修订对照

| Review 项                   | Draft v2 处理                                                                          | 主要章节    |
| --------------------------- | -------------------------------------------------------------------------------------- | ----------- |
| 1. resume 后 id/event 复用  | 新增非持久化 `managerInstanceId`、nonce shell id、双重事件过滤                         | 2、6.3、12  |
| 2. process group 阶段冲突   | tree provider 移入阶段一；Windows 细化为 Draft v3 Job supervisor                       | 4、20、23   |
| 3. CLI 退出无法保证清理     | shell 独占 shutdown budget；补 interactive、SIGTERM、print、double Ctrl+C              | 15、21、22  |
| 4. cwd 安全判断错误         | 两次 resolve/validate，单一 final request 贯穿 authority/permission/hooks/provider/sed | 5、17       |
| 5. Hooks 无法配对/去重      | transport policy 前置；保存 launch context；claim/peek/commit/ack                      | 18、22      |
| 6. yield 0/clamp/abort 矛盾 | 0 作为 clamp 前 sentinel；abort 原子 transition-to-yielded                             | 5、9        |
| 7. sub-agent 缺 transport   | 静态 tool dependency closure，冲突 fail closed                                         | 19.1、22    |
| 8. terminate 无部分失败     | 结构化 single/all result、confirmed 计数、residual retry                               | 5.5、15、20 |
| 9. wait event/summary 不足  | 使用真实 `toolCallId`；完整定义 summary、exit metadata 与 `exitedSeq`                  | 12、13      |
| 10. sed/checkpoint 回归     | 保留 manager 前拦截，并按 final effective cwd 解析/记录                                | 17.4、22    |

## 30. Draft v3 第二轮 review 修订对照

| Review 项                         | Draft v3 处理                                                                               | 主要章节           |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| 1. root exit 不等于 tree exit     | root/tree/output 三状态；target 仅 tree confirmed 移除；POSIX residual cleanup；Windows Job | 6、7–9、15、20、22 |
| 2. managerDraining busy-loop      | versioned lifecycleChanged；draining/failure/completion 显式 return 分支                    | 6.2、7、10、22     |
| 3. handle 与 spawn success 混合   | v3 拆 handle/spawnReady；v4 再补 started/activate gate 与 residual promotion                | 7–10、20、22       |
| 4. final claim 未交给 dispatcher  | ShellObservation 判别联合 + FinalObservationLease + 固定 isError 映射                       | 5.4、6.1、10、18   |
| Hook refresh 拆散配对             | capture immutable hook snapshot/generation，Post 使用 launch snapshot                       | 18、21、22         |
| EventHub 上限未定义               | 256KiB/128 events、8KiB delta、16KiB recent、output-only eviction                           | 6.2、12、22        |
| Windows emergency 可能 64×timeout | 500ms reserve、absolute deadline、75ms per fallback cap、deadline-exhausted                 | 5.5、15、22        |
| shellOutput 默认行为变化未声明    | omitted block 默认 5s；显式 false/0 immediate；加入迁移说明和回归测试                       | 5.2、22、24        |

## 31. Draft v4 第三轮 review 修订对照

| Review 项                                    | Draft v4 处理                                                                    | 主要章节        |
| -------------------------------------------- | -------------------------------------------------------------------------------- | --------------- |
| 1. Windows root-exit 未启动 residual cleanup | 任一平台统一 root-exited-residual single-flight；Windows force Job + tree-empty  | 6.2、8、20、22  |
| 2. ready 与 started 间缺 activation gate     | attempt-local ordered buffer；manager commit started 后 activate/flush           | 7–9、12、20、22 |
| sync spawn throw 未闭合                      | handle 创建前才可 throw；settle handleAttached、删除 starting、failure tombstone | 8、9、20、22    |
| spawn failure 隐藏 unconfirmed target        | cleanup confirmed 才 terminal；否则返回 cleanupResidual id 并注册 UI/transport   | 5、8–9、12–13   |
| 3. initial wait 未消费 lifecycle             | initial/transport 共用 observation loop；draining/failure 立即返回               | 6.2、9–10、22   |
| tree live 时可能提前 outputFinalized         | stream EOF，或 tree-confirmed 后一次 trailing grace                              | 6.2、10–12、22  |
| POSIX SIGHUP 未清理                          | 纳入同一 4 秒 shutdown coordinator 和平台集成测试                                | 15、22、27      |
| tty/chars 阶段编号错误                       | schema 注释、架构图和 PTY 测试统一为阶段四                                       | 5、6、22–23     |

Draft v4 已闭合三轮静态 review 中列出的实现阻断边界，可进入实现前终审；本文档本身不代表这些行为已经在代码中实现。
