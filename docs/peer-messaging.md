# 跨会话消息

跨会话消息允许同一台机器上的多个交互式 X-Code Session 互相发现并交换纯文本工作请求。每个参与通信的根 Session 仍拥有独立的模型、对话、工作目录和本地权限边界。

> 当前版本仅在 macOS 和 Linux 上支持 Peer 消息。Windows 下 CLI 其他功能可正常使用，但 Peer 消息会返回 `PEER_UNSUPPORTED_PLATFORM`，直到 Windows 原生传输实现完成。非交互模式（`--print`）不会注册为 Peer。

## 启动命名 Session

为不同项目或角色分别打开终端并指定名称：

```bash
# 终端 1
cd frontend
xc --name frontend

# 终端 2
cd backend
xc --name backend
```

名称只是用于发现的标签，不是持久身份。如果两个在线 Session 使用同名，请用 `/list-agents` 显示的 `peer:<uuid>` 精确地址指定目标。

Session 通过同一个 X-Code 用户目录发现彼此。默认情况下，同一系统用户的 Session 共用 `~/.x-code`；如果设置了 `X_CODE_HOME`，参与通信的 Session 必须使用相同的值。

## 发现与发送消息

在命名 Session 中运行：

```text
/list-agents
```

列表会显示 Peer 的名称、当前进程地址、状态和工作目录。然后可以直接用自然语言要求 Agent 发送消息，例如：

```text
请询问 backend，API 响应类型是否已经可以给前端使用。
```

命名后的根 Agent 会获得两个模型工具：

- `listAgents`：列出可访问的 Session。
- `sendMessage`：向唯一名称或精确的 `peer:<uuid>` 地址发送纯文本；可选 summary 会显示给接收方。

子 Agent 不会获得这两个工具。当前没有 `/send-message` 命令；根 Agent 会根据用户指令决定何时调用 `sendMessage`。

## 入站策略

在 `~/.x-code/config.json` 配置接收策略：

```json
{
  "peerMessaging": {
    "inbound": "auto",
    "dialogExpiryMs": 300000
  }
}
```

| 策略     | 行为                                                                   |
| -------- | ---------------------------------------------------------------------- |
| `auto`   | 发送方与接收方权限等级相同时自动接收，否则暂存并等待本地决定。默认值。 |
| `accept` | 立即接收所有已认证的本机 Peer 消息。                                   |
| `hold`   | 展示消息，由接收方选择 **Accept** 或 **Refuse**。                      |
| `refuse` | 拒绝所有入站 Peer 消息。                                               |

`auto` 比较的权限等级是默认询问模式和绕过模式（`--trust`）。`dialogExpiryMs` 只作用于暂存消息，默认五分钟，允许范围为 10 秒到 30 分钟。

新配置在下一次启动命名 Session 时生效。

## 权限与安全

Peer 消息只是数据，不会自动获得本地用户权限：

- 展示前会清除 Peer 名称、summary 和 payload 中的终端控制序列。
- 已接收的消息及其派生回复会在 Session 记录中标记为受 Peer 影响。
- 默认询问模式下，经过审计的操作需要本地单次批准，并完整展示规范化 payload；无法分类或无法完整展示的操作默认拒绝。
- 在询问模式下，配置变更、长期记忆搜索、Goal 更新和子 Agent 调度对受 Peer 影响的工作禁用。
- 接收 Session 使用 `--trust` 启动，表示本地用户明确允许 Peer 触发的工具跳过上述询问。只有在所有可访问本机 Peer 都可信时才应使用。
- 受 Peer 影响的事件不会触发插件 Hook；即使接收 Session 使用 `--trust`，这一隔离仍然生效。
- `/clear-peer-context` 经确认后可删除第一条受 Peer 影响的消息以及其后的所有派生回复，并恢复普通权限；还有 Peer 消息排队时不会执行。

Peer 传输仅限本机：使用 X-Code 用户目录下的运行时注册表和 Unix Domain Socket，不会监听网络端口。认证 token 和投递账本属于内部实现，不会暴露给模型。

## 投递结果

`sendMessage` 会返回以下结果之一：

- `delivered`：接收方已接收消息。
- `held`：接收方需要在截止时间前作出本地决定。
- 拒绝或错误：消息未被接收。
- `PEER_DELIVERY_UNKNOWN`：连接在收到匹配的确认前关闭。只能使用返回的 message ID、完全相同的目标和 payload 重试；任何变更都会被拒绝。

接收方忙碌时，新消息会排队，不会打断当前回合。

## 故障排查

- **This session is not a named agent**：使用 `xc --name <名称>` 重启。
- **No other reachable sessions**：确认两端均已命名、运行于 macOS/Linux，并使用相同的 `X_CODE_HOME`。
- **Name is ambiguous**：从 `/list-agents` 复制精确的 `peer:<uuid>` 地址。
- **消息一直处于 held**：在 `dialogExpiryMs` 到期前到接收终端选择 Accept 或 Refuse。
- **需要诊断日志**：设置 `DEBUG_STDOUT=1` 启动；日志写入 `~/.x-code/logs/debug.log`。
