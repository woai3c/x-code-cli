# 知识库与长期记忆

X-Code CLI 同时使用人工维护的项目知识和全局长期记忆。项目约定进入稳定的 system prompt；详细记忆按当前问题动态召回，避免把全部历史内容塞进每一轮上下文。

英文版：[knowledge.en.md](./knowledge.en.md)

## 加载顺序

启动时按以下顺序合并知识，越靠后的项目文件优先级越高：

```text
1. ~/.x-code/AGENTS.md                  # 用户级人工偏好
2. ~/.x-code/memory/MEMORY.md           # 全局记忆的派生 Core profile
3. <repo>/AGENTS.md chain               # cwd 到 git root，root → leaf
4. <cwd>/AGENTS.local.md                # xc 启动目录下的私人偏好
```

在每层中优先读取 `AGENTS.md`，不存在时回退到 `CLAUDE.md`。`/init` 只创建或更新 `AGENTS.md`。

Windows 上的 `~/.x-code` 对应 `%USERPROFILE%\.x-code`。设置 `X_CODE_HOME` 可以覆盖用户目录，适合隔离测试。

## 人工知识文件

### `~/.x-code/AGENTS.md`

保存跨项目稳定适用的人工规则，例如语言偏好、提交规范和常用工具。它每轮都会进入系统提示，应保持简短。

### `<repo>/AGENTS.md`

保存团队共享的架构、命令和约束。monorepo 会从仓库根向当前目录加载整条 chain，子目录文件可以覆盖根规则。

### `<cwd>/AGENTS.local.md`

保存 `xc` 启动目录下只对当前用户有效、不应提交的偏好。该文件不会沿仓库目录链向上查找。

## Memory v2

Memory v2 是一个跨仓库共享的用户级记忆系统。所有仓库使用同一个全局命名空间：

```text
~/.x-code/memory/
  MEMORY.md                 # 从 topics 确定性生成，不是正文真源
  topics/*.md               # 完整记忆正文，唯一真源
  .state/
    schema.json
    jobs/{pending,running,failed}/
    transactions/
    changes/
    locks/
    recent-runs.jsonl
```

仓库关系记录在 topic 的 `applies_to` 中，用于召回加权，不会再创建项目级自动记忆文件。

### 什么时候写入

每个根 Agent 的完整问答 clean stop 后，CLI 只把本轮增量原子写成 durable job。主回答不等待记忆模型；后台 worker 随后提取和提交长期事实。

工具中间轮次、子 Agent、abort、error、content filter 和最终 length 截断不会创建记忆任务。

系统重点保存：

- 用户身份、能力、长期目标、语言和协作偏好。
- 用户长期维护的产品、仓库关系、高层技术栈和非显然架构原因。
- 用户明确纠正或确认的工作方式。
- 跨会话仍有价值的 workflow、project decision 和 reference。

普通 diff、临时报错、依赖清单、当前一次性任务、密钥和模型推断不会作为长期事实保存。写入 job 和 topic 前都会执行 secret redaction。

### 冲突与删除

同一事实使用稳定的 `factId` 表示 subject + predicate。当用户提供更新且更准确的值时，新值和旧值在同一事务中处理，旧值会从所有 topic 中物理删除，不保留可召回的 archive 副本。

延迟到达的旧 job 不能覆盖具有更新 `observedAt` 的事实。明确用户陈述、成功工具证据和未来计划按不同事实类型裁决；无法确认哪条准确时拒绝写入。

要删除记忆，直接告诉 Agent，例如：

```text
忘记我之前关于部署平台的记忆。
```

显式 forget 会物理删除目标事实。会话 transcript 的隐私删除属于另一项独立功能。

### 如何召回

新会话只常驻一个不超过预算的 Core profile。每次用户提问时：

1. 本地 exact、alias、path、identifier 和 BM25F 检索，不消耗模型 token。
2. 强匹配直接读取相关 section，并作为低权限历史 attachment 注入请求副本。
3. 只有模糊且确实依赖历史的问题才调用 semantic selector；selector 只读取紧凑 topic manifest，不读取全部正文。
4. 工具结果首次出现的新路径、package、错误码或 identifier 可以触发一次 late-bound 本地召回。

