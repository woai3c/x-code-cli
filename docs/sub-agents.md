# 子 Agent（task 工具）— 使用指南

X-Code CLI 通过 `task` 工具支持子 agent 委派：模型可以把某个独立子任务（研究、code review、计划等）派给一个有自己 system prompt、独立上下文窗口、可选不同 model 的子 agent，运行完只把最终结论回填给主 agent。这样主对话不被中间过程污染。

英文版：[sub-agents.en.md](./sub-agents.en.md)

---

## 内置子 agent

CLI 自带 5 个（另有可选的 `browser`，见下文）：

| 名字              | 适合                                                      | 工具白名单                                                         |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `explore`         | 在大代码库里搜索某个关键字 / 符号 / 调用链；只 read，不改 | `readFile`、`glob`、`grep`、`listDir`、`shell`（受限）             |
| `general-purpose` | 不归类的杂项研究 / 多步骤任务                             | 默认完整工具集（task 除外）                                        |
| `plan`            | 给定任务，探索代码并产出实施计划                          | `readFile`、`glob`、`grep`、`listDir`（只读）                      |
| `code-reviewer`   | 审查改动 / PR / diff                                      | `readFile`、`glob`、`grep`、`listDir`、`shell`（受限）             |
| `goal-verifier`   | `/goal` 完成度的只读独立验收，返回严格 JSON               | `readFile`、`glob`、`grep`、`listDir`、`shell`（受限，仅只读命令） |

> 工具名是 **camelCase**（跟代码里 `toolRegistry` 的 key 一致）——`read_file`、`write_file` 这种 snake_case 写法**不会匹配**，会让子 agent 拿到一个空工具集。
>
> `shell（受限）` 表示 `shell` 工具仍可用，但 `shellRestrictions` 默认拦截破坏性命令（`rm`、`mv`、`git push`、`> redirect` 等，完整列表见 `packages/core/src/agent/sub-agents/built-in.ts:SHELL_DENY_KEYWORDS`）。
>
> `plan` 内置 sub-agent **不含** `enterPlanMode` ——它的产出是 Markdown 计划文本而不是切换主会话的权限模式。`/plan` 这个 CLI flag 跟 `plan` sub-agent 是两件事。

主 agent 通过 `task` 工具调用它们：

```text
（agent 自动调用，等价于：）
task(subagent_type="explore", description="find all callers of formatDate",
     prompt="Search the repo for callers of formatDate(). Return paths + line numbers.")
```

子 agent 在隔离上下文里跑（最多 `maxTurns` 轮），结束后只返回最终的 assistant text。Token 用量记入主会话。

---

## 浏览器自动化

