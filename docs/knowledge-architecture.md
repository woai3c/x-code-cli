# 项目知识架构

X-Code 的知识加载体系:**人写的和 AI 写的严格分开,各自有独立的文件和触发机制**。

| 角色 | 写入者 | 目的 | 文件 |
|---|---|---|---|
| **项目说明** | 人(用户 / 团队) | 项目是什么、团队约定、业务背景 | `AGENTS.md` (项目根) |
| **全局偏好** | 人(用户) | 跨项目的个人偏好 | `~/.x-code/AGENTS.md` |
| **本地覆盖** | 人(用户) | 不提交到 git 的个人项目偏好 | `.x-code/local/preferences.md` |
| **项目记忆** | **AI** | AI 在对话中学到的项目相关事实 | `.x-code/memory/auto.md` |
| **全局记忆** | **AI** | AI 学到的用户相关事实(跨项目) | `~/.x-code/memory/auto.md` |

`AGENTS.md` 放在项目根,不在隐藏目录——这是对齐 Codex / OpenCode 的行业惯例,用户主权和发现性都更好。

---

## 文件布局

```
项目根/
├── AGENTS.md                     ← 项目说明(人写,git 追踪)
└── .x-code/                      ← CLI 内部状态(除 local/preferences.md 外不建议人工编辑)
    ├── memory/
    │   └── auto.md               ← AI 自动写入的记忆
    ├── sessions/
    │   └── *.json                ← 会话摘要(压缩时 / 退出时保存)
    ├── plans/
    │   └── *.md                  ← Plan Mode 产出
    └── local/
        ├── .gitignore            ← 内容是 `*`,整个 local/ 不提交
        └── preferences.md        ← 个人项目偏好(人写)

~/.x-code/
├── AGENTS.md                     ← 全局用户偏好(人写)
└── memory/
    └── auto.md                   ← 全局自动记忆
```

> 没有配置文件。API Key 和默认模型都走环境变量(`ANTHROPIC_API_KEY` / `X_CODE_MODEL` 等),一份数据源不必同步。

---

## AGENTS.md 加载规则

**单仓**:读项目根的 `AGENTS.md`。

**Monorepo**:从当前工作目录向上遍历到 `.git` 目录(含)或文件系统根,**沿路径每层都找 `AGENTS.md`**,按 **root-to-leaf** 顺序拼接。子包的 AGENTS.md 排在根之后——对模型权重更高——能覆盖根级约定。

示例:在 `packages/frontend/` 下启动时,加载顺序是:

```
### Project AGENTS.md (.)                  ← 根目录的 AGENTS.md(通用约定)
### Project AGENTS.md (packages/frontend)  ← 子包 AGENTS.md(React 特有约定)
```

代码实现见 `core/src/knowledge/loader.ts::collectAgentsMdChain`。

---

## AGENTS.md 模板(/init 生成)

`/init` 命令在项目根创建的 `AGENTS.md` 模板:

```markdown
# AGENTS.md

## Overview
<!-- 一两句话:项目做什么,给谁用 -->

## Tech Stack
<!-- 语言 / 框架 / 关键依赖 -->

## Commands
<!-- 常用命令(build / test / lint 等) -->

## Conventions
<!-- 非显而易见的项目约定 -->

## Business Context
<!-- 领域知识 / 业务约束 / 关键决策 -->
```

用户可以自由增删 section、完全改格式——这个文件是用户主权的。

---

## 自动记忆(auto.md)

**写入机制**:AI 在对话中判断学到了值得记的事,调用 `saveKnowledge` 工具主动写入。不是后台抽取,是 AI 在当前 turn 里顺手写。

**Taxonomy(4 分类)**:按"**知识类型**"分,不是按"主题"分。四类互斥,边界清晰:

| 类别 | 含义 | 典型触发 |
|---|---|---|
| `user` | 关于用户本身(角色、专长、长期约束) | "我是十年 Go 工程师,第一次碰 React" |
| `feedback` | 用户的纠正 **或** 认可(都要含原因) | "不要 mock 数据库——上季度 mock 过测试通过但迁移炸了" |
| `project` | 进行中的工作 / 决策 / 非代码可推导的状态 | "mobile release 冻结从 2026-03-05 开始" |
| `reference` | 外部系统指针 | "pipeline bug 都在 Linear 的 INGEST 项目" |

