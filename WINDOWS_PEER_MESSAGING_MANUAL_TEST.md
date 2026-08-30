# Windows Peer Messaging 手工测试指南

本文用于在 Windows x64 上验证多个独立 X-Code Agent 进程能否通过 native Named Pipe broker 互相发现和通信。

## 1. 前置条件

- Windows x64；
- Node.js 22 或更高版本；
- pnpm 10；
- 三个终端使用同一个 Windows 账户；
- 三个终端使用相同权限等级：不要混用普通 PowerShell 和“以管理员身份运行”的 PowerShell；
- 三个终端必须使用相同的 `X_CODE_HOME`；
- 手工发送消息需要已经配置可用的模型/API Key 或 ChatGPT 登录状态。

先进入仓库并确认当前提交：

```powershell
cd D:\res\x-code-cli
git status --short --branch
git log -1 --oneline
node --version
pnpm --version
```

## 2. 先运行无凭据自动化验收

自动化测试使用确定性 fake provider，不需要真实模型或 API Key，但会真实启动 built CLI、PowerShell ConPTY、独立进程、
registry、Windows native broker 和 Named Pipe：

```powershell
cd D:\res\x-code-cli
pnpm test packages/cli/tests/pty/tui-peer-messaging.test.ts
```

预期结果：

```text
Test Files  1 passed
Tests       5 passed
```

五个用例分别覆盖：

1. 两个命名 Agent 互相发现并收发消息；
2. `alpha -> beta -> gamma -> alpha` 三进程消息环；
3. metadata/payload 终端控制字符转义；
4. held message 的 Accept；
5. held message 的 Refuse。

如果该命令失败，不要进入手工验收，先根据末尾的故障排查收集日志。

## 3. 构建本地 CLI

```powershell
cd D:\res\x-code-cli
pnpm build
```

手工测试应直接运行本仓库的 `packages/cli/dist/cli.js`，避免全局安装的 `xc` 指向旧版本。

## 4. 启动三个独立终端

最简单的方式是不覆盖 `X_CODE_HOME`，让三个终端共同使用默认的 `%USERPROFILE%\.x-code`。如果平时设置了
`X_CODE_HOME`，请先在三个终端分别执行以下命令，确认输出完全相同：

```powershell
$env:X_CODE_HOME
```

如需隔离测试，可在三个终端中都设置同一个本机目录：

```powershell
$env:X_CODE_HOME = "$env:USERPROFILE\.x-code\peer-manual"
```

不要使用 `%TEMP%`、UNC 路径、映射网络驱动器、junction 或 symlink。新的隔离目录不会继承已有的 ChatGPT 登录凭据；
这种情况下需要使用环境变量 API Key，或者先在该目录下完成登录。

### 终端 1：alpha

```powershell
cd D:\res\x-code-cli
node .\packages\cli\dist\cli.js --name alpha
```

### 终端 2：beta

```powershell
cd D:\res\x-code-cli
node .\packages\cli\dist\cli.js --name beta
```

### 终端 3：gamma

```powershell
cd D:\res\x-code-cli
node .\packages\cli\dist\cli.js --name gamma
```

基础功能测试不要添加 `--trust`。三个 Session 都使用默认权限模式时，默认 `auto` 入站策略应允许它们互相通信。

如果要验证“实现 Agent 与 Review Agent 持续交流、无需人工值守”的场景，三个 Session 必须统一使用
`-t`/`--trust`：

```powershell
node .\packages\cli\dist\cli.js -t --name alpha
node .\packages\cli\dist\cli.js -t --name beta
node .\packages\cli\dist\cli.js -t --name gamma
```

`auto` 入站策略会比较发送方和接收方的权限等级。不要只给其中一部分 Session 添加 `-t`，否则权限等级不同的消息会进入
held 状态，等待接收方选择 Accept 或 Refuse。全部使用 `-t` 时，Peer 触发的工具调用也会自动执行；只应在这些本机
Session 都可信时使用。

## 5. 验证 Agent 发现

在 `alpha` 中输入：

```text
/list-agents
```

预期能看到 `beta` 和 `gamma`，每项包含类似下面的精确地址和状态：

```text
beta · peer:<uuid> · idle
gamma · peer:<uuid> · idle
```

也可以分别在 `beta`、`gamma` 中运行 `/list-agents`，确认三者互相可见。

## 6. 验证三进程消息环

当前没有 `/send-message` slash command。必须用自然语言要求命名后的根 Agent 调用 `sendMessage` 工具；子 Agent 不具备该工具。

默认权限模式下，接收方处理 Peer 消息后若要读取文件、修改文件、执行命令或回发消息，会显示一次性本地授权。授权框默认选中
Deny，上下键可立即切换 Allow/Deny；左右键仅用于可选查看完整 payload 分页。要测试无人值守的连续协作，请按上一节让所有
Session 都使用 `-t`。

### alpha -> beta

在 `alpha` 中输入：

```text
请务必调用 sendMessage 工具，向 beta 发送：manual alpha -> beta
```

