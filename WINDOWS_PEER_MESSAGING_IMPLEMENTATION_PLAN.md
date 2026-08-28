# Windows 跨会话消息实施方案

> 状态：已实现；待发布前 Windows arm64 实机与双机远程拒绝验收
>
> 目标：在 Windows x64 / arm64 上为命名的交互式根 Session 提供与 macOS/Linux 一致的本机 Peer Messaging 能力，同时保持当前权限、provenance、taint、队列和投递语义，并以 Windows 原生安全机制实现同账户隔离和远程连接拒绝。
>
> 核心决策：使用随 npm 包分发的预编译 Rust helper `xc-peer-broker.exe` 实现 Windows Named Pipe、SID/DACL 校验和本机连接约束；普通安装、TypeScript 开发、构建和测试不得要求本机安装 Rust。

## 1. 摘要

当前 Peer Messaging 已在 macOS/Linux 上通过 Unix Domain Socket 工作，但 Windows 会在 `PeerService.start()` 中以 `PEER_UNSUPPORTED_PLATFORM` 明确关闭。Windows 支持不能通过简单移除平台判断完成，因为现有实现依赖 POSIX UID、`0700`/`0600`、socket 文件、inode 和 `unlink` 语义，而 Node.js 的 Windows Named Pipe API不允许应用设置严格的 DACL、`PIPE_REJECT_REMOTE_CLIENTS` 或验证对端 Windows SID。

本方案采用以下结构：

```text
Named xc Session A
┌──────────────────────────────────────┐
│ Node.js                              │
│ PeerService                          │
│   └─ WindowsNamedPipeTransport       │
└──────────────────┬───────────────────┘
                   │ bounded binary protocol over inherited stdio
┌──────────────────▼───────────────────┐
│ xc-peer-broker.exe A                 │
│ - secure runtime directory check     │
│ - Named Pipe server/client           │
│ - current-account SID verification   │
│ - protected DACL                     │
│ - remote-client rejection            │
└──────────────────┬───────────────────┘
                   │ Windows Named Pipe
┌──────────────────▼───────────────────┐
│ xc-peer-broker.exe B                 │
└──────────────────┬───────────────────┘
                   │ inherited stdio
┌──────────────────▼───────────────────┐
│ Node.js PeerService B                │
└──────────────────────────────────────┘
```

每个命名的交互式根 Session 启动一个 broker。未命名 Session、print mode 和 sub-agent 不启动 broker。Windows broker 同时处理入站和出站连接，使两端都由原生代码验证对端 SID，并避免 Node 默认 Named Pipe 安全描述符成为安全边界。

业务层保持不变：

- `/list-agents`、`listAgents`、`sendMessage` 的用户语义不变。
- 消息只传纯文本和现有摘要/投递元数据。
- Peer 消息不等于用户授权，不能批准权限或执行 slash command。
- peer-influenced taint、authority evaluator、hook 隔离、held/accepted 队列、去重、限流、重试和 delivery update 语义不变。
- 不监听 TCP/UDP 端口，不接入远程 relay。

## 2. 已确认的设计决策

以下决策在实施前视为已定，不在编码阶段重新发散：

| 主题                   | 决策                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Windows IPC            | Windows Named Pipe                                                                                                     |
| 原生实现               | 独立 Rust broker executable，不使用 N-API addon                                                                        |
| 进程模型               | 每个命名根 Session 一个 broker                                                                                         |
| OS 身份边界            | 同一 Windows Account SID，且处于兼容的 Windows integrity level                                                         |
| 多登录 Session         | 同一账户、兼容 integrity level 时允许互通                                                                              |
| 提权/AppContainer      | 首版不保证 elevated ↔ non-elevated 或 AppContainer ↔ desktop Session 互通，不降低 mandatory integrity label 规避限制   |
| 远程访问               | 使用 `PIPE_REJECT_REMOTE_CLIENTS` 明确拒绝                                                                             |
| 应用认证               | 保留每 Session 随机 `inboxToken`，作为 SID 验证后的第二层认证                                                          |
| 本机管理员             | Administrator/System 不属于可防御攻击者，与现有同 UID 威胁模型一致                                                     |
| 不安全目录/远程 volume | fail closed；Windows Peer registry 只允许支持 persistent ACL 的本机 volume，仅禁用 Peer Messaging，不影响 CLI 其他功能 |
| 纯 Node fallback       | 不提供；helper 缺失、损坏或不兼容时明确不可用                                                                          |
| Windows 架构           | x64、arm64；不支持 ia32                                                                                                |
| 普通开发               | 使用 checked-in 预编译 helper，不要求 Rust                                                                             |
| 原生开发/发布          | Rust stable；Release CI 构建并验证 x64/arm64                                                                           |
| 网络协议               | 保持 `PeerFrameV1` 业务语义；Windows transport 使用独立的有界 broker/pipe framing                                      |
| Registry 版本          | 首选保留 `version: 1`，将 transport 扩展为判别联合；旧版本安全地拒绝未知 kind                                          |

如果实施中必须改变上述任一决定，应先更新本方案并单独评审，而不是在代码中隐式改变边界。

## 3. 功能目标

### 3.1 用户功能

在受支持的 Windows 环境中，以下命令应正常工作：

```powershell
xc --name frontend
xc --name backend
```

任一 Session 中执行：

```text
/list-agents
```

应列出可达的其他命名 Session，不再显示 `Peer messaging is not supported on Windows in this release.`。

模型工具保持现有 schema：

```text
listAgents()
sendMessage({ to, message, summary? })
```

要求：

1. 两个同账户 Windows Session 可以相互发现。
2. 可以按唯一名称或完整 `peer:<uuid>` 地址发送消息。
3. 同名歧义、自发消息、空目标、广播和超限消息继续拒绝。
4. 空闲接收方可自动启动新 turn。
5. 忙碌接收方在安全工具边界注入消息。
6. goal/maintenance lease 期间继续延迟处理。
7. `auto`、`accept`、`hold`、`refuse` inbound policy 与现有平台一致。
8. sender 能收到 `delivered`、`held`、`refused`、`duplicate` 和最终 delivery update。
9. 正常退出和崩溃后不遗留 Named Pipe 内核对象。
10. 失效 registration 能在现有 grace period 和 PID 复核规则下被安全回收。

### 3.2 平台行为

| 平台          | Transport                | 行为                        |
| ------------- | ------------------------ | --------------------------- |
| macOS         | Unix Domain Socket       | 保持现状                    |
| Linux         | Unix Domain Socket       | 保持现状                    |
| Windows x64   | Secure Named Pipe broker | 新增支持                    |
| Windows arm64 | Secure Named Pipe broker | 新增支持                    |
| Windows ia32  | 无                       | fail closed，显示不支持架构 |
| 其他平台      | 无                       | 保持显式 unsupported        |

