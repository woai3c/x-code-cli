# Memory v2 手动测试

本文用于验证 Memory v2 的写入、持久化、跨仓库召回、冲突替换、显式删除、人工编辑和诊断功能。

测试把当前分支当作正常程序使用，直接读取和写入现有的 `~/.x-code/memory`。不要提前创建、清空、迁移或重建任何 Memory 目录。测试过程中写入的产品、偏好、marker 和人工正文都会进入真实记忆，测试完成后由你自行删除。

开始前只需退出其他正在运行的 x-code CLI，避免其他进程同时消费测试 job。本手测不设置、删除或改写 `X_CODE_HOME`，程序按正常启动规则使用当前用户目录。

## 1. 正常启动程序

在仓库目录执行：

```powershell
Set-Location D:\res\x-code-cli
pnpm dev
```

Memory v2 始终启用，不存在 `memory.enabled` 配置开关；`/memory status` 只用于查看运行状态。如果旧配置中存在 `memory.enabled`，该字段会被忽略，可以在方便时删除。

`pnpm dev` 会完成构建并启动当前分支。程序直接使用当前用户已有的 `.x-code\memory`；如果该目录不存在，也必须由程序首次启动时自行初始化，不能把手动建目录作为测试前置条件。当前终端仍需像平时使用 CLI 一样配置可用的 provider API key。后续未特别说明的 `/memory` 命令和对话，都在这个 CLI 中执行。

## 2. 检查真实记忆状态

进入 CLI 后执行：

```text
/memory status
```

预期结果：

- Memory 状态为 ready。
- Schema 为 2。
- worker 为 idle 或短暂 running。
- 记录当前 generation、topic 数量和 queue 状态，作为后续测试基线。
- 如果此前从未运行 Memory v2，generation、topics、pending、running、failed 应为 0；已有真实记忆时允许大于 0。

可选：另开一个 PowerShell，只读检查程序正在使用的现有目录：

```powershell
Get-ChildItem -Recurse -Force "$HOME\.x-code\memory"
Get-Content "$HOME\.x-code\memory\.state\schema.json"
```

这些命令只查看目录，不创建任何内容。预期 `MEMORY.md`、`topics` 和 `.state` 均由程序维护，`.state\schema.json` 为 schema 2。如果此前已经使用过 Memory v2，generation 和 topic 数量可以大于 0；重点是 `/memory status` 没有初始化错误。

## 3. 完整问答后异步写入

向 CLI 发送下面这条普通用户消息：

```text
请记住两件事：memory-v2-test-mode 当前是 alpha；我维护的产品 x-code-cli 是一个 TypeScript、Node.js、pnpm workspace 的 coding-agent CLI。
```

等待主回答完整结束，然后执行：

```text
/memory status
```

如果 worker 仍是 running，等待几秒后再次执行。预期：

- 主回答先完成，记忆写入提示稍后出现。
- queue 最终为 `0 pending · 0 running`。
- Last run 为 success 或 no-op；不应进入 failed。
- generation 比第 2 节记录的基线更大。

执行：

```text
/memory
```

预期能看到 user、portfolio 或 project 类型的 topic 摘要。

在另一个 PowerShell 检查 Markdown 真源：