**不该写入**(避免记忆膨胀和误导):

- 代码里能看到的事实("这个项目用 React"——不需要记,AI 读 package.json 就知道)
- Git history 里有的(commit message、作者、时间)
- AGENTS.md 已经说过的
- 一次性调试解决方案

**冲突检测**:同 category + 同 key 自动替换(见 `auto-memory.ts::add`)。不是只追加。`add()` 会先对 key/fact 做 `sanitizeLine()`(折叠空白 + 去换行),保证"一条 fact 一行"的序列化格式不被调用方的多行输入破坏。

**TTL**:90 天未更新的条目启动时自动驱逐(`AutoMemory.evict(90)`)。

**大小限制**:注入 system prompt 时只取前 200 行(`MAX_LOAD_LINES`)。

**存储格式**(markdown):

```markdown
## Auto Memory

### feedback
- [2026-04-18] testing-db-policy: 集成测试必须打真库,不能 mock。原因:Q1 migration 事故,mocked 测试通过但生产炸了
- [2026-04-18] refactor-batching: 大规模重构倾向打成一个 PR 而不是拆多个——用户验证过减少 churn

### user
- [2026-04-18] user-stack: 十年 Go 工程师,React 新手,前端例子可类比后端概念

### project
- [2026-04-18] release-freeze: mobile release 冻结 2026-03-05 起,非 critical PR 要 flag
```

---

## 加载到 System Prompt 的完整顺序

`buildKnowledgeContext()` 按下面顺序拼接(后出现的权重更高):

```
1. Global Preferences (~/.x-code/AGENTS.md)      人写,跨项目
2. Global Auto Memory                            AI 写,跨项目
3. Project AGENTS.md (.)                         人写,项目根
4. Project AGENTS.md (packages/x)                人写,monorepo 子包(如有)
5. Project Auto Memory                           AI 写,本项目
6. Local Preferences                             人写,gitignored
```

整段注入位置:system prompt 末尾("## Project Knowledge" 段之后)。

---

## 和竞品的位置对比

| 工具 | 项目说明文件 | 位置 | 自动记忆 | Monorepo 向上遍历 |
|---|---|---|---|---|
| **X-Code** | `AGENTS.md` | 项目根 | ✅ auto.md(主动调用 saveKnowledge) | ✅ 向上到 `.git` |
| Codex | `AGENTS.md` | 项目根 | ✅ 后台双阶段 pipeline(Phase 1 + 2) | ✅ 向上到 `.git` |
| OpenCode | `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` 优先级链 | 项目根 | ❌ 无自动记忆 | ❌ 只读 cwd |
| Claude Code | `CLAUDE.md` | 项目根 | ✅ 后台 extractor 子 agent | ✅ 向上遍历 |

X-Code 选用 `AGENTS.md`(而非 `CLAUDE.md`)的原因:这是**供应商中性**的标准,用户如果已经为 Codex / OpenCode 写过 AGENTS.md,装我们的工具立刻能用,零迁移成本。

---

## 相关代码位置

| 功能 | 文件 | 关键函数 |
|---|---|---|
| AGENTS.md chain 加载 | `core/src/knowledge/loader.ts` | `collectAgentsMdChain()`, `buildKnowledgeContext()` |
| 自动记忆管理 | `core/src/knowledge/auto-memory.ts` | `AutoMemory` 类, `initMemories()`(project 实例按 cwd 缓存,global 全局单例) |
| saveKnowledge 工具 | `core/src/tools/save-knowledge.ts` | 4 类 taxonomy 的 schema + AI 触发指南 |
| Taxonomy 类型 | `core/src/types/index.ts` | `KnowledgeCategory` type |
| `/init` 命令 | `core/src/knowledge/init.ts` | `initProject()`, AGENTS_TEMPLATE |
| System prompt 的 memory 指南 | `core/src/agent/system-prompt.ts` | "Auto Memory Guidelines" 段 |