### 3.3 开发体验

以下命令不得要求 Rust：

```powershell
pnpm install
pnpm build
pnpm dev
pnpm typecheck
pnpm test
pnpm run ci
```

仅以下场景需要 Rust：

- 修改 `packages/core/native/windows-peer-broker/`。
- 执行 Windows broker 的 Rust unit/integration test。
- 重新生成预编译 helper。
- Release CI 构建 x64/arm64 原生产物。

## 4. 非目标与明确边界

首版 Windows 支持不包含：

- 跨机器消息、SMB Named Pipe 远程访问、TCP listener 或云 relay。
- Agent Teams、共享 task list、共享文件或共享完整对话历史。
- sub-agent 注册为独立 peer。
- `xc -p` / print mode inbox。
- 广播消息。
- 跨 Windows 账户通信。
- elevated 与 non-elevated、AppContainer 与普通 desktop Session 之间的保证互通；首版要求兼容的 integrity level。
- Windows/macOS/Linux 跨操作系统通信。
- 对 Administrator、System、拥有调试/接管权限的进程进行隔离。
- 消息持久化；broker 或 receiver 崩溃后不承诺恢复进程内未完成消息。
- 将 Named Pipe 地址、SID、token 或动态 peer 列表写入模型 system prompt。
- 将不安全 `X_CODE_HOME` 静默迁移到其他目录。
- helper 缺失时退化为默认 Node Named Pipe 或 loopback TCP。

## 5. 安全模型

### 5.1 需要防御的对象

必须防御：

- 同机其他普通 Windows 账户读取或伪造 registration/token。
- 同机其他普通账户连接 receiver pipe。
- 远程 SMB 客户端连接 Named Pipe。
- 伪造 registration 将 sender 引向其他账户创建的 Pipe。
- Pipe name squatting 和地址替换。
- 恶意或损坏 frame 导致无界内存、阻塞、崩溃或 request 混淆。
- broker/Node 一端退出后另一端成为孤儿进程。
- peer 输入尝试继承本地用户授权、绕过 authority 或触发 plugin hook。

### 5.2 不承诺防御的对象

不承诺防御：

- 本地 Administrator/System。
- 与当前进程使用相同 Windows Account SID、且能读取当前账户文件或调试当前进程的恶意程序。
- 用户主动把敏感信息发送给另一个可信 Session。
- 用户显式以 `--trust` 启动 receiver 后授予的本地工具能力。

即使两个 peer 属于同一 Windows 账户，模型输入仍视为互不可信的数据域。现有 peer-influenced taint 和 authority evaluator 不能因 OS 身份验证而弱化。

首版“兼容 integrity level”定义为：两端 `TokenUser` 完全相同、`TokenIntegrityLevel` RID 完全相同，且 `TokenIsAppContainer` 均为 false。不要为了让 high/medium 或 AppContainer/desktop 互通而降低 Pipe mandatory integrity label；不满足时双方按不可达处理。

### 5.3 分层认证

连接必须依次通过：

```text
1. Pipe DACL
2. PIPE_REJECT_REMOTE_CLIENTS
3. client/server Account SID 与 integrity level 双向验证
4. target inboxToken 常量时间验证
5. transport frame schema/size/version 验证
6. PeerFrameV1 严格解析
7. 现有 inbound policy 和 authority evaluator
```

任一层失败都必须关闭连接，不向未认证连接发送业务数据。

### 5.4 Windows Pipe 创建要求

broker 使用 `CreateNamedPipeW`，至少包含：

```text
PIPE_ACCESS_DUPLEX
FILE_FLAG_OVERLAPPED
FILE_FLAG_FIRST_PIPE_INSTANCE（仅第一个 server instance）
PIPE_TYPE_BYTE
PIPE_READMODE_BYTE
PIPE_WAIT
PIPE_REJECT_REMOTE_CLIENTS（每个 server instance）
```

Pipe 名称由 broker 生成，不由模型、用户输入或 Session 名称拼接：

```text
\\.\pipe\x-code-peer-v1-<namespace-id>-<192-bit-random>
```

要求：

