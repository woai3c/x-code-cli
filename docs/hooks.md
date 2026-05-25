# Hooks — 使用指南

Hook 是插件挂在 agent 生命周期事件上的 shell 命令。CLI 用 stdin 发 JSON 事件给你，你可以用 stdout 返回 JSON 决策来影响 agent 接下来怎么走。

英文版：[hooks.en.md](./hooks.en.md) · 相关：[plugins.md](./plugins.md) · [plugin-authoring.md](./plugin-authoring.md)

---

## 为什么是 shell 而不是 SDK

门槛最低。一段 bash 一行命令或者 `node hook.js` 短脚本就是完整的 hook，不需要在我们进程内跑插件代码——CLI 只负责拉子进程、传 JSON、读返回。

---

## 10 个事件

| Event              | 触发时机                                                                     | 能决策                           | 典型用途                                  |
| ------------------ | ---------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| `SessionStart`     | CLI 启动时（UI 挂载前）就 fire 一次。即使用户从不发 prompt 也会触发          | ❌                               | 预热状态、设置环境                        |
| `UserPromptSubmit` | 用户消息发给模型前                                                           | ✅ allow / deny / inject context | 注入 sprint 信息、敏感词拦截、按主题分流  |
| `PreToolUse`       | 任何工具派发前（writeFile、shell、MCP、sub-agent…）                          | ✅ allow / deny / modify args    | 拦截危险路径、重写参数、审计 gate         |
| `PostToolUse`      | 工具产出结果后                                                               | ✅ modify output                 | 改写工具返回值、追加审计元数据            |
| `PreCompact`       | 上下文将要被压缩前（proactive 阈值触发，或 reactive "prompt too long" 触发） | ❌                               | 在 messages 被裁剪前持久化、做 checkpoint |
| `PostCompact`      | 压缩完成后                                                                   | ❌                               | 通知、记录"刚刚压了多少"                  |
| `SubagentStart`    | `task` 工具派生 sub-agent 跑前                                               | ❌                               | 审计哪些 sub-agent 被调用、记开始时间     |
| `SubagentStop`     | Sub-agent 结束（completed / aborted / failed 三种结局）                      | ❌                               | 统计 sub-agent 耗时与 token 用量          |
| `TurnComplete`     | 每轮 LLM 流式输出结束                                                        | ❌                               | 通知、统计                                |
| `SessionEnd`       | CLI 退出时                                                                   | ❌                               | flush 日志、发"会话结束"提示              |

`SessionEnd` 是 fire-and-forget——CLI 不等 hook 完成就退。重要操作放 `TurnComplete`。

---

## Manifest 里怎么声明

