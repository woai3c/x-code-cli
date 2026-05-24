# 知识库与自动记忆 — 使用指南

X-Code CLI 在每个会话启动时把"项目背景 + 你的偏好 + 上次的关键事实"自动拼进 system prompt 让 agent 知道。你不需要每次重新解释项目结构、命名约定、上次决定。

英文版：[knowledge.en.md](./knowledge.en.md)

---

## 5 层加载顺序

启动时按下面顺序拼接，**先写的优先级低，后写的覆盖前面同名/同类内容**：

```
1. ~/.x-code/AGENTS.md                  # 用户级偏好（手写）
2. ~/.x-code/memory/auto.md             # 用户级自动记忆（AI 写）
3. <repo>/AGENTS.md chain               # 从 cwd 走到 .git 根，root → leaf
4. <repo>/.x-code/memory/auto.md        # 项目自动记忆（AI 写）
5. <repo-root>/AGENTS.local.md          # 项目私人偏好（手写，gitignored）
```

第 3 步的 "chain" 意思是：如果你在 monorepo 的子包工作，子包的 AGENTS.md 会覆盖根的 AGENTS.md——leaf 优先。

> **Windows 路径**：`~/.x-code` 在 Windows 上是 `%USERPROFILE%\.x-code`。

---

## AGENTS.md vs CLAUDE.md

每一层加载时，先找 `AGENTS.md`；找不到才回退 `CLAUDE.md`（Claude Code 兼容只读）。

**意味着：**

- 你有现成 `CLAUDE.md` 项目可以直接用，不需要重写
- `/init` 永远只写 `AGENTS.md`（既新建也是 update 到 `AGENTS.md`，不动 `CLAUDE.md`）
- 想从 Claude Code 迁过来，留 `CLAUDE.md` 即可；想完全自治，把内容搬到 `AGENTS.md` 并删 `CLAUDE.md`

---

## 三类文件分别写什么

### `~/.x-code/AGENTS.md` — 用户级偏好

写跨项目通用的事实和偏好。例：

```markdown
# 我的偏好

- 我习惯用 Vitest，不用 Jest
- 写 TS 优先严格模式（`strict: true`），不要 any
- Git commit 信息走 Conventional Commits（`feat:` / `fix:` / `chore:` …）
- 代码注释优先英文，doc 写中文

# 我常用的项目结构

- monorepo 用 pnpm workspace
- 包路径约定 `packages/<name>/src/...`
```

### `<repo>/AGENTS.md` — 项目共享（committed）

写本项目的架构 / 约定，团队成员一起用。例：

```markdown
# x-foo project

## 架构

- `packages/api/` Hono server，部署到 Cloudflare Workers
- `packages/web/` Next.js 14 app router，部署到 Vercel
- `packages/shared/` 跨端共享类型 + util

## 不要碰

- `migrations/` 由 DBA 维护，PR 别动
- `prisma/seed.ts` 只在 staging 跑，生产用专门脚本

## 常用命令

- `pnpm dev` 启动整个 monorepo（含 db、api、web）
- `pnpm bench:api` 跑 api 基准测试
```

monorepo 子包想覆盖根级约定时，在子包根放自己的 `AGENTS.md`（leaf 优先）。

### `<repo-root>/AGENTS.local.md` — 项目私人（gitignored）

放你个人的本地偏好——不会提交。例：

```markdown
# 我的本地偏好

- 我在用 macOS，shell 是 fish
- 测试只跑 packages/api/，其他改 PR 时 CI 会跑
- 用 `pnpm bench:api -- --reporter=tap` 看 tap 输出
```

---

## 自动记忆（`auto.md`）

每轮对话结束后，CLI 自动从最近 transcript 里筛选**值得长期记住**的事实，写到 `auto.md`。下次会话作为上下文加载。

筛选什么：

- **user**：关于用户角色 / 技能 / 目标的稳定事实
- **feedback**：用户的纠正或确认（"不要 mock 数据库"、"这种风格就对了"）
- **project**：项目里的进行中工作 / 决定 / 非显然状态
- **reference**：指向外部资源（Linear 项目、Grafana dashboard 等）

文件分两份：

| 路径                            | 范围 |
| ------------------------------- | ---- |
| `~/.x-code/memory/auto.md`      | 用户 |
| `<repo>/.x-code/memory/auto.md` | 项目 |

文件里每条记忆是一个独立的 markdown section + YAML frontmatter（type、key、date 等元信息）。

### 查看自动记忆

```text
> /memory
（agent 弹列表，按类目分组，project + user 都列）
```

### 手动改

直接编辑文件——记忆是 markdown，所见即所得。`/memory` 弹的就是该文件的内容。

要让 agent **忘掉**某事，删对应 section 即可。要**添加**事实，可以手写 section（最简形态：`# 标题` + 一段 body）。

---

## `/init` — 给项目生成 AGENTS.md

新项目想要 `AGENTS.md`？

```text
> /init
（agent 扫码 + git log + README，写一份初始 AGENTS.md 到项目根）
```

已经有 `AGENTS.md` 时，`/init` 会**更新**而不是覆盖。

可以反复跑——agent 会比对现状和文件，增量补充。

---

## 实战提示

- **AGENTS.md 写决定不写事实**——agent 能 grep 出"用了哪个 ORM"，但不能猜"为什么不用 X"。多写"why" 少写"what"
- **AGENTS.md 越短越好**——会加进每轮 system prompt，长 = token 成本。500 行的 AGENTS.md 不如 50 行的 AGENTS.md + 一个 `## 详细架构` 部分链到 `docs/architecture.md`
- **`.local.md` 写仅你需要的**——不要把团队约定塞 local，否则别人 reproduce 不出来你的环境
- **不要直接编辑 `auto.md` 当配置**——它是 AI 写给 AI 看的格式，手改可以但风格会被下次自动写入打乱。要稳定的偏好放 `AGENTS.md`

---

## 故障排查

| 症状                    | 处理                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| Agent 不知道我的偏好    | 重启 `xc`——AGENTS.md 是启动期读一次                                          |
| `/memory` 是空的        | 全新项目正常，多对话几次会自动生成                                           |
| 看不到自动记忆生效      | 检查 `~/.x-code/memory/auto.md` 是否存在；`DEBUG_STDOUT=1` 后 grep `memory.` |
| 想从 Claude Code 迁过来 | 留着现有 `CLAUDE.md`，CLI 会读它（缺 `AGENTS.md` 时回退）                    |
| AGENTS.md 太长拖慢启动  | 拆分——主文件留约定，详细文档放别处，AGENTS.md 里引一句"详见 docs/X"          |