- 使用 Win32 `CreateNamedPipeW` 文档规定的本机形式 `\\.\pipe\`。
- Pipe namespace 是平面的；名称只允许固定前缀、十六进制 namespace ID 和 base64url 随机段，不接受用户提供的反斜杠、点段或其他分隔符。
- 随机部分至少 192 bit，使用系统 CSPRNG。
- `namespace-id` 只用于隔离不同 `X_CODE_HOME`，不作为认证因子。
- `secure-runtime` 通过目录 handle 调用 `GetFinalPathNameByHandleW(FILE_NAME_NORMALIZED | VOLUME_NAME_GUID)` 获取稳定目录标识，以规范化 UTF-16LE bytes 的 SHA-256 前 12 个小写十六进制字符作为 `namespace-id`，并将该 ID 返回给 Node；TypeScript 不独立重复 Windows 路径 canonicalization。
- Registry 初始化后在实例内部保存该 `namespace-id`，parser 只接受完全匹配的 ID；broker 启动时接收同一 ID 并按固定格式生成地址。
- 注册表 parser 对总长度、固定前缀、namespace ID 和随机部分做精确验证。
- 不在 debug log 输出 inbox token、SID 原始值、canonical runtime path 或完整敏感 broker payload。

`FILE_FLAG_FIRST_PIPE_INSTANCE` 只用于同一地址的第一个 server instance。后续用于并发 accept 的 instance 不得重复该 flag，但每个 instance 都必须使用同一个 protected DACL 和 `PIPE_REJECT_REMOTE_CLIENTS`。

### 5.5 Pipe DACL

创建 Pipe 时原子传入 protected security descriptor，不允许先用默认 DACL 创建后再修补。

DACL 必须采用显式 allowlist：

- 当前 Windows Account SID：连接所需读写权限。
- 可选 LocalSystem：只有实现和测试确实需要时才能加入。
- 不允许 Everyone、Anonymous、Authenticated Users、BUILTIN\\Users、INTERACTIVE 或其他普通用户/宽泛组出现允许 ACE。
- 禁止从父对象继承不受控 ACE。
- 不得把普通 Administrators 组作为功能依赖。
- 自动化测试必须枚举 DACL 中全部 ACE，并验证每个允许 ACE 都属于批准 allowlist；不能只检查 Everyone/Anonymous 缺失。

Server 收到首段有界数据后必须：

1. `ImpersonateNamedPipeClient`。
2. `OpenThreadToken(TOKEN_QUERY)`。
3. 读取 `TokenUser` 和 `TokenIntegrityLevel`。
4. 与 broker 启动时记录的 Account SID 和兼容 integrity policy 比较。
5. 无论成功失败都执行 `RevertToSelf`。
6. 失败时不继续以 server 身份处理请求。

Client 连接后必须：

1. `GetNamedPipeServerProcessId`。
2. 以最小权限打开 server process。
3. 查询 server process token 的 `TokenUser` 和 `TokenIntegrityLevel`。
4. 与当前 Account SID 和兼容 integrity policy 比较。
5. 无法证明时 fail closed。

### 5.6 Runtime/Registry ACL

Windows 上不能把 Node 的 `mode: 0o700` / `0o600` 当作安全控制。原生 helper 必须创建或验证：

```text
<userXcodeDir()>\runtime
<userXcodeDir()>\runtime\peers
```

要求：

- 所在 volume 支持 persistent ACL；不支持时禁用 Peer Messaging。
- 通过 `GetVolumePathNameW` / `GetDriveTypeW` 和 UNC 检查确认路径位于本机 volume；拒绝 UNC、mapped network drive 和 `DRIVE_REMOTE`。这是必须条件，因为 registry 使用本机 PID 判活，不能在多台机器之间共享。
- 拒绝不安全的 reparse point/junction/symlink 路径。
- 验证 `userXcodeDir()` 根和相关父目录不会允许其他普通账户替换或删除受保护 runtime。
- `runtime` 和 `peers` 使用 protected DACL，仅当前 Account SID 可读写枚举。
- registration 临时文件和最终文件继承受保护 DACL。
- 原子写入继续使用同目录 `wx` 临时文件、flush 和 rename。
- Windows 无法目录 fsync 的现有处理保持不变。
- 无法证明目录安全时返回稳定错误码，不尝试“尽量运行”。

由同一个 `xc-peer-broker.exe` 提供一次性 `secure-runtime` 子命令，避免引入第二个原生可执行文件。该子命令必须先完成并退出，之后才能启动长生命周期 `broker` 模式：

```text
xc-peer-broker.exe secure-runtime --protocol <version>
xc-peer-broker.exe broker --protocol <version>
```

runtime path 通过有界 stdin frame 传入，避免命令行泄漏和 quoting 差异。

## 6. 总体架构改造

### 6.1 平台 Transport 工厂

新增：

```text
packages/core/src/peers/platform-transport.ts
```

职责：

```ts
createPlatformPeerTransport(): PeerTransport
```

平台选择：

```text
win32          → createWindowsNamedPipeTransport()
darwin/linux   → createUnixSocketTransport()
其他平台       → explicit unsupported
```

不得让 `PeerService` 直接 import `createUnixSocketTransport()`。

### 6.2 Transport 描述符

将 registration transport 改为判别联合：

```ts
export type PeerTransportDescriptor = { kind: 'unix'; address: string } | { kind: 'windows-pipe'; address: string }
```

`PeerTransport` 增加：

```ts
export interface PeerTransport {
  readonly kind: PeerTransportDescriptor['kind']
  createAddressHint(instanceId: string): string
  validateAddress(address: string): boolean
  listen(...): Promise<PeerTransportServer>
  request(...): Promise<PeerFrameV1>
  cleanupConfirmedDeadEndpoint?(address: string): Promise<void>
}

export interface PeerTransportServer {
  address: string
  closed: Promise<{ expected: boolean; reason?: string }>
  close(options?: { deadlineMs?: number }): Promise<void>
}
```

`closed` 允许 Service 发现 broker 意外退出，立即停止 heartbeat、移除自己的 registration 并设置 unavailable reason。

### 6.3 移除 Service 中的 Unix 文件操作

以下职责从 `PeerService.start()` 移出：

- deterministic `.sock` hint 的 `lstat`。
- `isSocket()` / symlink 检查。
- stale socket owner scan。
- socket path unlink。

Unix transport 或 Unix endpoint lifecycle 继续保留现有 inode/sentinel/ownership 防护。Windows transport 不执行文件 socket 清理。

Service 只处理：

```text
initialize secure registry
→ transport.listen
→ write registration
→ watch server.closed
→ heartbeat/status updates
```

### 6.4 Registry 的平台职责

Windows runtime 安全必须是 Registry 自身的不变量，而不是依赖 `PeerService` 的隐藏调用顺序：

- `createPeerRegistry()` 接受可注入的 platform runtime security dependency；生产默认在 Windows 调用已验证的 `secure-runtime` helper。
- `registry.initialize()` 只有在 runtime ACL、本机 volume、reparse 检查和 `namespace-id` 获取全部成功后才完成。
- direct registry callers 和测试不能绕过该步骤写入 Windows registration。
- 测试可注入明确标记的 fake security provider；生产代码不接受调用方伪造“已安全”布尔值。

`parseRegistration()` 必须：

- 精确接受 `unix` 和 `windows-pipe` 两种 descriptor。
- 对每种 kind 调用对应纯函数 validator。
- 当前平台扫描到不支持的 kind 时安全拒绝或忽略，不把任意地址传给当前 transport。
- 保持 candidate 数量、文件大小、exact keys、UUID、日期和字符串限制。

`cleanupConfirmedDead()` 必须：

```text
通用部分：
  PID 两次确认死亡
  grace period
  registration mtime/pid/updatedAt 再确认
  删除 registration

Unix：
  保留 inode、shared address、replacement 防误删逻辑

Windows Pipe：
  不删除 endpoint；内核已随进程回收
```

### 6.5 Protocol 版本关系

需要区分三个版本：

| 版本                    | 作用                                      |
| ----------------------- | ----------------------------------------- |
| `PeerFrameV1.v`         | agent 业务消息 schema                     |
| registration `version`  | 磁盘发现记录 schema                       |
| broker protocol version | Node↔broker 与 broker↔broker 原生 framing |

新增 Windows transport 不应无理由修改 `PeerFrameV1.v`。broker protocol 独立从 `1` 开始，manifest 记录可执行文件协议版本。

## 7. Rust Broker 设计

### 7.1 新增目录

```text
packages/core/native/windows-peer-broker/
  Cargo.toml
  Cargo.lock
  src/
    main.rs
    protocol.rs
    pipe.rs
    security.rs
    runtime_acl.rs
    process_peer.rs
