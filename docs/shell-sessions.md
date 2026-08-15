# 后台 Shell Session

X-Code CLI 把长时间运行和交互式命令统一管理为 Shell Session。普通命令先等待一段时间；如果仍未结束，Agent 会收到一个 `shellId`，之后可以继续读取输出、输入字符或停止整个进程树。

英文版：[shell-sessions.en.md](./shell-sessions.en.md)

## 默认行为

- `shell` 默认等待 10 秒。命令在这段时间内结束时，直接返回完整结果。
- 10 秒后仍在运行时，命令转为后台 Session，并返回 `shellId`。
- `yieldTimeMs: 0` 立即返回后台 Session；`yieldTimeMs` 也可以设置其他首次等待时间。
- `timeout` 是可选的硬运行上限；省略时没有硬超时。
- `cwd` 相对于当前 Session 的项目目录解析。
- `maxOutputTokens` 只限制交给模型的输出量，不是进程运行时间限制。

旧的 `runInBackground: true` 仍兼容，但新的工具调用应使用 `yieldTimeMs: 0`。

## 查看和停止

交互式 CLI 提供两个命令：

| 命令               | 作用                                                 |
| ------------------ | ---------------------------------------------------- |
| `/ps`              | 列出仍在运行的后台终端、命令、运行时间和最近几行输出 |
| `/stop [shell-id]` | 停止指定 Session；省略 `shell-id` 时停止所有后台终端 |

Agent 使用两个配套工具管理 Session：

- `shellOutput`：读取上次读取之后产生的新输出；空读取默认最多等待 5 秒。
- `killShell`：终止指定 Session，并确认其受管理的进程树是否已经退出。

`shellId` 是当前 CLI Session 内的临时标识，不应保存到其他会话或脚本中复用。

## 交互式命令

需要终端输入的程序应以 `tty: true` 启动。X-Code CLI 在 Windows 使用 ConPTY，在 macOS / Linux 使用 PTY；Agent 可以通过 `shellOutput.chars` 发送普通输入或控制字符，例如 `\u0003` 表示 Ctrl+C。`cols` 与 `rows` 必须同时提供，用于调整终端尺寸。

非 TTY Session 不接受普通字符输入；向它发送 `\u0003` 会终止受管理的进程树。

## 子 Agent

允许 `shell` 的子 Agent 会自动获得 `shellOutput` 和 `killShell`，确保它可以管理自己启动的后台命令。因此，自定义子 Agent 不能一边允许 `shell`，一边通过 `disallowedTools` 禁用任一配套工具；这种定义会在加载时被拒绝。

工具名和权限配置详见 [sub-agents.md](./sub-agents.md)。

## 使用建议

- 构建、测试、开发服务器等可能超过 10 秒的命令无需特殊后台标志。
- 只想启动服务并立刻继续时使用 `yieldTimeMs: 0`。
- 需要回答提示、发送快捷键或观察动态界面时使用 `tty: true`。
- 完成验证后停止不再需要的服务；退出 CLI 时也会清理受管理的后台进程树。