`browser` 是第 6 个内置子 agent，但**默认不注册**——它能用真实浏览器（由 [@playwright/mcp](https://github.com/microsoft/playwright-mcp) 驱动）完成 `webFetch` / `webSearch` 搞不定的任务：登录态页面、JS 渲染的 SPA、表单填写、多步交互。优先基于**无障碍树**操作（文本化，跨所有厂商可用，含非多模态模型）；在支持视觉的模型上还能截图处理 canvas、地图、图表等纯视觉内容。纯文本模型可以借用已配置的视觉 provider 获取文字描述。

轻量视觉检查与它相互独立：主 agent 默认就能使用 `browserVisualCheck` 检查本地网页，不需要 `/browser on`。

**启用交互式 Browser Use**（二选一）：

- 运行中：`/browser on`（热生效，无需重启；`/browser off` 只关闭交互式 Browser Use）
- 配置：`~/.x-code/config.json` 里 `"browser": { "enabled": true }`

本地视觉检查默认开启，可用 `/browser check-on` / `/browser check-off` 独立切换，也可以配置 `"browser": { "visualCheck": false }`。关闭 Browser Use 时，如果视觉检查仍开启，共用的浏览器会继续保留。

**前置条件**：本机装了 Node 与 Chrome；不需要安装 Chrome 插件。首次调用会通过已固定并验证版本的 `@playwright/mcp` 拉起独立浏览器（几十秒）。可选配置：

```json
{
  "browser": {
    "enabled": true,
    "visualCheck": true,
    "headless": false,
    "browser": "chrome",
    "viewport": "1280,800",
    "vision": true
  }
}
```

> `headless` 默认 `false`（可见窗口，方便观察）；`browser` 默认 `chrome`（用系统 Chrome），也可填 `chromium` / `msedge` / `firefox` / `webkit`。`vision` 控制额外的坐标操作能力，截图本身不受它影响。

`browser: "chrome"` 只表示选择本机 Chrome 可执行文件，并不是连接你日常打开的 Chrome profile。Playwright 会启动独立的托管 profile；同一 workspace 下它自己的 cookies / localStorage 可以跨运行保留，但不会读取普通 Chrome 窗口的 tabs 或 cookies，也不需要插件。同一 workspace 同时运行两个 `xc` 时，只允许先启动浏览器的一方占用这个 profile；另一方会在启动 Chrome 前提示关闭已有会话，不会自动切换成丢失登录态的临时 profile。进程异常退出留下的 X-Code 占用锁会自动回收，Chrome 自身的 profile 锁仍作为最终兜底。

系统 prompt 会让模型在两条路径中选择：

- 修改网页视觉效果后，默认可用的 `browserVisualCheck` 会在临时 tab 中打开本地 `localhost` 页面，只返回一张当前视口截图和简短的 console error 摘要。截图前后都会校验最终地址，外部重定向会被拒绝；随后按 Playwright 的稳定 Page 身份关闭本次临时 tab，并通过 MCP tab API 恢复原 tab。若关闭或恢复失败，结果会明确警告，不会静默声称清理成功。导航产生的无障碍树不会进入模型上下文；模型看完后，图片会在下一轮替换成短占位文本，避免重复计费。连续三次未修改代码的视觉检查会被熔断，修改文件后自动恢复。截图原始 base64 不会写入项目的 `.x-code/sessions/*.jsonl`；MCP 偶尔保存的文件只进入当前系统临时目录，由操作系统或缓存清理软件管理。
- 需要点击、输入、登录或多步操作时，才需要先开启 `/browser on`，再委派给 `browser` 子 agent。

这是模型决策，不是每次 build 后必触发的确定性 hook，因此模型可能跳过。需要强校验时可以显式要求「做一次视觉检查」。

**隔离设计**：完整的浏览器工具（navigate / snapshot / click …）仍只注入给 `browser` 子 agent 的私有上下文；主 loop 只加载一个很小的 `browserVisualCheck` 窄接口。两条路径复用同一个有状态浏览器进程，并按完整浏览器任务串行执行，避免共享的“当前 tab”互相干扰；退出 CLI，或两项功能都关闭时才退出。若你手动关掉浏览器，下次任务会自动重连。视觉检查截图会发送给当前视觉模型；当前模型不支持图片时，会在进度和工具结果中提示后发送给已配置的视觉描述模型，再把简短检查结果交给当前模型。截图、网页内容和 console 输出始终按不可信数据处理，不会被当作指令；console 和浏览器启动诊断中的常见密钥及终端控制序列会先清理。

`localhost` 限制只约束顶层页面及其最终跳转，并不是网络沙箱；本地页面仍可按自身代码加载 CDN、接口或其他外部资源。需要验证完全离线的页面时，应由应用或测试环境自行阻断网络。

---

## 自定义子 agent

把 `.md` 文件放到下面任一目录即可：

| Scope | 路径                             |
| ----- | -------------------------------- |
| 用户  | `~/.x-code/agents/<name>.md`     |
| 项目  | `<cwd>/.x-code/agents/<name>.md` |

启动期自动扫描，运行中跑 `/plugin refresh` 也会重新加载（跟插件贡献的 sub-agent 一起）。项目级同名覆盖用户级；同名再覆盖内置。

> **Windows 路径**：`~/.x-code` 在 Windows 上是 `%USERPROFILE%\.x-code`。

### 文件格式

```markdown
---
name: my-agent # 必需，模型在 task() 里用这个名字调用
description: 一句话说清何时该用，模型会读这个做决定。 # 必需
tools: [readFile, grep, glob] # 可选，限定允许的工具白名单（注意 camelCase）
disallowedTools: [shell] # 可选，在白名单之上再禁
model: anthropic:claude-haiku-4-5 # 可选，覆盖父 model（用更便宜的）
maxTurns: 15 # 可选，硬上限轮次，默认 30
shellRestrictions: [rm, mv] # 可选，shell 命令关键字黑名单（只在 shell 在 tools 里时有意义）
---

你的 system prompt 写在这里。可以是多段——这是子 agent 收到的全部"指令"。

要让子 agent 知道它能用什么工具，可以在 prompt 末尾列出来，但不是必需的——
工具白名单已经由 frontmatter 的 `tools` 决定。
```

`name` 与 `description` 必填；上面列出的其他字段在出现时也会做类型校验。frontmatter 无效的文件会被跳过并输出 warning。

### 示例：bench-runner

`~/.x-code/agents/bench-runner.md`：

```markdown
---
name: bench-runner
description: 在隔离环境跑一次基准测试，返回数字 + 是否回归
tools: [shell, readFile]
model: anthropic:claude-haiku-4-5
maxTurns: 8
shellRestrictions: [rm, sudo, npm publish]
---

你的任务是跑当前项目的 bench 套件并报告结果。

1. 执行 `pnpm bench` 收集输出
2. 读 ./bench-baseline.json 拿到基线数字
3. 对比：每项操作和基线比慢超过 10% 算 regression
4. 输出格式（plain text，不要 markdown）：

   Bench results (vs baseline):
   - sort 1k: 12.3ms (baseline 12.0ms, +2.5%, OK)
   - sort 10k: 178.0ms (baseline 134.0ms, +32.8%, ⚠ regression)

   Verdict: 1 regression

不要试图修复 regression——只报告。
```

主 agent 在你提"跑下 bench 看有没有退步"时会自动派 task：

```text
> 跑下 bench 看有没有退步
[agent 调用 task(subagent_type="bench-runner", ...)]
```

---

## 子 agent 的约束

1. **禁递归**：子 agent 不能调 `task` 工具。运行时会拒绝。
2. **共享 AbortSignal**：用户 Esc 会同时杀掉主 agent 和所有运行中的子 agent。
3. **Plan 模式继承**：父 session 在 plan 模式下，**所有**子 agent 的写工具（`writeFile` / `edit` / `shell`）都会被禁用，`general-purpose` 也不例外。
4. **独立上下文**：子 agent 看不到主 session 的 message history；它会收到自己的定义 prompt、项目知识、相关召回记忆，以及 task 调用的 prompt 参数。
5. **Token 共享**：所有子 agent 的 token 用量加进父 session 的总账。

---

## `tools` / `disallowedTools` 的写法

- `tools: [...]` — 白名单。只列出来的能用。**不写 `tools` = 默认完整工具集**（task 除外）。
- `disallowedTools: [...]` — 黑名单。在白名单基础上再禁。

只读 agent 的常见组合：

```yaml
tools: [readFile, glob, grep, listDir, webFetch, webSearch]
```

需要 shell 但想拦截危险操作：

```yaml
tools: [readFile, shell, glob]
shellRestrictions: [rm, sudo, npm publish, git push]
```

可用工具名一览（**必须 camelCase**，跟 `packages/core/src/tools/index.ts` 的 `toolRegistry` 一致）：`readFile`、`writeFile`、`edit`、`shell`、`glob`、`grep`、`listDir`、`webSearch`、`webFetch`、`askUser`、`enterPlanMode`、`exitPlanMode`、`todoWrite`、`shellOutput`、`killShell`。**`task` 工具永远禁用**（防递归），`memorySearch` 只注册给根 Agent，子 agent 拿不到。

允许 `shell` 时，运行器会自动补上 `shellOutput` 和 `killShell`，确保后台命令可继续读取和终止。因此不能在 `disallowedTools` 中禁用任一配套工具；这种定义会被拒绝。详见 [shell-sessions.md](./shell-sessions.md)。

---

## 何时该写子 agent？什么时候不该？

**该写**：

- 重复出现的研究 / 验证流程，主 agent 每次手写有差异
- 要用便宜 model（haiku / glm-flash）跑能 offload 的工作
- 想限制工具到只读 / 只 shell 等子集
- 输出格式有固定模式（如 bench 报告、PR 审查清单）

**不该写**：

- 一次性任务（直接写在主对话里更快）
- 子 agent 系统 prompt 跟普通 system prompt 几乎一样的（用 [skill](./skills.md) 而非 sub-agent）

经验：sub-agent ≈ "可被命名调用的子流程"；skill ≈ "嵌入提示词模板"。

---

## 与插件的关系

插件可以在 manifest 里声明 `agents: "./agents"`，子目录的 `.md` 文件就成为可用的子 agent，与你手写的用户级子 agent 完全一致，只是带 `pluginId` 标记。详见 [plugins.md](./plugins.md)。