```

允许实际实现按规模合并文件，但模块边界必须覆盖：协议、Pipe、SID/DACL、runtime ACL 和生命周期。

建议依赖保持最小：

```toml
windows-sys = { version = "0.61", features = [ ... ] }
```

所有依赖锁定在 `Cargo.lock`。协议使用固定二进制布局，不引入 serde/JSON parser；`namespace-id` 的 SHA-256 优先使用 Windows CNG `BCrypt`，如引入纯 Rust hash crate 则必须锁定并单独说明供应链增量。

### 7.2 Broker 进程生命周期

- Node 使用 `spawn()` 启动 helper，`stdio` 仅包含受控 anonymous pipes。
- `windowsHide: true`，不创建可见控制台。
- 长生命周期 `broker` 模式必须监控父通道 EOF；Node 崩溃或退出后立即停止 listener、关闭连接并退出。
- 一次性 `secure-runtime` 模式只接收一个有界请求，返回验证结果后退出；它不创建 listener，也不与长生命周期 broker 复用 stdin 会话。
- Node 必须监控 child `error`/`exit`；意外退出后 PeerService fail closed。
- 正常 shutdown：停止接收新请求，给已接受请求有限 drain deadline，然后强制关闭。
- broker 不写普通日志到 stdout；stdout 只用于协议。
- stderr 仅输出去敏错误，Node 在 `DEBUG_STDOUT=1` 时写入 debug log。
- broker 不启动子进程，不访问模型、项目文件或网络。

### 7.3 Node↔Broker framing

采用有界二进制 header：

```text
magic          4 bytes  "XCPB"
version        u8
kind           u8
flags          u16 LE
operationId    u32 LE
payloadLength  u32 LE
payload        payloadLength bytes
```

约束：

- 最大 control payload 由同一常量定义为 `MAX_FRAME_BYTES + 8 KiB`，初始上限 139,264 bytes；Node 和 Rust 边界测试必须锁定同一数值。
- `operationId = 0` 只用于 lifecycle event；请求使用非零 ID。
- Node 和 broker 各自维护 active operation map，上限固定，建议 256。
- ID 回绕时不得复用仍 active 的 ID。
- 未知 version/kind/flags、未取消 operation 的重复完成、从未分配的 ID 和超限长度视为 protocol violation。
- parser 必须支持 chunk 拆分和多 frame 合并，不假设一次 read 对应一个 frame。
- 所有 pending outbound operation 都有 deadline 和取消路径。
- `CANCEL_OPERATION` 必须有 `CANCEL_ACK`，结果至少区分 `canceled` 和 `too-late`。调用方收到 abort 后可以立即结束本地等待，但 operation ID 必须保留为有界、短期 tombstone：`canceled` ack 可结束 tombstone；`too-late` ack 不能结束 tombstone，必须继续保留到 terminal response 或 TTL。协议还必须固定 terminal-response/ack 顺序，合法的 late response 被丢弃而不是误判为未知 ID。
- receiver broker 已经把完整业务 frame 交给 Node 后，sender 断开或取消不撤销入站投递。receiver 允许 `onRequest` 在既有 deadline 内完成，并丢弃无法返回给 sender 的 response；首版不向当前不接受 `AbortSignal` 的 inbound callback 伪造取消。
- tombstone map 有固定容量和 TTL；容量耗尽时拒绝新 operation，不能无界增长。

建议 frame kind：

```text
Node → broker
  START_SERVER
  OUTBOUND_REQUEST
  INBOUND_RESPONSE
  CANCEL_OPERATION
  SHUTDOWN

broker → Node
  SERVER_READY
  INBOUND_REQUEST
  OUTBOUND_RESPONSE
  CANCEL_ACK
  OPERATION_ERROR
  SERVER_FATAL
  SHUTDOWN_COMPLETE
```

控制 payload 使用按 frame kind 固定的二进制字段布局：固定宽度整数、长度前缀 UTF-8 字段，以及末尾原始 `PeerFrameV1` bytes。不得把 frame base64 后塞入 JSON，也不得让 JSON escaping 改变上限。每个变长字段必须在切片/分配前检查长度；未知字段在协议升级时通过 version/kind 处理。

`PeerFrameV1` 使用现有 encoder 产生的原始、受限 UTF-8 bytes 传递，最终仍由 TypeScript `parsePeerFrame()` 验证；Rust 不重新定义业务 frame union。broker control payload 的上限按 `MAX_FRAME_BYTES + 8 KiB` 固定计算，即初始不超过 139,264 bytes；如果固定 envelope 实际需要更多空间，必须通过常量推导和边界测试调整，不能使用模糊的“约 160 KiB”。

### 7.4 Broker↔Broker Pipe 请求

每个 Pipe connection 只允许一个请求，并采用分阶段握手，业务 frame 不得出现在 auth envelope 中：

```text
connect
→ client broker 验证 server Account SID/integrity level
→ client 只发送 bounded auth envelope
→ server 读取有界 auth envelope 后验证 client Account SID/integrity level
→ server 验证 inboxToken
→ server 返回 auth-ok
→ client 才发送 one PeerFrameV1 payload
→ server 转交 Node 并返回 one PeerFrameV1 response
→ close
```

transport-auth envelope 只包含：

```text
transportVersion
senderInstanceId
receiver inboxToken
client nonce
```

auth-ok 必须绑定 client nonce 和 server nonce，避免把其他连接的确认误关联。业务 frame 的长度和 bytes 位于 auth-ok 之后的独立、受限 frame 中。

要求：

- token 使用常量时间比较。
- sender instance UUID 由 broker 做基本格式/长度验证，TypeScript 再做完整验证。
- 不允许第二个请求或第二次 auth。
- client broker 必须在发送 token 或业务 frame 前完成 server SID/integrity 验证。
- 未认证前不返回详细失败原因；对端只收到通用 authentication/connection failure。
- 本地 Node 可通过稳定内部错误码区分 timeout、abort、protocol mismatch、broker crash 和 target unavailable。
- 对 `sendMessage` 而言，transport request 一旦进入现有 outbound ledger，任何未获得匹配 acknowledgement 的错误（包括 broker crash、timeout、SID 验证失败和取消）都继续由 `PeerService.sendPrepared()` 映射为公开的 `PEER_DELIVERY_UNKNOWN`，并要求使用同一 message ID 重试。内部 broker 错误只作为去敏 cause/debug 信息，不能破坏现有 delivery-unknown 保证。ping/list 等非消息请求可保留更具体的内部错误。

### 7.5 并发与背压

- server connection 并发上限与现有候选扫描/队列规模协调，建议初始 64。
- 超出上限立即拒绝，不创建无界 task/thread。
- 每个连接有 auth deadline、request deadline 和 idle deadline。
- Node↔broker stdout 写入使用异步背压，不在 CLI UI 线程执行同步重 I/O。
- broker 不为每个永远阻塞的连接创建不可回收线程；优先 overlapped I/O 或受限 worker 模型。
- shutdown deadline 到期后取消/关闭所有 handle。

### 7.6 错误码

新增错误码至少覆盖：

```text
PEER_WINDOWS_HELPER_MISSING
PEER_WINDOWS_HELPER_HASH_MISMATCH
PEER_WINDOWS_HELPER_PROTOCOL_MISMATCH
PEER_WINDOWS_UNSUPPORTED_ARCH
PEER_WINDOWS_RUNTIME_UNSAFE
PEER_WINDOWS_PIPE_CREATE_FAILED
PEER_WINDOWS_PEER_IDENTITY_UNVERIFIED
PEER_WINDOWS_BROKER_EXITED
```

面向用户的 reason 必须去除 terminal control；debug log 可记录 Win32 error code，但不得记录 token 或完整敏感 payload。

## 8. TypeScript Windows Transport

### 8.1 新增文件

```text
packages/core/src/peers/windows-named-pipe-transport.ts
packages/core/src/peers/windows-peer-broker-protocol.ts
packages/core/src/peers/windows-peer-broker-artifact.ts
packages/core/src/peers/windows-peer-runtime-security.ts
packages/core/src/peers/platform-transport.ts
```

职责：

- artifact 路径、架构和 hash 验证。
- broker spawn 和 lifecycle。
- binary frame encode/decode。
- operation ID、timeout、AbortSignal 和 pending map。
- 将 `PeerTransport.listen()` 映射到 broker `START_SERVER`。
- 将 `PeerTransport.request()` 映射到 broker `OUTBOUND_REQUEST`。
- 将 broker `INBOUND_REQUEST` 交给现有 `onRequest()`，回写 `INBOUND_RESPONSE`。
- 在 abort/shutdown 时向 broker 发送 cancel，等待/处理 cancel ack，并按协议保留有界 late-response tombstone 后再清理 operation ID。

所有 tool execution 路径必须继续传递调用方的 `AbortSignal`，避免产生孤立 request/tool result。

### 8.2 Artifact 查找与验证

沿用现有 Windows shell supervisor 模式：

```text
packages/core/dist/native/windows/<arch>/xc-peer-broker.exe
```

启动前验证：

- 当前架构为 x64/arm64。
- manifest protocol version。
- 文件相对路径未逃逸 native directory。
- PE machine 与架构一致。
- SHA-256 与 manifest 一致。

验证失败不得尝试 PATH 中的同名可执行文件，也不得下载二进制。

### 8.3 启动顺序

Windows `PeerService.start()` 推荐顺序：

```text
1. registry.initialize()
   └─ 默认 Windows runtime security provider 验证 helper artifact
   └─ 运行一次性 secure-runtime 子命令并等待退出
   └─ 验证 ACL、本机 volume、reparse safety，取得 namespace-id