插件 `plugin.json` 里（inline 或者引到外部文件）：

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "writeFile|edit", // tool 名的正则
        "command": "node ${pluginDir}/hooks/lint.js",
        // 可选：平台特定覆盖。当前 OS 命中就替换上面的 command。
        // 未命中的平台落回 `command`，所以一个能在任何 POSIX 系统跑的
        // 默认 + 一个 Windows 专属备用是常见组合。
        "commandWindows": "node \"${pluginDir}/hooks/lint.js\"",
        "commandDarwin": "node ${pluginDir}/hooks/lint.js", // 一般不需要单独写
        "commandLinux": "node ${pluginDir}/hooks/lint.js",
        "timeout": 5000, // ms（默认 5000，上限 30000）
        "description": "写文件前自动 lint",
        "failurePolicy": "allow", // 或 "block"，默认 "allow"
      },
    ],
    "UserPromptSubmit": [{ "command": "${pluginDir}/hooks/inject-context.sh" }],
  },
}
```

**为什么三个平台都要写**：插件最终在 Windows / Linux / macOS 都会被装，作者写 `bash foo.sh` 这种 POSIX 命令默认在 Windows 上会失败。`command` 是基础——这里写一个语言无关、跨平台都能跑的命令（比如 `node script.js`）；当某一个平台真的需要不一样的写法（Windows 的路径引号、PowerShell 命令、`.cmd` 后缀等）时，再加对应的 `commandWindows` / `commandDarwin` / `commandLinux`。这样插件不会因为作者只在自己的开发机上测过就排除其他用户。

或者引到独立文件：

```jsonc
{ "hooks": "./hooks/hooks.json" }
```

`./hooks/hooks.json` 直接是 `{ PreToolUse: [...], ... }`，不再有外层 `hooks` 包裹。

---

## `command` 里的变量替换

| 变量               | 展开成                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${pluginDir}`     | 插件安装目录绝对路径（版本化 cache 目录，重装/升级时会被擦掉）                                                                                    |
| `${pluginDataDir}` | 插件**持久数据目录**（`~/.x-code/plugins/data/<id>/`），跨重装/升级保留——索引、缓存、用户偏好放这里。第一次替换时自动 `mkdir -p`，hook 直接写就行 |
| `${cwd}`           | 事件发生时的当前工作目录                                                                                                                          |
| `${homedir}`       | `os.homedir()`                                                                                                                                    |
| `${sep}`           | OS 路径分隔符（Windows 是 `\`，其他是 `/`）                                                                                                       |
| `${env:NAME}`      | `process.env.NAME`（缺失返回空串）                                                                                                                |

**未知变量原样保留**——比如 `${plugindir}` 这种拼写错会以 "file not found" 在 shell 里报错，而不是被静默替换成空串。这是刻意设计，让 typo 现形。

**`${pluginDir}` vs `${pluginDataDir}`**：前者是插件代码所在地（卸载/升级时会丢），后者是插件运行期需要保留的数据所在地。比如一个 "学过的代码风格" 缓存应该写到 `${pluginDataDir}`，这样用户升级插件版本时之前的学习不会清零。

---

## Stdin payload

每个 hook 从 stdin 收到一行 JSON。顶层结构：

```jsonc
{
  "event": "PreToolUse", // 事件名
  "session": {
    // 每个事件都有
    "cwd": "/abs/path/to/project",
    "modelId": "anthropic:claude-sonnet-4-6",
  },
  "plugin": {
    // 标识哪个插件的 hook 正在跑
    "id": "linear@anthropic-marketplace",
    "dir": "/abs/.x-code/plugins/cache/anthropic-marketplace/linear/1.2.0",
  },

  // 事件特有字段平铺在顶层：
  "tool": {
    // PreToolUse / PostToolUse
    "name": "writeFile",
    "args": { "path": "src/foo.ts", "content": "..." },
    "callId": "call_abc123",

    // PostToolUse 才有：
    "output": "wrote 42 bytes",
    "isError": false,
  },
  "prompt": "Refactor X to do Y", // 仅 UserPromptSubmit
  "turn": 3, // 仅 TurnComplete
  "tokenUsage": {
    // 仅 TurnComplete / SubagentStop
    "inputTokens": 4321,
    "outputTokens": 567,
    "totalTokens": 4888,
  },

  // PreCompact / PostCompact
  "trigger": "proactive", // 或 "reactive"（即"prompt too long"触发的)
  "messageCount": 87, // 压缩前（PreCompact）或压缩后（PostCompact）的 messages 数量
  "tokenEstimate": 184_000, // 仅 PreCompact
  "summary": "...", // 仅 PostCompact —— 空串表示走的是轻量压缩（没生成 LLM summary）

  // SubagentStart / SubagentStop
  "agent": {
    "name": "code-reviewer",
    "description": "review the diff",
    "prompt": "<full prompt sent to sub-agent>", // 仅 SubagentStart
  },
  "durationMs": 12_345, // 仅 SubagentStop
  "outcome": "completed", // 仅 SubagentStop：completed / aborted / failed
}
```

---

## Stdout 决策

Hook 用 stdout 回一行 JSON。stdout 为空 = 默认 `allow`（大部分 fire-and-forget hook 不输出）。无法解析为 JSON 的 stdout 也按 `allow` 处理，并在 debug log 留 breadcrumb。

```jsonc
// 默认：agent 正常走
{ "decision": "allow" }

// 附加 context（UserPromptSubmit / PostToolUse）
{ "decision": "allow", "context": "Current sprint: Sprint 42" }

// 阻止 agent 做这件事
{ "decision": "deny", "reason": "禁止编辑 prod 配置" }