确认发送结果不是错误，并在 `beta` 中看到：

```text
Peer message · alpha
manual alpha -> beta
```

### beta -> gamma

在 `beta` 中输入：

```text
请务必调用 sendMessage 工具，向 gamma 发送：manual beta -> gamma
```

确认 `gamma` 收到 `manual beta -> gamma`。

### gamma -> alpha

在 `gamma` 中输入：

```text
请务必调用 sendMessage 工具，向 alpha 发送：manual gamma -> alpha
```

确认 `alpha` 收到 `manual gamma -> alpha`。三个方向全部成功后，消息环验收通过。

如果名称重复导致 `Name is ambiguous`，从 `/list-agents` 复制目标的 `peer:<uuid>`，要求 Agent 使用该精确地址发送。

## 7. 检查 Windows native broker

保持三个 Session 运行，在第四个 PowerShell 中执行：

```powershell
Get-Process xc-peer-broker
```

正常情况下应看到三个 `xc-peer-broker` 进程，每个命名根 Session 对应一个 broker。

也可以查看三个注册文件是否存在。默认目录：

```powershell
Get-ChildItem "$env:USERPROFILE\.x-code\runtime\peers" -Filter *.json
```

如果设置了 `X_CODE_HOME`：

```powershell
Get-ChildItem "$env:X_CODE_HOME\runtime\peers" -Filter *.json
```

## 8. 可选：验证 Hold、Accept 和 Refuse

先退出三个 Session，然后备份当前 `config.json`。在三个 Session 共用的 X-Code home 下设置：

```json
{
  "peerMessaging": {
    "inbound": "hold",
    "dialogExpiryMs": 60000
  }
}
```

配置文件位置：

- 默认：`%USERPROFILE%\.x-code\config.json`；
- 自定义：`%X_CODE_HOME%\config.json`。

重新启动 `alpha` 和 `beta`，从 `alpha` 向 `beta` 发送消息。预期 `beta` 显示本地 Accept/Refuse 选择：

1. 第一次选择 **Accept**，确认消息进入 `beta` 的 Agent 上下文；
2. 再发送一条消息并选择 **Refuse**，确认发送端得到拒绝结果，消息不会进入接收 Agent 上下文。

测试完成后将 `inbound` 恢复为 `auto`，并重新启动命名 Session。

## 9. 验证正常退出与清理

在三个 Session 中分别输入：

```text
/exit
```

全部退出后，在 PowerShell 中执行：

```powershell
Get-Process xc-peer-broker -ErrorAction SilentlyContinue
```

预期没有输出。

再检查注册目录：

```powershell
$PeerRoot = if ($env:X_CODE_HOME) { $env:X_CODE_HOME } else { "$env:USERPROFILE\.x-code" }
Get-ChildItem "$PeerRoot\runtime\peers" -Filter *.json -ErrorAction SilentlyContinue
```

本轮三个 Session 对应的注册文件应已删除；其他仍在线命名 Session 的注册文件可以保留。

## 10. 故障排查

### 看不到其他 Agent

确认：

- 三个进程都使用 `--name`；
- 名称不同；
- `X_CODE_HOME` 完全相同；
- 使用同一 Windows 账户；
- 权限等级相同，没有混用管理员与普通终端；
- 使用交互模式，不能添加 `--print`。

### runtime directory 不安全

Windows 的 peer runtime 必须位于当前账户可控制、支持 persistent ACL 的本机 NTFS/ReFS volume。不要将 `X_CODE_HOME`
指向仓库、临时目录、网络路径、映射盘或 reparse/junction/symlink。

### broker 缺失或 hash mismatch

确认正在运行本仓库构建结果，然后重新构建：

```powershell
cd D:\res\x-code-cli
pnpm build
pnpm test packages/core/tests/windows-native-artifacts.test.ts
```

### 收集调试日志

在启动每个 Session 前设置：

```powershell
$env:DEBUG_STDOUT = '1'
node .\packages\cli\dist\cli.js --name alpha
```

日志位置：

```powershell
$PeerRoot = if ($env:X_CODE_HOME) { $env:X_CODE_HOME } else { "$env:USERPROFILE\.x-code" }
Get-Content "$PeerRoot\logs\debug.log" -Tail 200
```

## 11. 验收清单

- [ ] 聚焦自动化测试 5/5 通过；
- [ ] `alpha`、`beta`、`gamma` 互相可发现；
- [ ] `alpha -> beta` 投递成功；
- [ ] `beta -> gamma` 投递成功；
- [ ] `gamma -> alpha` 投递成功；
- [ ] 三个 Session 运行时存在三个 broker；
- [ ] 可选 Hold/Accept/Refuse 行为符合预期；
- [ ] `/exit` 后没有遗留 broker；
- [ ] 没有未解释的错误、超时或 `PEER_DELIVERY_UNKNOWN`。

功能说明还可参考 [`docs/peer-messaging.md`](docs/peer-messaging.md)。