2. 启动长生命周期 broker 模式
3. broker START_SERVER(namespace-id)
4. broker 返回最终随机 pipe address
5. 写入 registration { kind: 'windows-pipe' }
6. 启动 heartbeat
7. 标记 service started
```

这样 direct registry callers 与 `PeerService` 走同一个安全不变量，不依赖 Service 先调用隐藏的加固步骤。

任一步失败：

- 禁止后续 registration write。
- 等待已排队 registration write 收敛。
- 删除仅属于当前 instance 的 registration。
- 关闭 broker。
- 设置稳定 unavailable code/reason。

### 8.4 意外退出

broker 意外退出时：

1. `PeerTransportServer.closed` resolve 为 unexpected。
2. `PeerService` 递增 lifecycle generation，停止新请求。
3. 停止 heartbeat，关闭 registration write generation，并等待现有 `registrationWriteTail` 收敛，防止已通过 generation check 的 rename 在清理后重新写回 registration。
4. 在 write tail 收敛后删除当前 registration；对 Windows 短暂文件占用执行有界异步重试。若最终仍失败，registration 因 ping 失败对其他 peer 不可见，并在 owner shutdown 或 PID 死亡后的既有 grace cleanup 中继续回收。
5. pending transport request 以 `PEER_WINDOWS_BROKER_EXITED` 作为内部 cause 结束；已进入 outbound ledger 的 `sendMessage` 必须继续公开返回 `PEER_DELIVERY_UNKNOWN`。
6. `/list-agents` 和后续工具调用显示明确 unavailable reason。
7. 首版不自动无限重启，避免 crash loop；是否允许一次有界重启另行评审。

## 9. Native 构建与分发

### 9.1 Artifact 布局

目标布局：

```text
packages/core/native/prebuilt/windows/
  manifest.json
  x64/
    xc-shell-supervisor.exe
    xc-peer-broker.exe
  arm64/
    xc-shell-supervisor.exe
    xc-peer-broker.exe
```

`dist/native/windows/` 保持相同结构。

### 9.2 Manifest

将单 artifact manifest 扩展为多 artifact：

```json
{
  "manifestVersion": 2,
  "artifacts": {
    "x64": {
      "shellSupervisor": {
        "file": "x64/xc-shell-supervisor.exe",
        "protocolVersion": 2,
        "sha256": "...",
        "sourceSha256": "..."
      },
      "peerBroker": {
        "file": "x64/xc-peer-broker.exe",
        "protocolVersion": 1,
        "sha256": "...",
        "sourceSha256": "..."
      }
    },
    "arm64": {}
  }
}
```

每个 artifact 独立 source hash，修改一个 helper 不应无理由要求另一个 helper 重建。

这是 manifest breaking change。必须同步修改现有 shell supervisor loader `packages/core/src/tools/shell-session/providers/windows-job.ts` 及其 artifact-boundary tests，使其读取 `artifacts[arch].shellSupervisor`；在新旧 loader/manifest 不匹配时明确报 protocol/manifest error。迁移完成前不得提交只有新 manifest、仍使用旧 loader 的中间状态，否则 Windows shell session 会全部失效。

### 9.3 脚本修改

需要修改：

```text
packages/core/scripts/native-artifacts.mjs
packages/core/scripts/build-native.mjs
packages/core/scripts/copy-native.mjs
packages/core/scripts/write-native-manifest.mjs
```

要求：

- 普通 `pnpm build` 只验证并复制 checked-in artifacts。
- `pnpm build:native` 在 Windows 上构建当前架构的两个 helper，或支持显式 artifact 参数。
- Release CI 使用 `cargo xwin` 分别构建 x64/arm64。
- source hash 只覆盖对应 crate 的 `Cargo.toml`、`Cargo.lock` 和 `.rs` 文件。
- package smoke test 验证两个架构的两个 exe 都存在。
- 更新现有 shell supervisor artifact loader 和测试以适配 manifest v2。

### 9.4 普通开发无 Rust 保证

PR CI 保持分层：

```text
普通 lint/typecheck/test/package jobs
  → 不安装 Rust
  → 使用 checked-in prebuilt helper

native-windows job
  → 安装 Rust
  → cargo fmt/test/clippy
  → 构建 fresh x64 helper
  → 运行 Windows transport/E2E tests