```powershell
Get-ChildItem "$HOME\.x-code\memory\topics"
Get-Content -Raw "$HOME\.x-code\memory\MEMORY.md"
Get-ChildItem "$HOME\.x-code\memory\topics" -Filter *.md | ForEach-Object {
  "`n===== $($_.Name) ====="
  Get-Content -Raw $_.FullName
}
```

预期：

- `topics/*.md` 中能找到 `memory-v2-test-mode`、`x-code-cli` 和技术栈事实。
- 自动事实前存在 `<!-- x-memory: {...} -->` 标记。
- `MEMORY.md` 标明它是派生文件。
- `.state/jobs/pending` 和 `.state/jobs/running` 最终为空。
- `recent-runs.jsonl` 只包含统计，不包含记忆正文。

## 4. 精确召回和召回解释

新开一轮对话，询问：

```text
x-code-cli 的技术栈是什么？
```

回答结束后执行：

```text
/memory explain
```

预期：

- 回答包含刚才保存的 TypeScript、Node.js 和 pnpm workspace。
- explain 中 selected 不为空。
- routes 通常包含 exact 和/或 bm25。
- 精确 alias 命中通常不需要 semantic selector。
- packed tokens 不超过 4000。

再执行：

```text
/memory search x-code-cli 技术栈
```

预期返回相关 topic 和 section，而不是整个记忆库。

## 5. 语义召回

询问不直接包含产品名的历史问题：

```text
你还记得我之前提到的那个终端编程助手吗？它主要使用什么开发技术？
```

然后执行：

```text
/memory explain
```

预期：

- 能关联到 x-code-cli。
- 如果本地 route 无法唯一确定，explain 显示 semantic selector used。
- selector 只负责选择 topic；详细正文仍来自本地 Markdown。

## 6. 跨仓库召回

先退出 CLI：

```text
/exit
```

在 PowerShell 中切换到另一个仓库。不要设置 `X_CODE_HOME`，两个仓库会自然使用同一个真实用户记忆：

```powershell
Set-Location D:\res\kimi-code-main
node 'D:\res\x-code-cli\packages\cli\dist\cli.js'
```

询问：

```text
我维护的 coding-agent CLI 是什么？它的技术栈是什么？
```

预期：

- 即使当前位于另一个仓库，仍能召回 x-code-cli 和对应技术栈。
- 记忆仍写入同一个全局 `~/.x-code/memory/topics`，不会创建项目级 auto memory。

完成后退出，并返回 x-code-cli：

```text
/exit
```

```powershell
Set-Location D:\res\x-code-cli
pnpm dev
```

## 7. 新事实替换旧事实

发送明确纠正：

```text
更正并记住：memory-v2-test-mode 现在是 beta，alpha 已经不准确了。
```

等待 worker 完成后执行：

```text
/memory search memory-v2-test-mode
/memory status
```

再在 PowerShell 中检查所有可召回文件：

```powershell
Get-ChildItem "$HOME\.x-code\memory" -Recurse -File | Where-Object {
  $_.FullName -notmatch '\.state\\transactions'
} | Select-String -Pattern 'memory-v2-test-mode|alpha|beta'
```

预期：

- 检索结果只表达 beta。
- 活动 topics 和 `MEMORY.md` 中不再存在旧值 alpha。
- 同一语义槽位只有一个 fact ID，不会追加成两个事实。
- change manifest 的 reason 为 `replace-conflict`。

注意：session transcript 是独立的对话历史，可能仍包含用户最初说过的 alpha；这里验证的是所有记忆召回路径不再返回旧事实。

## 8. 人工编辑与 `/memory reload`

先在 CLI 中执行并记住当前结果：

```text
/memory search MANUAL_RELOAD_MARKER_2026
```

预期无结果。

在另一个 PowerShell 中选一个由程序现有记忆产生的 topic，在文件末尾追加无 fact ID 的人工正文。这里编辑 topic 是本节要验证的行为，不是启动前置步骤：

```powershell
$TopicsDir = Join-Path $HOME '.x-code\memory\topics'
$TopicFile = Get-ChildItem $TopicsDir -Filter *.md | Select-Object -First 1
Add-Content -Encoding UTF8 -Path $TopicFile.FullName -Value "`n## Manual verification`n`nMANUAL_RELOAD_MARKER_2026`n"
$TopicFile.FullName
```

回到尚未重启的 CLI，先再次执行：

```text
/memory search MANUAL_RELOAD_MARKER_2026
```

预期仍无结果，因为实现不使用 `fs.watch`，运行中的快照不会自动变化。

然后执行：

```text
/memory reload
/memory search MANUAL_RELOAD_MARKER_2026
```

预期 reload 后可以搜到人工正文，且 topic 文件中的人工正文没有被自动写入器删除或改写。

## 9. 损坏 topic 隔离

在 PowerShell 中向程序现有的 `topics` 目录写入一个故意损坏的 Markdown。这里只创建一个测试文件，不创建任何目录：

```powershell
$BrokenTopic = Join-Path $HOME '.x-code\memory\topics\broken-topic.md'
Set-Content -Encoding UTF8 -Path $BrokenTopic -Value 'this file intentionally has no frontmatter'
```

回到 CLI 执行：

```text
/memory reload
/memory status
```

预期：

- CLI 不崩溃。
- status 的 Invalid 列表包含 `broken-topic.md` 和错误原因。
- 损坏 topic 不进入 `/memory`、召回和 `memorySearch`。
- 其他有效 topic 继续工作。

清理损坏文件并重新加载：

```powershell
$BrokenTopic = Join-Path $HOME '.x-code\memory\topics\broken-topic.md'
Remove-Item -LiteralPath $BrokenTopic
```

```text
/memory reload
/memory status
```

预期 Invalid 恢复为空。

## 10. 显式 forget 物理删除

发送：

```text
忘记 memory-v2-test-mode，不要再把 alpha 或 beta 作为我的长期记忆。
```

等待 worker 完成，然后执行：

```text
/memory search memory-v2-test-mode
/memory status
```

在 PowerShell 中检查：

```powershell
Get-ChildItem "$HOME\.x-code\memory\topics" -Recurse -File | Select-String -Pattern 'memory-v2-test-mode|alpha|beta'
Get-Content -Raw "$HOME\.x-code\memory\MEMORY.md" | Select-String -Pattern 'memory-v2-test-mode|alpha|beta'
```

预期：

- `/memory search` 不再返回该事实。
- `topics/*.md` 和 `MEMORY.md` 都不存在该事实的 active、stale 或 archive 副本。
- 如果所属 topic 已无事实和人工正文，整个 topic 文件会被删除。
- change manifest 的 reason 为 `forget`。

## 11. Durable queue 恢复

发送一条新的明确记忆：

```text
请记住：memory-v2-queue-test 的值是 durable。
```

主回答结束后立即退出 CLI。如果任务仍在 pending 或 running，重新执行：

```powershell
Set-Location D:\res\x-code-cli
pnpm dev
```

然后执行：

```text
/memory status
/memory search memory-v2-queue-test
```

预期：

- 上次未完成的 running job 会被恢复并继续处理。
- 最终 pending 和 running 都为 0。
- durable 事实只出现一次。
- failed 若非 0，应能从 Last run 或 debug log 看出模型、schema 或提交错误，而不是静默丢失。

## 12. 最终检查

如需查看详细日志，重新运行 CLI 前设置：

```powershell
$env:DEBUG_STDOUT = '1'
```

日志位于真实用户目录：

```text
~/.x-code/logs/debug.log
```

测试写入的 `memory-v2-test-mode`、`memory-v2-queue-test`、`MANUAL_RELOAD_MARKER_2026` 和相关测试正文都位于真实记忆中。本文不提供批量删除命令；确认测试结果后，由你按实际内容自行删除，避免误删原有记忆。

## 13. 通过标准

以下条件全部满足才算手测通过：

- 只在完整根问答后出现一个 durable job，主回答不等待提取模型。
- topics 和 MEMORY.md 能写入产品、技术栈、偏好以及跨仓库关系。
- exact/BM25F 和语义改写都能召回正确 topic，无关问题不注入详细记忆。
- alpha 更正为 beta 后，所有记忆召回路径中的 alpha 为零。
- explicit forget 后，目标事实被物理删除。
- 人工编辑只有在 reload 或重启后生效，不存在 watch。
- 损坏 topic 被隔离且能在 status 中诊断。
- pending/running job 可在重启后恢复。
- 程序直接使用现有的 `~/.x-code/memory`，测试没有手动创建、重建或替换 Memory 目录，也没有依赖临时 `X_CODE_HOME`。