// 改写参数（PreToolUse）/ 改写输出（PostToolUse）
{ "decision": "modify", "args": { "path": "/safer/path" } }
{ "decision": "modify", "output": "[redacted]" }
{ "decision": "modify", "context": "Sprint 42 in progress" }
```

实际生效情况：

| Event                                                                                                            | `deny`                             | `modify.args`            | `modify.output`             | `context`              |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------ | --------------------------- | ---------------------- |
| `UserPromptSubmit`                                                                                               | 用合成的 assistant 消息回绝        | —                        | —                           | 前置注入到 user 消息里 |
| `PreToolUse`                                                                                                     | 用 "denied by hook" 作为 tool 结果 | 替换 tool 实际收到的参数 | —                           | (忽略)                 |
| `PostToolUse`                                                                                                    | (deny 忽略——已经太晚了)            | —                        | 替换 model 看到的 tool 结果 | (忽略)                 |
| `SessionStart` / `PreCompact` / `PostCompact` / `SubagentStart` / `SubagentStop` / `TurnComplete` / `SessionEnd` | (无决策——stdout 被忽略)            | —                        | —                           | —                      |

多个 hook 命中同一事件：

- **决策事件**按注册顺序串行；`deny` 短路剩下的
- **fire-and-forget 事件**并行
- `modify` 决策叠加：后面的覆盖前面的

---

## 失败处理

Hook 崩溃、超时或非零退出，默认按 `allow` 处理，warning 写到 `~/.x-code/logs/debug.log`（要先 `DEBUG_STDOUT=1` 或 `xc --plugin-debug` —— 后者只镜像 `plugins.` / `hooks.` / `marketplace.` 标签的行，更安静）。

某个 hook 设 `"failurePolicy": "block"` 才会把非零退出当 `deny`。只给真的想做严格 gate 的 hook 用——默认 allow 是为了保证坏 hook 不会卡死 agent。

30s 是 timeout 的硬上限，不是默认值。默认 5s。需要长时间任务的话，hook 应该 spawn 后台进程然后立即返回。

### 怎么确认 hook 真的跑了

Hook 子进程的 `stdout` 被 `execa` 当成决策 JSON 解析，`stderr` 也被 pipe 吞掉——所以 hook 里 `console.log` / `process.stderr.write` 写的诊断信息看不到。可观测点是 debug 日志：

- **`hooks.exec-ran <pluginId> <event>: decision=<allow|deny|modify>`** —— 每次 hook 成功跑完一行（不管返回啥决策）
- `hooks.exec-timeout` / `hooks.exec-nonzero` / `hooks.exec-error` —— 失败路径
- `hooks.bus-error` —— 编排层错误
- `hooks.matcher-invalid` —— matcher 正则无效

`xc --plugin-debug` 把这些行实时镜像到 stderr，跑一会儿 `/exit` 然后 grep `~/.x-code/logs/debug.log` 也行。Hook 不触发的最常见原因：(a) plugin 没启用（`/plugin list` 看），(b) 没 refresh（`/plugin refresh`），(c) `matcher` 正则不匹配工具名（工具名是 camelCase，如 `writeFile`、`edit`）。

---

## Abort 行为

用户 Esc / Ctrl+C 时，AbortSignal 通过 execa 的 `cancelSignal` 一路传到 hook 子进程，SIGKILL。Hook 不用做任何特殊处理——会被直接干掉。

---

## 端到端示例：写文件前自动 lint

```js
// hooks/lint.js — PreToolUse 上挂 writeFile|edit
const data = require('fs').readFileSync(0, 'utf-8') // 读 stdin
const event = JSON.parse(data)
const filePath = event.tool.args.path

if (!filePath.endsWith('.ts')) {
  console.log(JSON.stringify({ decision: 'allow' }))
  process.exit(0)
}

const { execSync } = require('child_process')
try {
  execSync(`eslint --quiet "${filePath}"`, { stdio: 'pipe' })
  console.log(JSON.stringify({ decision: 'allow' }))
} catch (e) {
  console.log(
    JSON.stringify({
      decision: 'deny',
      reason: `Lint failed:\n${e.stdout?.toString() || e.message}`,
    }),
  )
}
```

Manifest：

```jsonc
{
  "name": "ts-lint-gate",
  "version": "0.1.0",
  "hooks": {
    "PreToolUse": [{ "matcher": "writeFile|edit", "command": "node ${pluginDir}/hooks/lint.js" }],
  },
}
```

之后 agent 写 TypeScript 文件失败 lint 时会收到 `deny`，原因附带具体 lint 输出——model 看得到为什么并自己调整。

---

## Sub-agent 行为

Sub-agent 继承父 session 的 HookBus，所以 sub-agent 里的工具调用也会触发 `PreToolUse` / `PostToolUse`。这是刻意的——想审计模型所有行为的 plugin 必须这样才能看全。`SessionStart` / `SessionEnd` 只对外层 session 触发，sub-agent 没有。

**注意递归**：hook 自己又调 `xc` 或起 agent 时，那些工具调用也会触发 `PreToolUse`。hook 逻辑要紧凑，多用 `matcher` 正则约束触发的 tool。

---

## 临时关掉 hooks

```bash
xc --no-hooks            # 插件正常加载，hooks 不执行
xc --no-plugins          # 核弹：完全关插件
```

用于排查"是不是 hook 让 CLI 卡住/变慢"。