```

如果 Rust source 改变但 prebuilt/manifest 未更新，普通 build 必须明确失败，防止源码与发布二进制漂移。

### 9.5 Package size 预算

新增两份 broker executable 很可能超过当前 package size 余量。实施阶段必须：

- 保持 Rust release 的 LTO、单 codegen unit、panic abort 和 strip。
- 在 x64/arm64 产物生成后记录每个 helper 和 npm tarball 的实际增量。
- 修改 `scripts/check-package-size.mjs` 时以实测增量加有限余量调整阈值，并在测试中为单个 native artifact 设置独立上限；不能删除 package size gate 或改成无界。
- `pnpm check:package` 是阶段 2 和最终发布门禁，不允许等到 release 才发现超限。

## 10. 兼容性

### 10.1 旧版本

- 旧 Windows 版本继续看不到新 Session 的前提是旧 parser 拒绝 `windows-pipe`；这是安全行为。
- 新版本在 macOS/Linux 扫描到 `windows-pipe` registration 时忽略，不尝试连接。
- 新版本 Windows 扫描到 `unix` registration 时忽略。
- `PeerFrameV1` 不变，因此业务层不需要平台转换。

### 10.2 `X_CODE_HOME`

继续尊重 `userXcodeDir()` 和 `X_CODE_HOME`。测试可以把 `X_CODE_HOME` 指向 NTFS 临时目录。Windows Peer runtime 必须位于支持 persistent ACL 的本机 volume；UNC、mapped network drive 和 `DRIVE_REMOTE` 明确不支持，避免两台机器共享 registration 后用本机 PID 误判和清理对方记录。

若路径所在文件系统无法提供要求的 ACL、本机 volume 或路径安全性：

```text
Peer Messaging unavailable
```

但以下功能必须继续工作：

- 普通聊天。
- shell、文件和其他工具。
- session resume/fork。
- 未命名 Session。

### 10.3 Windows 版本

支持范围跟随项目 Node.js 22 的 Windows 支持范围和现有原生 helper 支持范围。不得额外声称支持已被 Node 22 放弃的平台。Named Pipe API 缺失或安全调用失败时 fail closed。

## 11. 实施阶段

### 阶段 0：基线与测试固定

目标：确认改造前行为，避免把已有 Peer 语义变化混入 Windows transport。

工作：

- 运行现有 peer registry/transport/service/tools/authority/inbox tests。
- 记录 Windows 当前 `PEER_UNSUPPORTED_PLATFORM` 行为。
- 为平台 transport factory、descriptor parser 和 unsupported arch 增加预期测试。

门禁：

- 当前 Unix Peer 测试全部通过。
- Windows 普通 CI 不回退。
- 没有产品行为变更。

### 阶段 1：平台无关重构

目标：把 Unix endpoint 假设移出通用 Service/Registry。

工作：

- 新增 `PeerTransportDescriptor`。
- 新增 platform transport factory。
- 将 Unix startup/stale endpoint 逻辑移动到 Unix transport/lifecycle。
- 将 dead endpoint cleanup 委托给 transport。
- 增加 `PeerTransportServer.closed`。
- Service 仍在 Windows 返回 unsupported。

门禁：

- macOS/Linux 用户可见行为和 wire behavior 不变。
- 所有现有 Unix ownership replacement、abort、timeout 和 shutdown 测试通过。
- 注入 fake transport 的 service tests 无平台耦合。
- Windows 仍 fail closed。

### 阶段 2：多 Native Artifact 基础设施

目标：支持第二个 Windows helper，同时保持普通开发不需要 Rust。

工作：

- 扩展 manifest schema。
- 重构 copy/build/write/verify scripts。
- 更新现有 shell supervisor loader，原子迁移 manifest schema。
- 新增 artifact 单元测试、package size gate 和 package smoke assertions。
- 更新 PR/Release workflows。

门禁：

- 普通 `pnpm build/test` 不调用 Cargo。
- source hash 漂移、PE 架构错误、hash 错误和路径逃逸均被拒绝。
- x64/arm64 shell supervisor 现有运行行为不变。
- `pnpm check:package` 在有明确、实测的新预算下通过。

### 阶段 3：Rust Broker 与安全 Runtime

目标：完成可独立审计的 Windows 原生安全层。

工作：

- 实现 framing parser/encoder。
- 实现 secure runtime ACL 创建/验证。
- 实现 secure Named Pipe server/client。
- 实现 Account SID 与 integrity level 双向验证。
- 实现分阶段 token auth，auth-ok 前不发送业务 frame。
- 实现 cancel ack、late-response tombstone、超时、并发上限和 shutdown。
- 实现 parent stdio EOF 自动退出。
- 加入 Rust unit/integration tests。

门禁：

- DACL 的全部允许 ACE 都属于当前 Account SID 和经批准的可选 LocalSystem allowlist。
- remote client flag 在每个 server instance 创建路径中被锁定和测试。
- 只有首个 server instance 使用 `FILE_FLAG_FIRST_PIPE_INSTANCE`，后续 instance 可正常建立。
- 不同 Account SID 或不兼容 integrity level 被拒绝。
- server/client SID 无法验证时拒绝。
- 错误 token 不向 Node 派发请求。
- malformed/oversized/truncated frame 不崩溃、不无界分配。
- parent 退出后 broker 和 Pipe 自动消失。
- `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test --locked` 通过。

### 阶段 4：TypeScript Windows Transport 集成

目标：让 `PeerService` 在 Windows 通过 broker 工作。

工作：

- 实现 broker artifact loader 和协议 codec。
- 实现 `createWindowsNamedPipeTransport()`。
- 接通 runtime security、listen、request、abort、shutdown 和 fatal exit。
- 扩展 registry parser/cleanup。
- 移除 `PeerService.start()` 的 Windows unconditional gate。
- 保持 helper 缺失/unsafe runtime 的显式 unavailable 行为。

门禁：

- Windows 两个 Core PeerService 可以 list/send/ping。
- 错误 token、错误 SID、stale registration、broker crash 和 abort 在 transport 层均产生稳定内部错误；已进入 outbound ledger 的消息仍按现有语义公开返回 `PEER_DELIVERY_UNKNOWN`。
- Unix 测试无回退。
- API export snapshot 按预期更新。

### 阶段 5：CLI E2E、文档和发布

目标：完成用户可见功能和发布门禁。

工作：

- 在 Windows 启用或改写 `tui-peer-messaging.test.ts`。
- 更新中英文 Peer Messaging 文档和 README 平台说明。
- 更新 CHANGELOG。
- 生成并校验 x64/arm64 broker artifacts。
- 执行完整跨平台 CI 和 package smoke test。

门禁：

- Windows TUI 两个真实进程完成发现和双向消息。
- npm tarball 包含并验证两个架构的 broker。
- 未安装 Rust 的干净 Windows 环境可安装、构建测试并运行该功能。
- macOS/Linux 包和功能无回退。

## 12. 文件变更清单

### 12.1 预计新增

```text
WINDOWS_PEER_MESSAGING_IMPLEMENTATION_PLAN.md
packages/core/src/peers/platform-transport.ts
packages/core/src/peers/windows-named-pipe-transport.ts
packages/core/src/peers/windows-peer-broker-protocol.ts
packages/core/src/peers/windows-peer-broker-artifact.ts
packages/core/native/windows-peer-broker/Cargo.toml
packages/core/native/windows-peer-broker/Cargo.lock
packages/core/native/windows-peer-broker/src/*.rs
packages/core/tests/windows-peer-broker-protocol.test.ts
packages/core/tests/windows-peer-transport.test.ts
packages/core/tests/windows-native-artifacts.test.ts
```

测试文件名称可按现有组织合并，但必须覆盖相同职责。

### 12.2 预计修改

```text
packages/core/src/peers/transport.ts
packages/core/src/peers/types.ts
packages/core/src/peers/paths.ts
packages/core/src/peers/registry.ts
packages/core/src/peers/service.ts
packages/core/src/peers/unix-socket-transport.ts
packages/core/src/peers/index.ts
packages/core/src/index.ts
packages/core/src/tools/shell-session/providers/windows-job.ts
packages/core/scripts/native-artifacts.mjs
packages/core/scripts/build-native.mjs
packages/core/scripts/copy-native.mjs
packages/core/scripts/write-native-manifest.mjs
scripts/check-package-size.mjs
packages/core/tests/peer-registry.test.ts
packages/core/tests/peer-service.test.ts
packages/core/tests/peer-transport.test.ts
packages/core/tests/api-exports.test.ts
packages/core/tests/windows-job-provider.test.ts
packages/cli/tests/pty/tui-peer-messaging.test.ts
.github/workflows/pr-check.yml
.github/workflows/release.yml
docs/peer-messaging.md
docs/peer-messaging.en.md
README.md
README.zh-CN.md
CHANGELOG.md
```

不要顺便重构无关 shell supervisor、TUI renderer 或 agent loop。

## 13. 验证计划

### 13.1 TypeScript/Core

最低验证命令：

```powershell
pnpm typecheck
pnpm lint:check
pnpm format:check
pnpm build
pnpm test packages/core/tests/peer-registry.test.ts
pnpm test packages/core/tests/peer-transport.test.ts
pnpm test packages/core/tests/peer-service.test.ts
pnpm test packages/core/tests/windows-peer-broker-protocol.test.ts
pnpm test packages/core/tests/windows-peer-transport.test.ts
```

最终执行：

```powershell
pnpm run ci
pnpm check:package
```

注意项目 `pnpm test <pattern>` 会先 build，core 源码改动后必须生成最新 `packages/core/dist/`。

### 13.2 Rust

```powershell
cargo fmt --manifest-path packages/core/native/windows-peer-broker/Cargo.toml --check
cargo clippy --locked --all-targets --manifest-path packages/core/native/windows-peer-broker/Cargo.toml -- -D warnings
cargo test --locked --manifest-path packages/core/native/windows-peer-broker/Cargo.toml
pnpm build:native
```

### 13.3 功能测试矩阵

| 场景                                  | 预期                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 两个同账户命名 Session                | 相互发现并发送                                                                                                                                                                                                           |
| 未命名 Session                        | 不注册、不启动 broker                                                                                                                                                                                                    |
| print mode                            | 不注册                                                                                                                                                                                                                   |
| 同名 Session                          | list 显示两个，按名称发送报歧义                                                                                                                                                                                          |
| 完整 peer UUID                        | 精确发送                                                                                                                                                                                                                 |
| receiver idle                         | 自动新 turn                                                                                                                                                                                                              |
| receiver busy                         | 安全边界注入                                                                                                                                                                                                             |
| receiver goal/maintenance             | 延迟，不抢 lease                                                                                                                                                                                                         |
| policy hold                           | 显示 Accept/Refuse                                                                                                                                                                                                       |
| wrong token                           | 拒绝且不调用 onRequest                                                                                                                                                                                                   |
| wrong SID                             | 原生层拒绝                                                                                                                                                                                                               |
| same SID、不同/不兼容 integrity level | 按首版 policy 拒绝                                                                                                                                                                                                       |
| remote client                         | 原生层拒绝                                                                                                                                                                                                               |
| broker crash                          | registration 立即有界重试清理；失败时隐藏，并在 shutdown/PID-dead cleanup 回收；service unavailable                                                                                                                      |
| Node crash                            | broker 退出、Pipe 消失                                                                                                                                                                                                   |
| sender abort                          | pending request 取消，无 orphan                                                                                                                                                                                          |
| oversized frame                       | 连接关闭，进程继续                                                                                                                                                                                                       |
| unsafe X_CODE_HOME                    | 仅 Peer unavailable                                                                                                                                                                                                      |
| x64 package                           | helper hash/PE/运行通过                                                                                                                                                                                                  |
| arm64 package                         | helper hash/PE 通过；功能首次发布，以及 arm64 binary hash、Rust source、toolchain/build flags、loader、broker protocol 或 package path 任一变化后，必须在真实 Windows arm64 环境执行 broker self-test 和双 Session smoke |

### 13.4 安全验证

必须有自动化或可复现的审计证据证明：

1. Pipe security descriptor 的全部允许 ACE 都属于批准 allowlist。
2. `PIPE_REJECT_REMOTE_CLIENTS` 实际传入所有 server instance。
3. `FILE_FLAG_FIRST_PIPE_INSTANCE` 只用于首实例，后续 instance 可正常建立。
4. client 和 server 都验证 Account SID 与 integrity policy。
5. token 比较为常量时间。
6. 未认证连接收不到业务 response。
7. Registry DACL 不依赖 Node mode bits。
8. 不安全 ACL、filesystem 或 reparse path fail closed。
9. 所有 frame 长度在分配前检查。
10. 所有请求、连接和 operation map 有固定上限与 deadline。
11. debug/user error 不泄漏 token。
12. helper hash/path/PE machine/protocol mismatch 均拒绝启动。

不同用户测试优先在 Windows CI 中通过临时本地账户执行；如果 hosted runner 无法稳定创建账户，则必须提供仓库内可重复运行的 Windows integration harness，并在发布前的受控 Windows 环境执行，结果记录在 PR 验证说明中。仅检查代码中存在 SID 比较调用不能替代运行验证。

远程拒绝分两层验收：自动化 native test 必须验证每个 `CreateNamedPipeW` server-instance 路径都包含 `PIPE_REJECT_REMOTE_CLIENTS`；功能首次发布前还必须在两台受控 Windows 主机上执行对照测试。测试 harness 先创建一个仅用于测试、DACL/认证条件相同但不带 reject flag 的 control pipe，证明 SMB、凭据、Server service 和 firewall 路径可达；同一远程客户端随后连接带 `PIPE_REJECT_REMOTE_CLIENTS` 的目标 pipe 必须被拒绝。没有 control pipe 成功证据的“连接失败”不能作为远程拒绝证据。后续未修改 Pipe 创建路径的版本可复用该集成证据，创建路径变化后必须重跑。

### 13.5 手工验收

在无 Rust 工具链、仅安装 Node 22 和 pnpm 的干净 Windows x64 环境：

```powershell
pnpm install --frozen-lockfile
pnpm build
```

终端 A：

```powershell
pnpm dev -- --name alpha
```

终端 B：

```powershell
pnpm dev -- --name beta
```

验收：

1. 两边 `/list-agents` 能看到对方。
2. alpha 发送消息给 beta，beta 空闲时启动新 turn。
3. beta 忙碌时消息不打断当前工具，在安全边界进入。
4. hold 模式显示本地确认，peer 消息不能代替确认。
5. 关闭 beta 后 alpha 不再列出 beta；无 broker 残留进程。
6. 断掉 alpha 进程后对应 Pipe 自动消失。
7. `DEBUG_STDOUT=1` 日志中无 inbox token。

## 14. 性能与资源边界

- 未命名 Session 不产生 broker 进程或 Pipe 开销。
- broker 不轮询 registry；发现仍由显式 list/send 和现有 heartbeat 驱动。
- 一个命名 Session 最多一个 broker child。
- inbound connection、active operation、frame 和 queue 均有固定上限。
- 当前 CLI 会在 `startApp()` 前 await peer startup；因此 helper 校验、`secure-runtime` 和 broker ready 必须全部使用异步 I/O、具有总 deadline，并建立 Windows 启动延迟基线。若实测延迟影响首屏，应在独立改动中把 Peer lifecycle 移到 render 后启动，不能在本功能中无证据宣称已经是 post-render。
- helper hash 验证可缓存于当前进程，但不能跨 artifact 变更错误复用。
- `listAgents` 继续使用有界并发和总 deadline。
- Windows Named Pipe busy 等待必须受 request deadline 控制；Node abort 后本地 promise 和 broker operation 都要终止。

不以牺牲安全验证换取启动性能。性能基线和阈值应在实现 PR 中根据真实 Windows CI 数据固定。

## 15. 可观测性与用户错误

用户错误应简短、可操作：

```text
Peer messaging unavailable: Windows peer broker is missing; reinstall x-code-cli.
Peer messaging unavailable: Windows peer runtime directory is not private.
Peer messaging unavailable: Windows arm32 is not supported.
Peer messaging unavailable: Windows peer broker exited unexpectedly.
```

Debug events建议：

```text
peer.windows.broker-start
peer.windows.runtime-secured
peer.windows.server-ready
peer.windows.request-failed
peer.windows.broker-exit
```

允许记录：

- error code。
- operation kind。
- elapsed time。
- architecture。
- instance short ID。

禁止记录：

- inbox token。
- 完整 SID。
- 原始消息正文。
- 完整 auth envelope。

## 16. 发布与回滚

### 16.1 发布门禁

发布前必须满足：

- x64/arm64 helper 来自锁定源码和锁定依赖。
- manifest source hash、binary hash 和 PE machine 全部匹配。
- Release CI 在 Windows x64 运行 freshly built broker E2E。
- arm64 完成交叉构建和 PE/hash 校验；功能首次发布，以及 arm64 binary hash、Rust source、toolchain/build flags、loader、broker protocol 或 package path 任一变化后，必须在真实 Windows arm64 设备或 VM 上执行 `xc-peer-broker.exe` self-test 与两个命名 Session 的 list/send smoke，并把命令、版本和结果附在发布验证记录中。
- npm tarball smoke test验证两个 helper 均存在。
- 无 Rust 工具链的安装/运行验证通过。
- 中英文文档明确 Windows 支持和 `X_CODE_HOME` 安全要求。

### 16.2 回滚策略

如果发布后发现 Windows native transport 安全或稳定问题：

- 保留 Unix transport，不回滚整个 Peer Messaging。
- 在平台 factory 中恢复 Windows fail-closed gate。
- 不回退到纯 Node Named Pipe 或 TCP。
- 发布 patch 版本，明确错误原因。
- 已存在 registration 由 PID/grace cleanup 回收；Named Pipe 随 broker 退出自动消失。

## 17. Definition of Done

只有同时满足以下条件，Windows Peer Messaging 才可标记完成：

### 功能

- [ ] Windows x64 两个命名 Session 可发现、发送、接收和返回 delivery update。
- [ ] Windows arm64 artifact 可验证，并在真实 Windows arm64 上完成规定的 self-test 和双 Session smoke。
- [ ] `/list-agents`、`listAgents`、`sendMessage` 与 Unix 用户语义一致。
- [ ] idle/busy/held/goal/maintenance 路径通过测试。
- [ ] 未命名 Session、print mode 和 sub-agent 边界保持不变。

### 安全

- [ ] Pipe 使用原子 protected DACL。
- [ ] Pipe 拒绝 remote clients。
- [ ] client/server Account SID 与 integrity policy 双向验证。
- [ ] inboxToken 第二层认证保留。
- [ ] runtime/registry ACL 经原生代码创建并验证。
- [ ] unsafe `X_CODE_HOME` fail closed。
- [ ] 不同用户、错误 token、伪造 registration 和 pipe squatting 测试通过。
- [ ] peer taint、authority 和 hook 隔离测试无回退。

### 生命周期

- [ ] Node 正常退出后 broker/Pipe 被清理。
- [ ] Node 崩溃后 broker/Pipe 被清理。
- [ ] broker 崩溃后 Node service fail closed；registration 立即有界重试清理，失败时对其他 peer 隐藏，并能在 owner shutdown 或 PID-dead grace cleanup 中回收。
- [ ] timeout/abort/shutdown 不遗留 pending operation。

### 构建与发布

- [ ] 普通本地开发不需要 Rust。
- [ ] Rust source job通过 fmt/clippy/test。
- [ ] x64/arm64 预构建产物和 manifest 更新。
- [ ] package smoke test覆盖两个 helper。
- [ ] `pnpm run ci` 通过 Linux/macOS/Windows。
- [ ] 中英文文档和 CHANGELOG 更新。

## 18. 实施原则

1. 先重构边界，再加入 Windows；不要在同一步同时重写 Unix transport。
2. 不删除现有 Unix socket ownership、inode 和 replacement 防护。
3. 不因 Windows transport 改变 PeerFrame、authority、taint 或队列语义。
4. 所有原生输入先检查长度、版本和枚举，再分配或解析。
5. 所有异步请求必须有 timeout、AbortSignal/cancel 和 shutdown 收敛路径。
6. 原生安全条件无法证明时 fail closed。
7. 不添加未经审计的纯 Node fallback。
8. 普通开发和最终用户不承担 Rust 工具链依赖。
9. 原生二进制、源码和 manifest 必须可追溯且 hash 一致。
10. 每个阶段独立验证，避免以“最终 E2E 能跑”替代安全不变量测试。