本版本不使用 embedding、向量数据库或 SQLite。Markdown 是唯一正文真源。

## `/memory` 命令

```text
/memory
/memory status
/memory search <query>
/memory search --semantic <query>
/memory explain
/memory reload
```

- `/memory`：列出 topic 类型、摘要、事实数量和 pinned 状态。
- `/memory status`：显示 schema、generation、队列、worker、最近运行和损坏 topic。
- `/memory search`：本地检索最多 5 个相关 section。
- `/memory search --semantic`：显式使用 AI selector 选择相关 topic。
- `/memory explain`：显示最近一次召回的 routes、分数、选择和 token packing。
- `/memory reload`：加载人工编辑，重建 `MEMORY.md` 和索引。

`memorySearch` 也是根 Agent 的只读工具，但不能枚举全部记忆，也不能绕过当前问题的候选范围。子 Agent 不注册这个工具，也不创建记忆 job。

## 人工编辑

完整正文位于 `~/.x-code/memory/topics/*.md`。可以直接编辑，但运行中的 CLI 不使用 `fs.watch`：修改后需要执行 `/memory reload` 或重启。

注意：

- 不要直接编辑 `MEMORY.md`；它是派生文件，会被覆盖。
- 没有 `x-memory` 标记的人工正文可以检索，自动写入器不会删除它。
- frontmatter、fact marker、重复 fact ID 或 related link 损坏时，整个 topic 会从活动索引隔离，并在 `/memory status` 报错。
- 自动事务只写实际发生变化的 topic，不会顺手重写无关的人工 Markdown 文件。

## 旧 `auto.md`

Memory v2 不迁移旧系统：

- `~/.x-code/memory/auto.md` 和 `<repo>/.x-code/memory/auto.md` 不读取。
- 不校验、不移动、不改名、不删除。
- 文件存在不会报错，也不会影响 v2 初始化和写入。

如果确认不再需要旧文件，可以由用户自行备份或清理；CLI 不会主动处理。

## 配置

`~/.x-code/config.json` 支持：

```json
{
  "memory": {
    "model": "inherit",
    "reasoning": "auto",
    "maxInputTokens": 12000,
    "maxOutputTokens": 1500,
    "maxTotalOutputTokens": 8192,
    "maxOperationsPerTurn": 8,
    "drainTimeoutMs": 5000,
    "retryMaxAttempts": 8,
    "recall": {
      "maxTopicsPerTurn": 5,
      "maxTokensPerTopic": 1500,
      "maxTokensPerTurn": 4000,
      "maxTokensPerCompactionWindow": 15000,
      "semanticSelector": "auto",
      "selectorModel": "inherit",
      "lateBoundRecall": true
    }
  }
}
```

`inherit` 表示使用当前主模型。`reasoning` 支持 `auto`、`off`、`low` 和 `provider-default`；`auto` 会在模型无法关闭 thinking 时降到最低 effort。`maxOutputTokens` 是第一次提取的基础预算，只有结构化输出为空或截断时才逐步增加到 `maxTotalOutputTokens`。provider 凭据始终只从环境变量读取，不会写入 job。

## 故障排查

| 症状                 | 处理                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `/memory` 为空       | 全新存储正常；完成一次包含长期事实的完整问答，再看 `/memory status`                       |
| pending 长时间不减少 | 检查 provider key 和 `/memory status` 的 worker、Last run                                 |
| failed 增加          | 查看 status 的 error category；启用 `DEBUG_STDOUT=1` 后检查 `~/.x-code/logs/debug.log`    |
| 人工编辑不生效       | 执行 `/memory reload` 或重启；系统没有 watch                                              |
| topic 消失           | 查看 `/memory status` 的 Invalid 列表，修复 frontmatter、fact ID 或 related link          |
| 召回不准确           | 用 `/memory explain` 查看 exact/BM25F/selector 路径，再用具体 query 执行 `/memory search` |
| 想验证跨仓库         | 在两个仓库中使用同一 `X_CODE_HOME`，保存后从另一个仓库提问                                |

`AGENTS.md` 适合必须始终执行的明确规则；Memory v2 适合 Agent 从完整问答中持续维护、按需召回的用户画像和长期事实。
