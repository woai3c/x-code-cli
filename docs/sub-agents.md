# 子 Agent（task 工具）— 使用指南

X-Code CLI 通过 `task` 工具支持子 agent 委派：模型可以把某个独立子任务（研究、code review、计划等）派给一个有自己 system prompt、独立上下文窗口、可选不同 model 的子 agent，运行完只把最终结论回填给主 agent。这样主对话不被中间过程污染。

英文版：[sub-agents.en.md](./sub-agents.en.md)

---

## 内置子 agent

CLI 自带 4 个：

| 名字              | 适合                                                      | 工具白名单                                             |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `explore`         | 在大代码库里搜索某个关键字 / 符号 / 调用链；只 read，不改 | `readFile`、`glob`、`grep`、`listDir`、`shell`（受限） |
| `general-purpose` | 不归类的杂项研究 / 多步骤任务                             | 默认完整工具集（task 除外）                            |
| `plan`            | 给定任务，探索代码并产出实施计划                          | `readFile`、`glob`、`grep`、`listDir`（只读）          |
| `code-reviewer`   | 审查改动 / PR / diff                                      | `readFile`、`glob`、`grep`、`listDir`、`shell`（受限） |

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

## 自定义子 agent

把 `.md` 文件放到下面任一目录即可：

| Scope | 路径                              |
| ----- | --------------------------------- |
| 用户  | `~/.x-code/agents/<name>.md`      |
| 项目  | `<repo>/.x-code/agents/<name>.md` |

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

frontmatter 字段都不存在 `required` 的运行时检查（除了 name 和 description）——其余缺省值合理。

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
3. **Plan 模式继承**：父 session 在 plan 模式下，`general-purpose` 子 agent 会被禁掉写工具（其他子 agent 的工具白名单可能本来就只读）。
4. **独立上下文**：子 agent 看不到主 session 的 message history——它只看到自己的 system prompt + task 调用的 prompt 参数。
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

可用工具名一览（**必须 camelCase**，跟 `packages/core/src/tools/index.ts` 的 `toolRegistry` 一致）：`readFile`、`writeFile`、`edit`、`shell`、`glob`、`grep`、`listDir`、`webSearch`、`webFetch`、`askUser`、`enterPlanMode`、`exitPlanMode`、`todoWrite`。**`task` 工具永远禁用**（防递归）。

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
