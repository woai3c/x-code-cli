# Windows Peer Messaging 设计审查与收敛方案

> 审查对象：PR [#29](https://github.com/woai3c/x-code-cli/pull/29)，`origin/main...580258b`
>
> 审查日期：2026-08-30；本文件区分“事实”“判断”和“估算”。

## 结论

**判断：当前 PR 存在实质性过度设计，不建议以现状直接合并。**

但原因不是“Windows 功能完全没有复用”：现有 `PeerService`、注册发现、消息协议、收件箱、限流、投递账本、
权限/污染链路和 CLI 生命周期均被复用。新增代码主要集中在 Windows 传输和安全边界。

真正的问题是：一个“补齐 Windows transport”的任务，同时引入了严格且尚未完成人工确认的威胁模型、两套新二进制协议、
手写 Win32 overlapped I/O 状态机、重复的 native artifact 基础设施，以及与功能无关的测试改动。实现复杂度已经超过现有
Unix transport 约一个数量级，而 PR 尚缺少其自身计划要求的异用户/完整性级别、双机 remote rejection 和 arm64 实机证据。

推荐方向不是退回纯 Node 实现，而是：

1. 保留原生 helper 和必要的 Windows 安全边界；
2. 复用既有业务层，不改公开的 peer 行为；
3. 删除重复 loader、校验器和子进程管线；
4. 把两套新增协议收敛为最少的 request/response/cancel 生命周期；
5. 用实测 spike 决定是否以 Tokio named pipe 替代手写 I/O；
6. 把非本功能测试变更移出本 PR，并用真实 Windows 多进程通信验收最终结果。

## 1. 审查范围与方法

### 1.1 事实来源

- PR 元数据、提交和 GitHub Actions 结果；
- `git diff --numstat origin/main...HEAD` 与逐文件 diff；
- TypeScript/Rust 实现、测试、构建脚本和预编译 artifact；
- 当前环境 Node `22.14.0`、libuv `1.49.2`、Windows x64；
- Node、libuv、Microsoft Win32 和 Tokio 官方资料。

### 1.2 非目标

- 不重新设计现有消息业务语义、权限模型或 UI；
- 不增加 TCP、跨主机或跨用户消息能力；
- 不把 shell supervisor 和 peer broker 强行合并为一个可执行文件；
- 不以减少行数为由降低已经声明的安全边界；安全策略变更必须单独获得维护者确认。

## 2. 7,871 行从哪里来

PR 事实：`+7,871/-260`，54 个文件。按职责拆分如下；Rust 文件中的生产/内联测试边界为近似值，其余来自
`numstat`：

| 类别                            |    新增行 |     占比 | 说明                                                           |
| ------------------------------- | --------: | -------: | -------------------------------------------------------------- |
| Rust broker 生产代码            |  约 3,555 |    45.2% | pipe、安全、runtime ACL、协议、生命周期                        |
| TypeScript peer 生产代码        |     1,486 |    18.9% | broker client、平台 transport、runtime helper、artifact loader |
| 测试                            |     1,170 |    14.9% | 845 行外部测试 + 约 325 行 Rust 内联测试                       |
| 实施计划与产品文档              |     1,213 |    15.4% | 其中根目录实施计划单独占 1,196 行                              |
| 构建、artifact、lockfile 与其他 |       447 |     5.7% | native 构建/manifest/CI/package 适配                           |
| **合计**                        | **7,871** | **100%** | 二进制文件不计文本行数                                         |

因此，7,871 行不是 7,871 行运行时代码：约 2,383 行是测试和文档。不过约 5,041 行产品代码仍然很大；其中
Windows 专属栈约 4,767 行，而现有 [Unix transport](packages/core/src/peers/unix-socket-transport.ts) 约 464 行。
差距主要来自安全与代理协议，不是 Windows pipe 地址格式本身。

预编译体积当前为：

| Artifact                       |           x64 |         arm64 |
| ------------------------------ | ------------: | ------------: |
| `xc-peer-broker.exe`           | 301,056 bytes | 279,040 bytes |
| 既有 `xc-shell-supervisor.exe` | 211,456 bytes | 204,800 bytes |

## 3. 实际复用了什么

### 3.1 已正确复用

以下行为没有在 Windows 重写：

- `PeerService` 的发送、重试和 `PEER_DELIVERY_UNKNOWN` 语义；
- 注册发现、过期清理和 PID 探测；
- `PeerFrameV1`、帧大小限制和 NDJSON 编解码；
- inbox 的 hold/accept/refuse、幂等和投递账本；
- rate limit、权限 authority、peer taint/provenance；
- CLI 启停、消息入队和 UI。

当前结构是：

```text
CLI / tools
    |
    v
PeerService + Registry + Inbox + Authority       <- 既有公共业务层
    |
    v
PeerTransport
    |-- Unix: Node net + Unix domain socket
    |
    `-- Windows: TypeScript BrokerClient
                     |
                     | XCPB 控制协议
                     v
                 本 Session Rust broker
                     |
                     | XCPP 会话协议
                     v
                 对端 Rust broker
                     |
                     v
                 既有 PeerFrameV1
```

**判断：业务层复用是合理的，“没有复用代码”这一说法不成立。**

### 3.2 没有复用或抽象不完整的部分

| 问题                             | 证据                                                                                                                                                                                                                              | 后果                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| native artifact 解析重复         | [peer broker loader](packages/core/src/peers/windows-peer-broker-artifact.ts) 与 [shell supervisor loader](packages/core/src/tools/shell-session/providers/windows-job.ts) 都实现 manifest、路径、PE architecture 和 SHA-256 校验 | 两份 schema/type/error/path 逻辑已经发生漂移                             |
| pipe 地址校验重复                | [registry.ts](packages/core/src/peers/registry.ts#L32) 与 [windows-named-pipe-transport.ts](packages/core/src/peers/windows-named-pipe-transport.ts#L79) 各有一份正则                                                             | 安全校验规则可能不一致                                                   |
| 子进程协议管线重复               | [windows-peer-runtime-security.ts](packages/core/src/peers/windows-peer-runtime-security.ts) 与 `BrokerClient` 分别实现 spawn、stderr 限制、decoder、abort、timeout、exit 映射                                                    | 一次性 runtime 检查单独占 215 行并复制故障处理                           |
| transport 接口泄漏 endpoint 细节 | [transport.ts](packages/core/src/peers/transport.ts#L10) 暴露 `createAddressHint()`；Unix 返回 socket 候选路径，Windows 返回的实际是 namespace 派生信息                                                                           | `PeerService.start()` 出现 Unix 专属异常回退，平台边界不干净             |
| 低层构造器进入公共 API           | `createPlatformPeerTransport` 和 `createWindowsNamedPipeTransport` 被加入 core export snapshot                                                                                                                                    | 给尚未稳定的内部实现增加兼容负担                                         |
| Rust helper 间只有少量原语重复   | shell supervisor 主要处理 Job Object，peer broker 主要处理 pipe/security                                                                                                                                                          | 为少量 handle/wide-string 工具抽公共 Rust crate 会增加构建耦合，暂不建议 |

## 4. 哪些复杂度是必要的

### 4.1 原生边界不是多余的

Node 的 named-pipe `net` API没有传入 `SECURITY_ATTRIBUTES` 或设置 `PIPE_REJECT_REMOTE_CLIENTS` 的接口。当前环境的
libuv `1.49.2` 在 `CreateNamedPipeW` 路径使用空 security attributes，且没有加入 remote-client rejection flag。
Microsoft 文档说明，空 security descriptor 的默认 ACL 会给创建者/管理员/SYSTEM 较高权限，并给 Everyone/anonymous
提供读取权限；Node 的 Windows `chmod` 也只能有限切换写权限，不能表达 Unix `0600` 的 user/group/other 语义。

因此，如果验收标准是“与 Unix 私有 socket 等价的当前用户、本机通信”，就需要 Rust/C++ helper 或 native addon。
纯 Node 方案只能在维护者明确接受更弱威胁模型后采用。

保留的最低安全与可靠性要求：

- 创建 pipe 时原子设置受保护 DACL；
- `PIPE_REJECT_REMOTE_CLIENTS` 和 `FILE_FLAG_FIRST_PIPE_INSTANCE`；
- 高熵 pipe 名称；
- 对端 Windows account SID 校验；
- 私有且本地的 registry/runtime，拒绝 UNC、remote volume 和 reparse escape；
- 既有 `inboxToken`、`PeerFrameV1` 严格解析、authority 与 taint 链路；
- bounded frame/concurrency/timeout、AbortSignal 和 parent EOF shutdown；
- artifact architecture、protocol version 和 hash 校验。

### 4.2 broker 进程本身是可接受的选择

与 Node native addon 相比，独立 broker 避免 Node ABI/N-API 装载和崩溃隔离问题。每个命名 root Session 一个 broker，也与
现有 session 生命周期相符。问题不在“有 broker”，而在 broker 两侧又建立了过多确认层和重复状态。

## 5. 过度设计点

### 5.1 P0：安全需求扩张先于 Human Plan Review

根目录的 1,196 行计划把“同用户、本机通信”扩张为：精确 integrity RID 相等、AppContainer 拒绝、逐级 ancestor ACL
审计、双向进程身份验证，以及双机 remote rejection 验收。这些规则可能合理，但它们是产品/兼容性决定，不只是实现细节。

审查开始时 PR 不是 Draft，而 PR 描述仍明确记录 Human Plan Review、Human Local Acceptance 和 Human Technical Review 未完成；
现已将 PR 转为 Draft，并在剩余验收证据补齐前保持该状态。
这与 [开发流程](docs/development/agent-workflow.md) 中“有安全/公共接口/跨平台影响时先做 Human Plan Review，Human Local
Acceptance 前保持 Draft”的要求不一致。

本次收敛默认**不降低现有安全行为**。是否把“精确 integrity 相等”改为更接近 Unix 的“同 account SID 即可”，应作为独立
产品决定；否则重构无法用真实 elevated/non-elevated 环境证明兼容性。

### 5.2 P0：三层协议重复确认同一个交付事实

[Windows broker control protocol](packages/core/src/peers/windows-peer-broker-protocol.ts#L9) 定义 14 类 frame，包含
`CancelAck(canceled/too-late)`、operation tombstone 和 shutdown ACK。broker 间协议又使用 client/server nonce、auth-ok、
business response 和额外 business ACK，最内层仍是已有的 `PeerFrameV1` request/ack。

在“一条连接只承载一个有界请求，连接双方先通过 OS identity 与 token 验证”的前提下：

- nonce 没有提供额外的跨连接重放保护；业务 message ID 已负责幂等；
- response 后的 business ACK 不改变发送方“未收到匹配 response 即 delivery unknown”的语义；
- cancel 不需要双向 `canceled/too-late` 仲裁，never-reused operation ID 加本地 late-result ignore set 即可；
- 未知但属于已取消请求的迟到 completion 不应杀死整个 broker。

这些状态曾导致成功请求占用容量、快速断连杀死 broker 等缺陷；虽已修复，但说明状态空间难以推理。

### 5.3 P1：手写 Win32 overlapped I/O 规模过大

`pipe.rs` 共 1,234 行，约 1,149 行是生产代码，手写了 create/connect/read/write/event/cancel/close 的异步状态。

Tokio 的 Windows named-pipe `ServerOptions` 已提供 `reject_remote_clients`，并允许通过
`create_with_security_attributes_raw` 传入自定义 security attributes。它可能删除大量 I/O 状态机，但会增加依赖、编译时间和
二进制体积。因此这里不能凭感觉替换，必须先做不进入最终 diff 的 x64/arm64 release spike，并以 artifact 体积、功能和
package budget 决策。

2026-08-30 已完成第一轮不进入仓库 diff 的 Windows x64 探索性 spike：

| 变体                                                                                        |  Release 体积 | 结果                                                              |
| ------------------------------------------------------------------------------------------- | ------------: | ----------------------------------------------------------------- |
| 最小 Tokio named pipe，启用 first-instance、remote rejection 和 raw security attributes API | 286,208 bytes | request/response 通过                                             |
| 当前 raw Win32 broker                                                                       | 301,056 bytes | 当前基线                                                          |
| Tokio + 当前 DACL/SID/双向身份/runtime ACL 模块，不链接原 raw pipe 主路径                   | 348,672 bytes | 私有 DACL、双向 SID 验证和 4,000 次快速断连通过；压力段约 0.32 秒 |
| 同时保留 raw pipe 与 Tokio 两套 I/O 的上界实验                                              | 445,440 bytes | 功能通过，但超过单 artifact 0.4 MiB 预算                          |

**事实解释：**替换而不是并存时，x64 有较大概率满足 0.4 MiB 预算；但目前只是下界/上界测量，不证明完整 broker 替换后的
最终体积。当前机器未安装 arm64 Rust target，所以 arm64 spike 尚未执行。实施时可以进入 Tokio 替换分支，但最终 x64 或
arm64 任一产物超预算、功能回归或取消语义不稳定，都应回退 raw Win32。

### 5.4 P1：runtime 初始化被做成第二套 helper 生命周期

runtime ACL 检查复用了同一个可执行文件，却另外启动一次 one-shot 子进程并复制控制协议。它可以并入持久 broker 的启动握手，
或者至少复用统一的 native child client。当前设计增加了一个启动竞态和完整错误面。

### 5.5 P1：manifest 以 architecture 为第一维

当前 manifest 在每个 architecture 下重复 helper 的 protocol/source provenance，曾出现“未构建 architecture 被错误标成当前
source”的修复提交。推荐改成 helper-first：

```json
{
  "manifestVersion": 3,
  "helpers": {
    "peerBroker": {
      "protocolVersion": 1,
      "sourceSha256": "...",
      "binaries": {
        "x64": { "file": "x64/xc-peer-broker.exe", "sha256": "..." },
        "arm64": { "file": "arm64/xc-peer-broker.exe", "sha256": "..." }
      }
    }
  }
}
```

一个共享 loader 负责路径、PE、hash 和 protocol；build 脚本只负责写入各 helper 的 provenance。

### 5.6 P2：非功能性 diff 污染

PR 全局把 Vitest unit timeout 提到 15 秒、PTY harness 启动等待从 10 秒调到 20 秒，并移动 PDF 测试、修改 file-lock 计时。
这些可能是 CI 稳定性修复，但与 Windows peer 的因果关系没有记录。全局 timeout 尤其可能隐藏性能回退。应恢复 base 行为，
只给确实较慢的 Windows peer 用例设置局部 timeout；其他修复另开 PR。

### 5.7 P0：安全声明强于执行证据

当前 GitHub 8/8 jobs 通过，Windows x64 多终端 smoke 也有记录；这证明主路径可运行。但仓库中未找到实际创建不同账户或不同
integrity process 的集成测试。remote 测试只锁定创建 flag，PR 仍缺双机执行；arm64 只有 PE/hash/provenance 校验，缺目标
机器执行。CI 绿不能替代这些 threat-model acceptance。

## 6. 目标架构

```text
PeerService（不改业务语义）
    |
    v
PeerTransport.listen({ instanceId, inboxToken, ... })
    |-- UnixTransport
    |      `-- transport 自己创建/清理 UDS endpoint
    |
    `-- WindowsBrokerTransport
           |-- SharedWindowsNativeArtifactResolver
           |-- 单一 BrokerProcessClient
           |      |-- secure runtime + start server
           |      |-- request / response / cancel / shutdown
           |      `-- 统一 spawn/decoder/stderr/timeout/exit
           `-- Rust broker
                  |-- security: DACL / local-only / SID / runtime ACL
                  |-- pipe I/O: raw Win32 或经 spike 验证的 Tokio
                  `-- 单连接单 request -> 单 response
```

目标不是追求一个任意 LOC 数字，而是让每一层只拥有一种职责：

- 业务 delivery ack 只属于 `PeerFrameV1`；
- transport 只提供 request/response/cancel；
- OS security 只由 Rust 层执行；
- registry 只存经过 transport validator 验证的 descriptor；
- artifact provenance 只由一套 schema/loader/build path 管理。

## 7. 详细实施计划

### 阶段 0：计划确认与 PR 状态

1. 将 PR 标记为 Draft，直到本方案、真实运行证据和 Human Local Acceptance 完成。
2. 由请求维护者确认本方案。
3. 安全策略默认保持当前严格行为：同 SID、精确 integrity、非 AppContainer；若要放宽，另行决策并补对应验收。

完成条件：计划决定被记录，非目标和安全不变量明确。

### 阶段 1：先做低风险复用与 diff 清理

1. 抽取共享 Windows native artifact loader：统一 manifest schema、路径约束、PE architecture、hash 和 protocol 校验。
2. 将 manifest 改为 helper-first，更新 build/copy/write/check/package 脚本和测试。
3. 抽取唯一的 Windows pipe address parser/validator，registry 与 transport 共用。
4. 把 `createAddressHint()` 从 `PeerTransport` 删除；`listen()` 自己创建 endpoint，删除 `PeerService` 的 Unix fallback。
5. 不再公开导出 platform/Windows transport 低层构造器；测试从内部模块导入或通过注入接口测试。
6. 恢复无因果依据的全局 timeout 和非 peer 测试改动；保留必要改动时写明原因并局部化。
7. 把原 1,196 行施工清单替换为本 ADR/审查文件和简短的 maintained product docs。

每一步后：运行受影响 unit tests、`pnpm build`、`pnpm typecheck`。

### 阶段 2：收敛 Node 到 broker 的控制面

1. 建立一个 `BrokerProcessClient`，统一 spawn、bounded stderr、frame decoder、write serialization、startup timeout、abort 和 exit。
2. 将 secure-runtime 合入持久 broker 启动；若生命周期耦合使 registry 无法安全初始化，则保留 one-shot 命令，但必须复用同一
   process client，而不是复制 215 行实现。
3. 将控制 frame 缩减为最小集合：initialize/start、request、response、inbound request/response、cancel、error、shutdown。
4. operation ID 单调且不复用；cancel 为 best effort，不再返回 canceled/too-late ACK。
5. Node 仅保留有界、短 TTL 的 canceled-ID ignore set；一个合法迟到结果不能触发 broker-wide fatal。
6. 保持 `AbortSignal`、request deadline、最大并发、broker crash 和 `PEER_DELIVERY_UNKNOWN` 语义不变。

完成条件：协议 golden-vector 测试覆盖所有 frame；连续成功、取消竞态、broker crash、未知 frame、超大 frame 均有回归。

### 阶段 3：收敛 broker 间协议

1. 保留 connect 后的双向 OS identity 验证和 target token 验证。
2. 每条 pipe connection 只允许一个 auth+business request 和一个 business response。
3. 删除 client/server nonce 和 response 后 business ACK；关闭连接即完成 transport 生命周期。
4. 继续在 `PeerFrameV1` 层校验 request ID/message ID，保持消息幂等与 delivery-unknown 行为。
5. 将错误码分成 protocol/security/timeout/canceled/capacity，统一映射并去敏。

完成条件：错误 token、错误/无法读取身份、malformed/oversized、断连、超时、取消和重复 message ID 的结果稳定。

### 阶段 4：Win32 I/O 实测 spike

1. 已在临时目录完成 x64 API、DACL/SID、体积和 4,000 次快速断连探索，结果记录于 5.3。
2. 实施候选中完成完整 broker Tokio 替换，分别构建 x64/arm64 release，记录 source LOC、artifact size、启动耗时、压力测试和
   package budget。
3. 决策门槛：安全能力必须等价；每个 native artifact 仍满足仓库预算，或维护者明确批准预算变化；测试不得更差。
4. 达标则保留 Tokio；不达标则删除替换，保留 raw Win32，但按单连接单请求状态机拆小并补注释/测试。

这是测量性决策，不预设 Tokio 一定更好。

### 阶段 5：验证与独立审核

1. Rust：`cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、fresh x64 build/self-test；arm64 交叉构建和 PE/hash 校验。
2. TS：聚焦 peer registry/service/protocol/transport/native artifact tests。
3. Core 改动后执行 `pnpm build`；随后 `pnpm typecheck`、`pnpm lint:check`、`pnpm format:check`。
4. 执行 `pnpm run ci` 和 package/install smoke。
5. 首轮改造完成后启动独立、只读子 agent，提供目标、方案、候选 worktree 和完整验证证据；按 finding 修复并重跑受影响检查。
6. 每次修复后让同一 reviewer 对新候选复审，直到没有 blocker/high/medium finding；记录其不是仓库已配置的正式平台 gate。

### 阶段 6：Windows 真实多进程验收

在隔离的 `X_CODE_HOME` 和 workspace 中，用真实 built CLI、真实 PowerShell/ConPTY、真实 registry/broker/named pipe，模型端只使用
确定性 fake provider：

1. 在三个独立终端启动命名 Agent `alpha`、`beta`、`gamma`；
2. 三者互相 discovery；
3. 完成 `alpha -> beta -> gamma -> alpha` 消息环；
4. 验证 payload 进入接收方 peer context，回复/ack 与 message ID 匹配；
5. 验证 hold/accept/refuse 至少各一条；
6. 中止一个发送并杀掉一个 broker，确认其他进程存活、stale registration 被清理、重启后可再次通信；
7. 重复至少三轮，保存命令、Node/OS、commit/worktree、stdout/stderr、exit code 和副作用路径。

安全验收另列：

- 不同 Windows account：必须拒绝；
- remote host：如果 PR 继续声明该能力，必须用第二台受控 Windows 主机执行；
- arm64：如果本 PR 准备 Ready/发布，必须在真实 arm64 Windows 上执行 helper self-test 和两个 Session smoke；
- 不同 integrity：按阶段 0 确认的策略执行并记录。

### 阶段 7：交付

1. `git diff --check`、工作树检查、生成最终 LOC/体积对比；
2. 更新 PR 描述，真实标记每项为 PASSED/FAILED/NOT EXECUTED/NOT APPLICABLE；
3. Human Local Acceptance 前保持 Draft；
4. 用户已授权本轮最终提交；只有在代码、审核和本机功能验收全部通过后，创建一次 conventional commit；
5. 不 push、不 merge、不 release，除非另有明确授权。

## 8. 验收标准

- macOS/Linux 的 Unix socket 行为和公共 peer API 不变；
- Windows x64 三个真实 CLI 进程可发现并完成环形消息；
- Windows 的 DACL、local-only、SID、token、frame bounds 和 authority/taint 不弱于当前 PR；
- abort、timeout、broker crash、快速断连和容量恢复没有泄漏或全局 fatal；
- manifest 对 x64/arm64 的 binary/source provenance 不会互相污染；
- core build、聚焦测试、全量 CI、package/install smoke 通过；
- 独立子 agent 对最终候选没有 blocker/high/medium finding；
- 未执行的 arm64、remote、异用户或 integrity 证据必须阻止对应安全声明或 Ready 状态，不能用单元测试代替。

## 9. 预期规模变化

以下均是**估算，不是验收指标**，各项有重叠，不能直接相加：

| 收敛项                                     |                                    预计净减少 |
| ------------------------------------------ | --------------------------------------------: |
| 1,196 行施工清单改为短 ADR/maintained docs |                               约 850–1,000 行 |
| 共享 artifact/validator/process 基础设施   |                                 约 200–350 行 |
| 控制协议与 cancel 生命周期简化             |                                 约 250–500 行 |
| broker 间 nonce/business ACK 删除          |                                 约 150–300 行 |
| Tokio 若通过 spike 并替换 raw I/O          | 约 500–800 行源码，但 lockfile/二进制可能增加 |
| 移出无关 diff                              |                                   约 30–80 行 |

在不削弱安全边界的前提下，合理目标是把最终 PR 控制在约 4,500–5,500 行新增（含测试和文档），而不是追求纯 Node
方案可能达到的低行数。若 Tokio 不满足体积或稳定性门槛，接受更高 LOC，但必须通过协议和复用收敛降低状态空间。

## 10. 主要风险与回退

| 风险                               | 控制与回退                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| 简化 ACK 后改变 delivery certainty | 以现有 outbound ledger 为语义 owner；断连仍返回 `PEER_DELIVERY_UNKNOWN`，用竞态测试锁定 |
| cancel 迟到结果污染新请求          | operation ID 在进程生命周期内不复用；有界 ignore set；wrap 前 fail/restart              |
| Tokio 增大 artifact/package        | spike 不进入最终 diff；超预算立即回退 raw Win32                                         |
| manifest migration 破坏旧包布局    | loader 只读取当前包内 manifest；package install smoke 覆盖 source/dist/tarball 路径     |
| Windows 修复破坏 Unix              | transport contract tests 在 Windows/Linux/macOS CI 均执行                               |
| 严格 runtime ACL 使临时目录不可用  | 测试使用受控本地 runtime；不通过放宽安全来迁就测试                                      |

## 11. 外部依据

- [Node.js 22 `net` 文档：IPC/named pipe listen options](https://nodejs.org/docs/latest-v22.x/api/net.html)
- [Node.js 22 `fs.chmod` 的 Windows 限制](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- [libuv v1.49.2 Windows pipe 实现](https://github.com/libuv/libuv/blob/v1.49.2/src/win/pipe.c)
- [Microsoft `CreateNamedPipeW`](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew)
- [Microsoft Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Microsoft `ImpersonateNamedPipeClient`](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient)
- [Tokio Windows named-pipe `ServerOptions`](https://docs.rs/tokio/latest/tokio/net/windows/named_pipe/struct.ServerOptions.html)

## 12. Human Plan Review 决策面

请求维护者已于 2026-08-30 在当前实现对话中回复“同意方案”，批准以下整体方案：

- [x] 同意“保留 native broker，但收敛协议、生命周期和重复基础设施”；
- [x] 同意本轮默认保持当前严格的 SID/integrity/AppContainer 安全行为；
- [x] 同意 Tokio 仅作为有退出门槛的临时 spike，结果不达标即回退；
- [x] 同意未取得真实 arm64/双机证据前，PR 保持 Draft 且不宣称对应验收已完成；
- [x] 同意按阶段 1–7 实施、审核、真实多终端测试并在全部通过后创建一次提交。

## 13. 实施结果与最终证据

### 13.1 最终结论

初始结论经实现与复审后仍成立：**原 PR 确有过度设计，但“完全没有复用既有代码”不成立。** 既有业务层、注册发现、
消息格式、收件箱、权限与 taint 链路均得到复用；可确认的过度设计主要位于 Windows 专属 transport 的重复基础设施、
控制协议状态和手写异步 I/O。

本轮已经移除这些可确认的冗余，同时保留 native broker 及其 DACL、local-only、SID、integrity、AppContainer、token、
runtime ACL 和有界资源策略。最终候选不再用多层 ACK/nonce/cancel 仲裁表达同一个交付事实，也不再为两个 Windows helper
分别维护 artifact loader 和进程协议管线。

最终 diff 仍然很大，因此结论不是“代码少了就安全”，也不是“剩余代码都天然必要”：当前主要体积来自 3,505 行 Rust
broker（其中安全与 runtime ACL 991 行）、Windows transport/控制客户端、跨进程与安全回归测试、构建产物管理以及本审查报告。
它已从“状态空间难以推理”收敛为职责较清晰的实现，但仍应以 Draft 接受尚未完成的真实 arm64、异账户、异 integrity 和双机
验收约束。

### 13.2 已实施的收敛

- 抽取共享 Windows native artifact 解析、PE 架构、hash/protocol 校验，供 peer broker 与 shell supervisor 复用；
- 抽取唯一的 pipe 地址验证器和统一 native 子进程管线，删除 runtime probe 与 broker client 的重复实现；
- 保持旧 `PeerTransport` 注入兼容，并让 transport 自己拥有 endpoint 创建、校验和关闭生命周期；
- 将 Node 控制面收敛为最小 request/response/cancel/shutdown 状态，ID 不复用且 wrap 前失败；
- 删除 broker 间 nonce、auth-ok、额外 business ACK 与 cancel 仲裁，保留 OS identity、token 和业务幂等语义；
- 用 Tokio named pipe 替代手写 Win32 overlapped I/O，同时保持原有安全边界和 fail-closed 行为；
- 将 CLI native copy 范围限定为 `native/windows`，并校验 x64/arm64 manifest、PE 与 hash；
- 恢复与本功能无因果关系的全局测试门限，只为实际重型媒体用例保留局部 15 秒上限；
- 删除 1,196 行施工清单，以本审查文档作为决策、实施和证据记录。

全量门禁还暴露了一个与 peer 无关、但会让 Windows 测试宿主以 `0xC0000005` 退出的 PDF native Worker 崩溃。为保证门禁
真实通过而不是重跑掩盖，本候选把 Windows PDF renderer 隔离到 child process，等待 PDF/image worker 自然退出，并补充
abort、IPC disconnect 与安装包 fork 路径测试；其他平台仍使用原 Worker 路径。该修复是最终 LOC 高于阶段 9 估计的一部分。

### 13.3 规模与产物

| 指标                |       初始 PR |                                        最终候选 |
| ------------------- | ------------: | ----------------------------------------------: |
| 文本 diff           | `+7,871/-260` |                                   `+7,543/-425` |
| 变更文件            |            54 |                                              60 |
| 根目录施工/审查文档 |      1,196 行 |                                          522 行 |
| x64 peer broker     | 301,056 bytes |                                   362,496 bytes |
| arm64 peer broker   | 279,040 bytes |                                   346,112 bytes |
| npm package         |        未记录 | 3.00 MiB packed / 11.80 MiB unpacked / 41 files |

阶段 9 的 `4,500–5,500` 行是初始估计，**最终没有达到该估计**。原因包括严格安全实现不能按 LOC 目标裁剪、Tokio 替换的
净减幅小于 spike 下界、增加了竞态/容量/真实 PTY 回归，以及上述 PDF native crash 修复。最终新增行数仅比初始少
328 行，但删除行数增加 165 行；更重要的收益是删除重复协议状态和手写 I/O 分支，而不是用测试或文档迁移
制造表面 LOC 降幅。

### 13.4 独立审核

同一只读子 Agent 对每轮修复持续复审，先后发现并推动修复：shutdown 保留 ID、operation capacity 释放竞态、ID overflow、
取消后迟到 terminal、子进程 EPIPE、异常终止汇合、destroy deadline、父 IPC 断连和真实时钟测试抖动等问题。最终轮未编辑
文件、未运行测试，仅审核最新完整候选，结论为：

- Blocker：0
- High：0
- Medium：0
- Low：0
- **无发现，可提交**

### 13.5 最终验证

验证环境：Windows 10 `10.0.19045` x64、Node `v22.14.0`、pnpm `10.7.1`、Rust `1.94.0`。

| 检查                                                     | 结果                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm run ci`                                            | PASS；201 个文件通过、3 个平台跳过；1,985 个测试通过、37 个跳过；无 unhandled worker error |
| `pnpm check:package`                                     | PASS；3.00 MiB packed、11.80 MiB unpacked、41 files                                        |
| `cargo fmt --check`                                      | PASS                                                                                       |
| `cargo test --locked`                                    | PASS；19/19                                                                                |
| `cargo clippy --all-targets --locked -- -D warnings`     | PASS                                                                                       |
| x64 `xc-peer-broker self-test --protocol 2`              | PASS                                                                                       |
| x64/arm64 artifact manifest、PE、hash、source provenance | PASS；arm64 为交叉构建产物校验                                                             |
| PDF/image native 退出压力测试                            | PASS；5 轮、每轮 42/42                                                                     |
| shutdown coordinator 稳定性                              | PASS；10 轮、每轮 2/2                                                                      |
| `git diff --check`                                       | PASS                                                                                       |
| 测试后 broker/repo child process 残留                    | 0                                                                                          |

### 13.6 真实 Windows 多进程通信验收

使用 built CLI、真实 PowerShell ConPTY、隔离 `X_CODE_HOME`、真实 registry、native broker 与 named pipe，启动三个独立命名
进程 `alpha`、`beta`、`gamma`；模型端仅使用确定性 fake provider，不替代 transport：

- 三者互相发现成功；
- `alpha -> beta -> gamma -> alpha` 消息环成功，接收上下文与 message ID/ack 匹配；
- 两进程直接互发成功且没有出现 authority dialog；
- held message 的 Accept 与 Refuse 路径均成功；
- 注入式 metadata/payload 仅作为转义后的可见文本呈现；
- 最终全量 CI 中 `tui-peer-messaging.test.ts` 5/5 再次通过，其中三终端消息环用例耗时 8.451 秒。

因此，本机 Windows x64 的“多个终端、多个独立 Agent 进程可发现并通信”已经实际确认，不是只由 mock transport 推断。

### 13.7 未执行与交付边界

- 未在真实 Windows arm64 设备运行；仅完成 arm64 交叉构建、PE/hash/provenance 校验；
- 未创建第二个 Windows 账户验证异账户拒绝；
- 未在 elevated/non-elevated 或 AppContainer 组合中执行真实 integrity 验收；
- 未使用第二台 Windows 主机执行 remote rejection；
- 当前最终候选尚未 push，因此 macOS/Linux CI 尚未针对该提交运行。

这些缺口不影响本机同账户 Windows x64 功能结论，但会限制跨架构与完整威胁模型声明。PR 保持 Draft；本轮只创建已授权的
本地 conventional commit，不 push、不 merge、不 release。
