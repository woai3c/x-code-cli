# Agent CLI Tools 实现对比分析

> 对比对象：**Claude Code** (Anthropic) / **Gemini CLI** (Google) / **Codex CLI** (OpenAI) / **x-code-cli** (本项目)
>
> 第 6 节 Web 工具还额外引入 **OpenCode** 做深入对比（OpenCode 的 web 工具接入方式独特，值得单独分析）。
>
> 分析日期：2026-04-05（2026-04-11 扩充 §6 与 §12 web 工具章节）

---

## 目录

- [1. 总览](#1-总览)
- [2. 工具定义架构](#2-工具定义架构)
- [3. Edit 工具](#3-edit-工具)
- [4. Shell 工具](#4-shell-工具)
- [5. 搜索工具 (Grep / Glob)](#5-搜索工具-grep--glob)
- [6. Web 工具](#6-web-工具)
- [7. 权限与安全模型](#7-权限与安全模型)
- [8. 工具执行调度](#8-工具执行调度)
- [9. 错误处理](#9-错误处理)
- [10. 结果处理与截断](#10-结果处理与截断)
- [11. 各产品独特功能](#11-各产品独特功能)
- [12. 优化路线图](#12-优化路线图)

---

## 1. 总览

| 维度               | Claude Code               | Gemini CLI                          | Codex CLI                   | x-code-cli        |
| ------------------ | ------------------------- | ----------------------------------- | --------------------------- | ----------------- |
| **语言**           | TypeScript (Bun)          | TypeScript (Node)                   | **Rust** + TS 薄壳          | TypeScript (Node) |
| **工具数量**       | ~40                       | ~25                                 | ~20                         | 11                |
| **代码量 (tools)** | ~30,000 行                | ~15,000 行                          | ~8,000 行 (Rust)            | ~1,500 行         |
| **Schema 格式**    | Zod v4                    | JSON Schema (`@google/genai`)       | 自定义 Rust JsonSchema      | Zod               |
| **AI SDK**         | 自研框架 (Anthropic API)  | `@google/genai`                     | OpenAI Responses API        | Vercel AI SDK     |
| **包结构**         | Monorepo                  | Monorepo                            | Monorepo (Bazel + Cargo)    | Monorepo (pnpm)   |
| **输出格式**       | 结构化 (Zod outputSchema) | 结构化 (llmContent + returnDisplay) | 结构化 (FunctionToolOutput) | 纯字符串          |

---

## 2. 工具定义架构

### Claude Code — `buildTool()` 丰富对象

```typescript
buildTool({
  name,
  description,
  prompt,
  inputSchema,
  outputSchema, // 双向 Zod schema
  validateInput, // 执行前校验
  checkPermissions, // 权限检查
  call, // 实际执行
  mapToolResultToToolResultBlockParam, // 结果 → 模型消息
  renderToolUseMessage, // UI 渲染
  isConcurrencySafe,
  isReadOnly, // 元数据标记
})
```

- 每个工具**自包含**：验证、权限、执行、结果格式化、UI 渲染全在一个定义里
- Prompt 是函数（可动态生成）
- 支持 `shouldDefer`（延迟加载 schema 减少 prompt 大小）

### Gemini CLI — OOP Builder + Invocation 模式

```typescript
class EditTool extends BaseDeclarativeTool<EditToolParams, ToolResult> {
  build(params): ToolInvocation { ... }
}

class EditToolInvocation extends BaseToolInvocation<EditToolParams, ToolResult> {
  getDescription(): string
  shouldConfirmExecute(): Promise<ConfirmationDetails | false>
  execute(signal, updateOutput?): Promise<ToolResult>
  getPolicyUpdateOptions(): PolicyUpdateOptions
}
```

- **两阶段分离**：`build()` 做验证 + 创建 Invocation，`execute()` 做执行
- 验证在构造期完成，execute 拿到的一定是已验证参数
- 每个工具有 `toolLocations()` 声明影响的文件路径

### Codex CLI — Rust Trait Handler + Runtime

```rust
pub trait ToolHandler: Send + Sync {
    type Output: ToolOutput + 'static;
    fn kind(&self) -> ToolKind;
    async fn is_mutating(&self, invocation: &ToolInvocation) -> bool;
    async fn handle(&self, invocation: ToolInvocation) -> Result<Self::Output, FunctionCallError>;
}

pub trait ToolRuntime<Rq, Out> {
    fn sandbox_preference(&self) -> SandboxablePreference;
    fn escalate_on_failure(&self) -> bool;
    async fn run(&self, req: &Rq, attempt: &SandboxAttempt, ctx: &ToolCtx) -> Result<Out, ToolError>;
}
```

- **Handler + Runtime 分离**：Handler 负责参数解析 + 路由，Runtime 负责实际执行
- Rust trait 系统提供编译期类型安全
- `ToolOrchestrator` 统一管理 approval → sandbox → execution → retry 流程
- 工具注册在 HashMap，按 `"namespace:name"` 键查找

### x-code-cli — AI SDK `tool()` 轻量函数

```typescript
const edit = tool({
  description: '...',
  inputSchema: z.object({ ... }),
  // execute 可选 — 无则在 loop.ts 手动处理
})
```

- 最简洁，零框架成本
- 有 `execute` 的工具由 AI SDK 自动调用
- 无 `execute` 的工具在 agent loop 的 `processToolCalls()` 手动分发
- 无验证层、无结构化输出、无 UI 渲染抽象

### 架构对比小结

| 特性                       |            Claude Code            |          Gemini CLI           |     Codex CLI      |       x-code-cli       |
| -------------------------- | :-------------------------------: | :---------------------------: | :----------------: | :--------------------: |
| 输入 schema 验证           |              Zod v4               |     JSON Schema + custom      |   Rust 类型系统    |    Zod (仅 schema)     |
| 输出 schema                |         Zod outputSchema          |        ToolResult 接口        | FunctionToolOutput |    无（纯 string）     |
| 执行前校验 (validateInput) |          每工具独立实现           |        构造期 + custom        |    Handler 内部    |           无           |
| 权限检查                   |       `checkPermissions()`        |         Policy Engine         |    Orchestrator    | `getPermissionLevel()` |
| UI 渲染                    |     `renderToolUseMessage()`      | `getDescription()` + IDE 集成 |      前端事件      |        callback        |
| 工具自描述                 | `isReadOnly`, `isConcurrencySafe` |           Kind 标记           |  `is_mutating()`   |           无           |

---

## 3. Edit 工具

### 匹配策略对比

| 策略                  |      Claude Code       |           Gemini CLI            |         Codex CLI         | x-code-cli |
| --------------------- | :--------------------: | :-----------------------------: | :-----------------------: | :--------: |
| 精确匹配              |           Y            |                Y                |             -             |     Y      |
| Curly quote 规范化    | Y (`findActualString`) |                -                |             -             |     -      |
| Flexible（忽略缩进）  |           -            |       Y（按行 trim 比较）       |             -             |     -      |
| Regex（token 化匹配） |           -            |     Y（分词 + `\s*` 连接）      |             -             |     -      |
| Fuzzy（Levenshtein）  |           -            |          Y（10%容差）           |             -             |     -      |
| Patch 格式            |           -            |                -                | Y（`@@` 标记 + `+/-` 行） |     -      |
| LLM 自修正            |           -            | Y (`FixLLMEditWithInstruction`) |             -             |     -      |

> **Codex 完全不同**：不用 old_string/new_string 替换模式，而是用 `apply_patch` —— 类似 `git diff` 的补丁格式，包含上下文行、添加行、删除行。模型需要输出完整的 patch。

### 安全与校验

| 特性         |         Claude Code         |           Gemini CLI           |        Codex CLI        | x-code-cli |
| ------------ | :-------------------------: | :----------------------------: | :---------------------: | :--------: |
| 先读后写检查 |    readFileState + mtime    |          Config 验证           |  Patch 要求上下文匹配   |   **无**   |
| 文件大小限制 |            1 GiB            |      有 (FILE_TOO_LARGE)       |       无明确限制        |   **无**   |
| 编码检测     |      UTF-8 / UTF-16LE       |         CRLF→LF 规范化         |            -            |   **无**   |
| 行尾符保留   |     CRLF/LF/CR 检测保留     |     trailing newline 保留      |     Patch 格式保留      |   **无**   |
| 并发编辑保护 |    mtime 对比 + 内容比较    |        SHA256 内容哈希         | Turn-level diff tracker |   **无**   |
| UNC 路径安全 |    阻止（防 NTLM 泄露）     |               -                |            -            |   **无**   |
| Secret 检测  |   `checkTeamMemSecrets()`   |        `.env` 自动屏蔽         |      Policy rules       |   **无**   |
| 路径纠正建议 |     `findSimilarFile()`     |        `correctPath()`         |            -            |   **无**   |
| 省略占位检测 |              -              | `detectOmissionPlaceholders()` |            -            |     -      |
| IDE 通知     | LSP didChange + VSCode diff |        IDE Client 集成         |        前端事件         |     -      |

---

## 4. Shell 工具

### 基本能力

| 特性     |      Claude Code       |         Gemini CLI         |         Codex CLI         | x-code-cli |
| -------- | :--------------------: | :------------------------: | :-----------------------: | :--------: |
| 命令格式 |         字符串         |           字符串           | **数组** (`Vec<String>`)  |   字符串   |
| 后台执行 |  `run_in_background`   | `is_background` + PID 追踪 | `exec_command` (长期运行) |   **无**   |
| 流式输出 |        callback        |  `updateOutput` (1s 间隔)  |          事件流           |  callback  |
| 超时     |  可配置（默认 2min）   |           可配置           |     `timeout_ms` 参数     |  固定 30s  |
| 平台处理 | Bash + 独立 PowerShell |    Bash/Zsh/PowerShell     |  Bash/Zsh + ZshFork 优化  | 统一 shell |
| 工作目录 |        cwd 维持        |      `dir_path` 参数       |      `workdir` 参数       |  cwd 维持  |

> **Codex 的数组格式**更安全——`["git", "commit", "-m", "msg"]` 避免了 shell 注入问题，不需要复杂的命令解析。

### 安全分析

| 维度          |         Claude Code         |               Gemini CLI                |               Codex CLI                |      x-code-cli      |
| ------------- | :-------------------------: | :-------------------------------------: | :------------------------------------: | :------------------: |
| 分析方法      | **AST 解析** (shell parser) |         tree-sitter + 命令解析          |    `is_known_safe_command()` 白名单    |     **正则匹配**     |
| 沙箱          |   文件系统+网络白/黑名单    | `SandboxManager` + `SandboxPermissions` | **Landlock** (Linux) + Windows Sandbox |        **无**        |
| 重定向检测    |          AST 级别           |           `hasRedirection()`            |            命令数组天然免疫            |          无          |
| 子 shell 检测 |          AST 级别           |                命令解析                 |            数组格式天然免疫            | **无（正则可绕过）** |
| 沙箱逃逸重试  |             无              |                   无                    |    Orchestrator 自动重试 + 权限提升    |          无          |

---

## 5. 搜索工具 (Grep / Glob)

| 特性       |             Claude Code              |                  Gemini CLI                  |           Codex CLI            |         x-code-cli          |
| ---------- | :----------------------------------: | :------------------------------------------: | :----------------------------: | :-------------------------: |
| Grep 后端  |     ripgrep (`@vscode/ripgrep`)      |       git grep / system grep / ripgrep       |          无内置 grep           | ripgrep (`@vscode/ripgrep`) |
| Glob 后端  |             自研 + fdir              |                `glob` npm 包                 | 无内置 glob（用 shell `find`） |          `globby`           |
| 输出模式   | content / files_with_matches / count |             匹配行 + names_only              |       N/A（通过 shell）        |         仅 content          |
| 分页       |       `head_limit` + `offset`        | `total_max_matches` + `max_matches_per_file` |              N/A               |           **无**            |
| 排序       |              mtime 排序              |                 recent-first                 |              N/A               |         mtime 排序          |
| 上下文行   |          `-A` / `-B` / `-C`          |                      有                      |              N/A               |             无              |
| 路径相对化 |    `toRelativePath()` 节省 token     |               `makeRelative()`               |              N/A               |        返回绝对路径         |
| Multiline  |       `-U --multiline-dotall`        |                      -                       |              N/A               |             无              |

> **Codex 没有内置搜索工具**——它依赖 shell 执行 `grep`/`find`/`rg` 等命令。这是有意的极简设计：只提供 shell + apply_patch 两个核心工具。

---

## 6. Web 工具

### 6.1 对比矩阵（含 OpenCode）

| 特性             |                     Claude Code                      |       Gemini CLI       | Codex CLI  |                   OpenCode                   |      x-code-cli (当前)       |
| ---------------- | :--------------------------------------------------: | :--------------------: | :--------: | :------------------------------------------: | :--------------------------: |
| **Web Search**   |        Anthropic 原生 server tool (beta 2025)        | Google Web Search API  | **无内置** |            Exa（经 MCP JSON-RPC）            |          Tavily API          |
| 成本             |              **$0.01 / 次**（用户付费）              |  计入 Gemini API 用量  |     —      |            Exa 账户付费（无免费）            | **Tavily 免费 1000 次 / 月** |
| 多 Provider 可用 |         ❌ 仅 Anthropic 原生/Vertex/Bedrock          |      ❌ 仅 Gemini      |     —      |                 ✅ 任意模型                  |         ✅ 任意模型          |
| 搜索入参         |         `query` + `allowed/blocked_domains`          |        `query`         |     —      | 5 参（livecrawl/type/contextMaxCharacters…） |   2 参（query/maxResults）   |
| 域名过滤         |              allowed / blocked domains               |           —            |     —      |                      —                       |              ❌              |
| 流式进度         |       Y（`query_update` + `results_received`）       |           —            |     —      |                   SSE 回传                   |              ❌              |
| 年份注入         |                          ❌                          |           —            |     —      |          ✅ (`current year is <y>`)          |    ✅（description 拼接）    |
| 强制引用         |                    markdown 链接                     |           —            |     —      |                      —                       |              ❌              |
| **Web Fetch**    |                   axios + turndown                   | 有 (URL + prompt 参数) | **无内置** |           turndown + HTMLRewriter            |      cheerio + turndown      |
| Fetch 大小上限   |                        10 MB                         |        约 2 MB         |     —      |                     5 MB                     | 100 KB（送回 model context） |
| Fetch 缓存       |               **15 min LRU**（50 MB）                |           —            |     —      |                      ❌                      | **15 min LRU**（50 条 Map）  |
| CF bot 对抗      |                          ❌                          |           —            |     —      |   ✅（检测 `cf-mitigated` 后降级 UA 重试）   |    ✅（同 OpenCode 做法）    |
| 预授权域名列表   |              ✅（~160 个常用文档站点）               |           —            |     —      |                      ❌                      |              ❌              |
| 域名预检         | `api.anthropic.com/api/web/domain_info` + 5 min 缓存 |           —            |     —      |                      ❌                      |              ❌              |
| Fetch 后处理     |         非预授权域名走 Haiku 抽取 + 版权保护         |        直接返回        |     —      |               turndown 后返回                |   cheerio 清洗后 turndown    |

### 6.2 搜索后端对比与"免费 + 高效"选型

用户核心诉求是 **"尽量免费 + 高效"**。对所有可用后端做个横向评估：

| 后端                 | 免费额度                     | 质量                         | 关键字段                                     | 难点/坑                         |
| -------------------- | ---------------------------- | ---------------------------- | -------------------------------------------- | ------------------------------- |
| **Tavily**           | 1000 次/月 (API key)         | ⭐⭐⭐⭐（LLM 优化，带摘要） | `search_depth` / `topic` / `include_domains` | 免费额度相对小，需注册          |
| **Brave Search API** | 2000 次/月 (免费套餐, 1 QPS) | ⭐⭐⭐⭐（独立索引）         | `q` / `freshness` / `safesearch`             | 免费套餐 QPS 限制               |
| **Google CSE**       | 100 次/天 (约 3000/月)       | ⭐⭐⭐⭐⭐                   | `q` / `cx` / `dateRestrict`                  | 需 CSE 配置, API 配额严格       |
| **SerpAPI / Serper** | 100 次/月（免费）            | ⭐⭐⭐⭐⭐（直接 SERP）      | 较丰富                                       | 免费额度少，超出即付费          |
| **Exa** (opencode)   | **无免费套餐**               | ⭐⭐⭐⭐⭐（LLM 原生）       | livecrawl/type/contextMax                    | 需付费                          |
| **Anthropic native** | **$0.01 / 次**               | ⭐⭐⭐⭐                     | domains                                      | 仅 Anthropic / Vertex / Bedrock |
| **DuckDuckGo 抓取**  | 真·免费，无需 key            | ⭐⭐                         | `q`                                          | 非官方，HTML 结构变动即失效     |
| **SearXNG 自托管**   | 免费（需自己部署）           | ⭐⭐⭐                       | 可配置                                       | 需运维成本                      |

**结论：Tavily 仍然是我们当前最优解，但应加一个 Brave fallback。**

理由：

1. **Claude Code 的做法（Anthropic native）无法抄**——它依赖 Anthropic 服务端 `web_search_20250305` beta tool + beta header，对 OpenAI/DeepSeek/Google 等模型全部 `isEnabled()=false`。我们是多 Provider CLI，复制这一路绑定 Anthropic = 自废武功，而且 $0.01/次 不是免费。
2. **OpenCode 的 Exa 方案无免费套餐**——MCP JSON-RPC 的工程复杂度我们也不必承担。
3. **Tavily 的 1000 次/月** 对个人开发者基本够用，质量也为 LLM 优化过（不是原始 SERP snippet，而是已清洗摘要），和 Claude Code/Exa 是同一档。
4. **Brave 2000 次/月免费** 是 Tavily 用尽后的自然补位，而且索引独立，偶发噪声不一样。Tavily 主 / Brave 备 的组合 ≈ 3000 次/月免费额度。
5. **DDG 抓取**只建议作为 zero-config 演示模式，不作为默认。

### 6.3 x-code-cli 当前状态

`web-search.ts` 已经是 **Tavily 优先 + Brave 兜底**的双 provider 实现(~110 行)；`web-fetch.ts` 在近期迭代后加了缓存和反爬降级（~150 行）。当前能力和剩余差距：

**webSearch（已做 / 待做）：**

- ✅ 工具描述注入当前年份，纠正模型按训练年份构造查询
- ✅ **双 provider**:`TAVILY_API_KEY` 优先(`@tavily/core` SDK),否则 `BRAVE_API_KEY`(直连 `api.search.brave.com`,无额外依赖)。两家都缺时返回按当前 shell 定制的配置引导,启动时也提示一次
- ❌ Tavily 已支持的 `search_depth` / `topic` / `include_domains` / `exclude_domains` 还没透传给模型
- ❌ 没有 allowed / blocked domains 过滤

**webFetch（已做 / 待做）：**

- ✅ **上限 100 KB**（~25 K tokens，约 Sonnet 上下文的 12%；从 30 KB 提上来；没做到 10 MB 因为 auto-executed tool 的返回会进 model context，10 MB 会直接炸）
- ✅ **50 条 / 15 分钟 LRU 缓存**（Map-based，没加依赖；命中即重新 insert 实现 MRU）
- ✅ **Cloudflare 降级**：响应 `403 + cf-mitigated` 时降级到 `x-code-cli/0.1` 简单 UA 重试一次
- ✅ 工具描述注入当前年份 + 声明"结果会缓存 15 分钟"
- ❌ 没有预授权域名列表（Claude Code 有 ~160 个热门文档站点白名单，走更宽松的 size limit + 跳过 CF 降级）

### 6.4 后续要抄的最优先做法

当前缺的都是锦上添花项。最有价值的下一步按 "影响 / 工作量" 排序：

1. **§12.4 webSearch 丰富入参**（~30 行）：把 Tavily SDK 已有的 `searchDepth` / `topic` / `timeRange` / `includeDomains` / `excludeDomains` 透传出去，零后端改动拿到更精准的检索控制
2. **§12.10 webFetch 预授权域名白名单**（~50 行）：React / Python / Rust / MDN / Stack Overflow 等站点直接走宽松路径，不用跑 CF 降级

> **§12.5 Brave 多后端 fallback 已完成** —— 见 `packages/core/src/tools/web-search.ts`。当前顺序 Tavily → Brave → 报错并引导配置;没有显式 `WEBSEARCH_PROVIDER` override 也没加 DDG 兜底(ToS 风险太大,不纳入)。

---

## 7. 权限与安全模型

### 审批模式

| 模式           | Claude Code | Gemini CLI | Codex CLI     | x-code-cli  |
| -------------- | ----------- | ---------- | ------------- | ----------- |
| 只读模式       | Plan mode   | PLAN mode  | -             | -           |
| 默认（需确认） | default     | DEFAULT    | UnlessTrusted | trust=false |
| 自动编辑       | -           | AUTO_EDIT  | OnRequest     | -           |
| 全自动（危险） | -           | YOLO       | Never         | trust=true  |

### 权限粒度

| 维度     |   Claude Code    |         Gemini CLI          |            Codex CLI            | x-code-cli |
| -------- | :--------------: | :-------------------------: | :-----------------------------: | :--------: |
| 工具级别 |        Y         |              Y              |                Y                |     Y      |
| 路径级别 | wildcard pattern | wildcard + argsPattern 正则 |        `.rules` 文件规则        |   **无**   |
| 命令级别 | classifier + AST |        命令前缀匹配         |       execpolicy 规则引擎       |  正则匹配  |
| 网络级别 |    白/黑名单     |          布尔开关           |   requirements.toml 网络规则    |   **无**   |
| 自学习   |     手动配置     |   **确认时自动生成规则**    | **审批缓存 + policy amendment** |   **无**   |

### 确认选项

| 选项               | Claude Code |      Gemini CLI      |      Codex CLI      | x-code-cli |
| ------------------ | :---------: | :------------------: | :-----------------: | :--------: |
| 允许一次           |      Y      |     ProceedOnce      |          Y          |     Y      |
| 始终允许 (session) |      -      |    ProceedAlways     |      Y (缓存)       |     -      |
| 始终允许 + 保存    |      -      | ProceedAlwaysAndSave | ExecPolicyAmendment |     -      |
| 按工具始终允许     |      -      |  ProceedAlwaysTool   |          -          |     -      |
| 按 MCP 服务器允许  |      -      | ProceedAlwaysServer  |          -          |     -      |
| 拒绝               |      Y      |        Cancel        |          Y          |     Y      |

---

## 8. 工具执行调度

| 维度     |       Claude Code        |                       Gemini CLI                       |                Codex CLI                |              x-code-cli              |
| -------- | :----------------------: | :----------------------------------------------------: | :-------------------------------------: | :----------------------------------: |
| 调度器   |  AI SDK + 手动 dispatch  |                    Scheduler 状态机                    |        ToolCallRuntime + Router         | AI SDK + `processToolCalls` for 循环 |
| 并发支持 | `isConcurrencySafe` 标记 |                     Scheduler 管理                     | **读写锁**（Read = 并行，Write = 独占） |             **顺序执行**             |
| 状态追踪 |        toolCallId        | Validating→Scheduled→Executing→Success/Error/Cancelled |           Turn-level tracking           |                  无                  |
| 取消支持 |     AbortController      |                      AbortSignal                       |            CancellationToken            |                **无**                |
| Hooks    |        前/后执行         |                `executeToolWithHooks()`                |         Pre/Post ToolUse hooks          |                **无**                |
| 投机执行 |     Y (speculation)      |                           -                            |                    -                    |                  -                   |
| 重试机制 |   API 级别 maxRetries    |                           -                            |     **沙箱拒绝 → 权限提升 → 重试**      |                  无                  |

> **Codex 的并行执行最精巧**：用 Rust 的 `RwLock` — 只读工具获取读锁（可并行），写工具获取写锁（独占），在语言层面保证安全。

---

## 9. 错误处理

| 维度             |  Claude Code   |                 Gemini CLI                  |                Codex CLI                 | x-code-cli |
| ---------------- | :------------: | :-----------------------------------------: | :--------------------------------------: | :--------: |
| 错误分类         |   通用字符串   |        **40+ 枚举** (ToolErrorType)         | 3 种 (RespondToModel / Fatal / Protocol) | 通用字符串 |
| Fatal 处理       | retryable 标记 |                  退出 CLI                   |                abort turn                |   无区分   |
| 给模型 vs 给用户 |      统一      |   **分离** (llmContent vs returnDisplay)    |         RespondToModel 面向模型          |    统一    |
| 建议修复         |   部分工具有   | 详细修复建议 (如 "use read_file to verify") |              模型错误字符串              |     无     |

**Gemini 的 ToolErrorType 枚举 (部分)**：

```typescript
EDIT_NO_OCCURRENCE_FOUND // 找不到匹配
EDIT_EXPECTED_OCCURRENCE_MISMATCH // 匹配数不对
EDIT_NO_CHANGE // old == new
EDIT_NO_CHANGE_LLM_JUDGEMENT // LLM 判定无变化
FILE_NOT_FOUND // 文件不存在
FILE_TOO_LARGE // 文件太大
PATH_NOT_IN_WORKSPACE // 路径越界
SANDBOX_EXPANSION_REQUIRED // 需要扩展沙箱
NO_SPACE_LEFT // 磁盘满 (Fatal)
```

---

## 10. 结果处理与截断

| 维度       |              Claude Code               |                  Gemini CLI                  |         Codex CLI         |     x-code-cli      |
| ---------- | :------------------------------------: | :------------------------------------------: | :-----------------------: | :-----------------: |
| 截断策略   | 保留头尾 (per-tool maxResultSizeChars) | **LLM 压缩** (ToolOutputDistillationService) |  保留头尾 + 大输出存文件  | 保留头尾 (统一 30K) |
| 按工具限制 |   Y (Grep 20K, Glob 100K, Edit 100K)   |                      有                      |          可配置           | **无（统一 30K）**  |
| 路径相对化 |           `toRelativePath()`           |      `makeRelative()` / `shortenPath()`      |             -             |       **无**        |
| 大输出处理 |                  截断                  |               截断 + LLM 摘要                | **存临时文件 + 返回引用** |        截断         |

> **Codex 的大输出处理**：当 shell 输出太大时，存到临时文件，返回文件路径引用而非内联内容 —— 避免污染上下文窗口。

---

## 11. 各产品独特功能

### 只有 Claude Code 有的

- **LSP 集成** — 编辑后通知 LSP 服务器 (didChange + didSave)
- **VSCode diff 视图** — `notifyVscodeFileUpdated()`
- **投机执行** (speculation) — 提前开始可能需要的操作
- **Deferred tools** — 延迟加载工具 schema 减少 prompt 大小
- **文件历史备份** (fileHistory) — 写前自动备份
- **Curly quote 规范化** — 自动处理弯引号 ↔ 直引号

### 只有 Gemini CLI 有的

- **Edit 4 层回退** — exact → flexible → regex → fuzzy
- **LLM 自修正** — `FixLLMEditWithInstruction` 用 LLM 修复失败编辑
- **省略占位检测** — `detectOmissionPlaceholders()` 检测 `// ...` 偷懒
- **权限自动规则** — 确认时自动生成 argsPattern 匹配规则
- **工具输出 LLM 压缩** — `ToolOutputDistillationService`
- **动态沙箱扩展** — `additional_permissions` 参数
- **JIT Context** — 文件操作时自动发现关联上下文
- **Discovered Tools** — 通过外部命令发现工具
- **SHA256 内容哈希** — 精确跟踪文件变化
- **MessageBus** — 异步确认解耦 UI 和工具执行

### 只有 Codex CLI 有的

- **Rust 实现** — 内存安全 + 高性能
- **Patch 格式编辑** — `apply_patch` 类 git diff 格式（非 old/new 替换）
- **数组命令格式** — `["git", "commit", "-m", "msg"]` 天然防注入
- **Landlock 沙箱** — Linux 内核级文件系统隔离
- **Orchestrator 重试** — 沙箱拒绝 → 自动请求权限提升 → 重试
- **读写锁并发** — `RwLock` 读并行/写独占
- **ExecPolicy 规则文件** — `.codex/.rules` 声明式执行策略
- **ZshFork** — macOS 下 Zsh fork 优化启动性能
- **Turn-level diff tracker** — 追踪每轮对话的文件变更

### 只有 x-code-cli 有的

- **最简代码量** — 11 工具 ~1500 行，最易理解和维护
- **AI SDK 原生** — 零框架成本，Vercel AI SDK 标准模式
- **多 Provider** — 天然支持 Anthropic/OpenAI/Google/DeepSeek 等 8 家 + 任意 OpenAI 兼容端点
- **saveKnowledge** — 内置知识持久化工具（带 4 类 category + 90 天 TTL）
- **Vision fallback 子 agent** — DeepSeek 等纯文本 provider 自动借用其他 provider 的视觉模型给图片打 caption（`agent/vision-fallback.ts`），Claude Code / Gemini / Codex 都没做
- **统一 thinking 开关** — `/thinking on|off` 把 8 家 provider 五花八门的 reasoning 参数收口成一个布尔值（`providers/thinking.ts`），用户不用关心每家的配置差异
- **Loop guard 圆形检测** — 滚动窗口 SHA-256 检测重复 tool call，3 次软阻断 / 5 次硬退出（`agent/loop-guard.ts`），doom-loop 不再爆 token
- **Light compaction** — proactive 压缩前 O(n) 扫一遍删掉重复的 tool-call/result 对（`agent/light-compact.ts`），能不调 LLM 就不调

---

## 12. 优化路线图

### P0 — 必做（直接影响核心体验）

#### 12.1 Edit 工具 flexible 匹配

> 借鉴：Gemini CLI

当前 edit 只支持精确匹配。模型输出的缩进稍有差异就会失败。

**实现方案**：在精确匹配失败后，按行 trim 后再比较：

```typescript
// 现有：精确匹配
if (content.includes(oldString)) { ... }

// 新增：flexible 匹配（忽略缩进差异）
const contentLines = content.split('\n').map(l => l.trim())
const searchLines = oldString.split('\n').map(l => l.trim())
// 滑动窗口匹配 → 找到后保留原始缩进
```

预估工作量：~100 行

#### 12.2 先读后写检查 (readFileState)

> 借鉴：Claude Code + Gemini CLI

当前模型可以不读文件就直接编辑，容易产生错误编辑。

**实现方案**：

- 在 readFile 执行后记录 `{ path, timestamp, content }`
- edit/writeFile 执行前检查该文件是否已被读取
- 如果文件在读取后被外部修改（mtime 变化），拒绝编辑

预估工作量：~80 行

#### 12.3 Shell 后台执行

> 借鉴：Gemini CLI + Codex CLI

当前 shell 只支持前台同步执行，超时 30s。长时间运行的命令（如 `npm install`、`cargo build`）容易超时。

**实现方案**：

- 新增 `isBackground` 参数
- 后台命令返回 PID + 初始输出
- 超时时间改为可配置

预估工作量：~150 行

---

### P1 — 应做（显著提升质量）

#### 12.4 webSearch 丰富入参 + 域名过滤

> 借鉴：Claude Code (`allowed_domains` / `blocked_domains`) + Tavily SDK 已支持字段

Tavily SDK 本身就支持 `searchDepth`（basic/advanced）、`topic`（general/news/finance）、`includeDomains`、`excludeDomains`、`timeRange` 等字段，我们当前全部没透传给模型。

**实现方案**：

```typescript
inputSchema: z.object({
  query: z.string().describe('The search query'),
  maxResults: z.number().optional().describe('Max results (default: 5)'),
  searchDepth: z.enum(['basic', 'advanced']).optional()
    .describe('basic = fast/cheap, advanced = thorough (use for research)'),
  topic: z.enum(['general', 'news', 'finance']).optional(),
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional()
    .describe('Restrict results to this time window'),
  includeDomains: z.array(z.string()).optional()
    .describe('Only return results from these domains'),
  excludeDomains: z.array(z.string()).optional(),
}),
```

预估工作量：~30 行

#### 12.5 webSearch 多后端 + Brave fallback ✅ 已完成

> 借鉴：独立调研（无单一竞品完整实现）

**实现**(`packages/core/src/tools/web-search.ts`,~110 行):

- 仅内置 Tavily + Brave 两家,不引入 DDG(抓取方案 ToS 风险大,被封概率高)
- 选择顺序固定:`TAVILY_API_KEY` → `BRAVE_API_KEY` → 返回友好错误
- 两家 provider 返回结构统一为 `{ title, url, content }`,输出格式完全一致
- Brave 直连 `api.search.brave.com/res/v1/web/search`(header `X-Subscription-Token`),不引入 SDK 依赖
- 缺失双 key 时,`buildMissingKeyError()` 按当前 shell 返回 PowerShell / bash / zsh / fish / cmd 的配置命令;CLI 启动时 `printNoWebSearchKeyHint()` 也提示一次
- 没有加 `WEBSEARCH_PROVIDER` 显式 override —— 实际用不到,两个 key 按顺序探测就够了

实际工作量:~110 行(比原估 200 行少,因为去掉了 DDG 和 provider override)

#### 12.6 结构化错误类型

> 借鉴：Gemini CLI

当前所有错误都是 `"Error: ..."` 字符串。模型无法根据错误类型做不同处理。

**实现方案**：

```typescript
enum ToolErrorType {
  FILE_NOT_FOUND = 'file_not_found',
  EDIT_NO_MATCH = 'edit_no_match',
  EDIT_MULTIPLE_MATCHES = 'edit_multiple_matches',
  PERMISSION_DENIED = 'permission_denied',
  SHELL_TIMEOUT = 'shell_timeout',
  // ...
}
```

并在返回给模型的消息中包含修复建议。

预估工作量：~100 行

#### 12.7 结果分离 (llmContent vs displayContent)

> 借鉴：Gemini CLI

当前工具返回统一字符串，给模型和给用户看的是同一内容。

**实现方案**：

```typescript
interface ToolResult {
  llmContent: string // 给模型看（详细、包含修复建议）
  displayContent: string // 给用户看（简洁）
  error?: { type: ToolErrorType; message: string }
}
```

预估工作量：~120 行（需修改所有工具返回值 + callback）

#### 12.8 Grep 分页支持

> 借鉴：Claude Code

当前 grep 只返回前 50 个结果，无法翻页。大项目搜索可能丢失结果。

**实现方案**：

- 新增 `offset` 参数
- 新增 `outputMode`: `content` / `files_with_matches` / `count`
- 结果路径相对化（节省 token）

预估工作量：~80 行

#### 12.9 AbortController 传播

> 借鉴：Claude Code + Gemini CLI + Codex CLI

当前无法取消正在执行的工具（特别是长时间运行的 shell 命令）。

**实现方案**：

- 所有工具 execute 函数接收 `signal: AbortSignal`
- shell 执行时将 signal 连接到子进程
- grep/glob 支持 signal 中断

预估工作量：~100 行

---

### P2 — 可做（锦上添花）

#### 12.10 webFetch 预授权域名列表

> 借鉴：Claude Code (`WebFetchTool/preapproved.ts` 约 160 个域名)

Claude Code 维护了一个常用技术文档的白名单（MDN / React / Python docs / MDN / GitHub / Stack Overflow / Rust book / TensorFlow 等 ~160 条），白名单内的站点直接返回 markdown，白名单外的则走 Haiku 摘要 + 版权合规。

对我们来说 Haiku 步骤可以不抄（我们不想绑定 Anthropic），但白名单本身是有价值的：

- 预授权站点可以走更宽松的 size limit（如 5 MB）
- 可以跳过 Cloudflare 降级逻辑（这些站点不会 bot 拦截我们）
- 未来加权限系统时，白名单可以默认 always-allow

**实现方案**：`packages/core/src/tools/web-fetch-preapproved.ts` 导出一个 `Set<string>`，fetch 入口处检查 `new URL(url).hostname`。

预估工作量：~50 行 + 域名清单整理

#### 12.11 Edit fuzzy 匹配 (Levenshtein)

> 借鉴：Gemini CLI

在 flexible 匹配也失败后，用 Levenshtein 距离做模糊匹配（10% 容差）。

预估工作量：~80 行 + `fast-levenshtein` 依赖

#### 12.12 Shell 安全性提升

> 借鉴：Claude Code (AST) + Codex (数组格式)

当前正则匹配可被 `$(rm -rf /)` 等子 shell 绕过。

**方案 A**（简单）：至少检测 `$(...)` 和反引号
**方案 B**（中等）：用 tree-sitter 解析 shell AST
**方案 C**（最安全）：增加数组格式命令支持

预估工作量：方案 A ~50 行 / 方案 B ~300 行

#### 12.13 权限确认自动规则

> 借鉴：Gemini CLI + Codex CLI

用户选 "Always Allow" 后，自动根据当前命令生成匹配规则，下次类似操作自动放行。

预估工作量：~100 行

#### 12.14 省略占位检测

> 借鉴：Gemini CLI

检测模型是否在 edit 的 new_string 中输出了 `// ...existing code...`、`// TODO`、`/* ... */` 等偷懒占位符。

预估工作量：~40 行

#### 12.15 工具输出路径相对化

> 借鉴：Claude Code + Gemini CLI

当前 grep/glob 返回绝对路径，浪费 token。改为相对于 cwd 的路径。

预估工作量：~20 行

---

### P3 — 远期（架构升级）

#### 12.16 工具定义重构

> 借鉴：Claude Code buildTool / Gemini Builder+Invocation

将当前 `tool()` + `processToolCalls()` 大函数重构为更结构化的模式：

```typescript
interface ToolDef<TInput, TOutput> {
  name: string
  inputSchema: ZodSchema<TInput>
  validateInput?(input: TInput): ValidationResult
  getPermissionLevel(input: TInput): PermissionLevel
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>
  formatResult(output: TOutput): ToolResult
}
```

这样每个工具自包含，loop.ts 只做调度。

#### 12.17 沙箱支持

> 借鉴：Codex CLI (Landlock) + Gemini CLI (SandboxManager)

为 shell 工具添加文件系统沙箱，限制写入范围。

#### 12.18 并行工具执行

> 借鉴：Codex CLI (RwLock) + Claude Code (isConcurrencySafe)

当前 `processToolCalls` 是顺序 for 循环。对于多个只读工具（grep, glob, readFile），可以并行执行。

---

## 附录：四产品工具清单

### Claude Code (~40 tools)

`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Agent`, `AskUser`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `TodoWrite`, `NotebookEdit`, `LSP`, `MCPTool`, `ListMcpResources`, `ReadMcpResource`, `McpAuth`, `ToolSearch`, `SendMessage`, `Config`, `Brief`, `REPL`, `PowerShell`, `TaskCreate/Get/List/Stop/Update/Output`, `RemoteTrigger`, `ScheduleCron`, `Skill`, `Sleep`, `TeamCreate/Delete`, `WebSearch`

### Gemini CLI (~25 tools)

`read_file`, `write_file`, `replace` (edit), `run_shell_command`, `glob`, `grep_search`, `list_directory`, `google_web_search`, `web_fetch`, `read_many_files`, `save_memory`, `get_internal_docs`, `ask_user`, `write_todos`, `activate_skill`, `tracker_create/update/get/list`, `enter_plan_mode`, `exit_plan_mode`, `update_topic`, MCP tools

### Codex CLI (~20 tools)

`shell` (array), `shell_command` (string), `exec_command`, `write_stdin`, `apply_patch`, `request_permissions`, `spawn_agent` (v1/v2), `wait_agent`, `close_agent`, `send_message`, `send_input`, `agent_jobs`, `tool_search`, `tool_suggest`, `list_dir`, `view_image`, `js_repl`, `js_repl_reset`, `code_mode_execute/wait`, MCP tools, Dynamic tools

### x-code-cli (11 tools)

`readFile`, `writeFile`, `edit`, `shell`, `glob`, `grep`, `listDir`, `webSearch`, `webFetch`, `askUser`, `saveKnowledge`

> Plan-mode（`enterPlanMode` / `exitPlanMode`）已在 v0.1.4 移除（commit `1ed61ae`）。原因：实际使用中模型对"该不该 plan"的判断不稳定，强制 plan 反而拖慢简单任务，移除后由用户自主决定（"先帮我看看代码再说"vs"直接动手"）效果更好。

---

## 附录：关键源码路径

| 项目        | 工具定义                   | Agent Loop                                | 权限系统                           |
| ----------- | -------------------------- | ----------------------------------------- | ---------------------------------- |
| Claude Code | `src/tools/*/`             | `src/services/tools/toolExecution.ts`     | `src/utils/permissions/`           |
| Gemini CLI  | `packages/core/src/tools/` | `packages/core/src/scheduler/`            | `packages/core/src/policy/`        |
| Codex CLI   | `codex-rs/tools/src/`      | `codex-rs/core/src/tools/orchestrator.rs` | `codex-rs/core/src/exec_policy.rs` |
| x-code-cli  | `packages/core/src/tools/` | `packages/core/src/agent/loop.ts`         | `packages/core/src/permissions/`   |
