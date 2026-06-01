# 写自己的插件

插件就是一个带 manifest 的目录。本文是 schema 与 layout 约定的参考——如果你只是想用别人的插件，看 [plugins.md](./plugins.md) 就够了。

英文版：[plugin-authoring.en.md](./plugin-authoring.en.md)

---

## 最小可用插件

能加载的最简结构：

```
my-plugin/
└── .x-code-plugin/
    └── plugin.json
```

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
}
```

安装（在 `my-plugin` 父目录里执行）：

```bash
xc plugin install ./my-plugin
```

`/plugin info` 会显示 "no contributions" warning——正常。下面加贡献让它真正有用。

---

## Manifest 路径探测顺序

1. `.x-code-plugin/plugin.json` ← 新插件首选
2. `.claude-plugin/plugin.json` ← Claude Code 兼容
3. `plugin.json` ← 也接受

只有 `gemini-extension.json` 存在时安装被拒（与 Gemini 不兼容，详见 [plugins.md § 兼容性](./plugins.md)）。

---

## Manifest 字段参考

只有 `name` 和 `version` 必需。未知顶层字段静默 drop——所以 Claude Code 插件带 `output-styles` 或 `lspServers` 也能正常安装，那些字段不激活而已。

```jsonc
{
  // schema 版本，今天恒为 "1"。未来 breaking change 会 bump 这个值。
  // 缺失则默认 "1"。
  "schemaVersion": "1",

  // ── 身份 ────────────────────────────────────────────────────
  "name": "linear", // [a-z0-9][a-z0-9-]* — 用作跨平台
  // 文件系统安全路径片段
  "version": "1.2.0", // semver 字符串，不强制

  "description": "Linear issue 集成",
  "author": {
    // 也接受 "Name" 字符串形式
    "name": "Anthropic",
    "email": "support@anthropic.com",
    "url": "https://anthropic.com",
  },
  "keywords": ["productivity", "issue-tracker"],
  "homepage": "https://github.com/anthropics/linear-plugin",
  "license": "MIT",

  // ── 贡献（路径相对插件根） ──────────────────────────────────
  //
  // 下面每个 <thing> 字段指向一个目录，或者标注的情况下也接受文件路径
  // 或 inline 对象。全部可选。

  "skills": "./skills", // <name>/SKILL.md 子目录的目录
  "agents": "./agents", // <name>.md 文件的目录
  "commands": "./commands", // 目录里每个 .md 文件成为一个 /<name> slash 命令
  // 支持 $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT} 等替换变量

  // mcpServers: 既可以是路径，指向形如
  // `{ "mcpServers": { ... } }` 的 JSON 文件（同 ~/.x-code/config.json），
  // 也可以直接 inline。以下是 inline 形式：
  "mcpServers": {
    "linear": {
      "command": "node",
      "args": ["${pluginDir}/server.js"],
      "env": { "LINEAR_API_KEY": "${env:LINEAR_API_KEY}" },
    },
  },

  // hooks: 路径指向 hooks.json，或者直接 inline。详见 docs/hooks.md
  // 10 个事件：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
  // PreCompact / PostCompact / SubagentStart / SubagentStop / TurnComplete /
  // SessionEnd
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "writeFile|edit",
        "command": "node ${pluginDir}/hooks/lint.js",
        // 跨平台命令：Windows / macOS / Linux 任一需要特殊语法时单独覆盖
        "commandWindows": "node \"${pluginDir}/hooks/lint.js\"",
        "timeout": 5000,
      },
    ],
  },

  // ── 用户提供的配置项（装时逐项询问 + 注入 hook/MCP env） ─────────
  "userConfig": [
    {
      "key": "LINEAR_API_KEY",
      "type": "string",
      "sensitive": true, // 输入时不回显（git 风格密码）；当前 v1 仍存 0600 文件
      // 未来 followup PR 接 keytar 走系统 keyring
      "prompt": "输入你的 Linear API key",
      "required": true,
    },
  ],
  // 装时（`xc plugin install <src>`，非 `--yes`）CLI 逐项问值并写入
  // ~/.x-code/plugins/user-config.json（0600）。运行时这些值自动注入到 hook
  // 子进程和 plugin 贡献的 MCP server 的 env，key 名就是 `key` 字段。
  // 注意：slash 形式 `/plugin install` 永远以 --yes 模式运行，不弹此 prompt
  // ——带 userConfig 的插件请用命令行版安装，详见 plugins.md 的 slash 限制章节。

  // ── 依赖与运行时兼容性 ──────────────────────────────────────
  "dependencies": ["base-skills@anthropic-marketplace"],
  "engines": { "x-code": ">=0.5.0" },
}
```

### 字段细节

- **`name`** — 小写字母、数字、短横线。必须字母或数字开头。Claude Code / Codex 同规则。
- **`skills`** / **`agents`** / **`commands`** — 指向各自目录。**绝大多数 Claude Code 插件 manifest 不写这三个字段**——loader 会自动探测 `skills/` / `agents/` / `commands/` 子目录（约定优先）。只在你想用非常规路径时声明。`commands/` 里每个 `.md` 文件成为 `/<name>` slash 命令，body 是 prompt 模板，支持 `$ARGUMENTS` 与 `${CLAUDE_PLUGIN_ROOT}` 替换。同名命令同时也能从 `~/.x-code/commands/<name>.md`（用户级）和 `<repo>/.x-code/commands/<name>.md`（项目级）加载，优先级 **project > plugin > user**（参见 README 的「自定义斜杠命令」）。
- **`mcpServers`** — 路径或 inline 对象。不声明时自动探测 `.mcp.json`（Claude Code 约定）或 `mcp.json`。每个 server 的 schema 同 `~/.x-code/config.json`，变量展开（`${pluginDir}`、`${env:NAME}` 等）在 server 启动时进行。
- **`hooks`** — 路径或 inline 对象。不声明时自动探测 `hooks/hooks.json`。详见 [hooks.md](./hooks.md)。

---

## 典型目录布局

```
my-plugin/
├── .x-code-plugin/
│   └── plugin.json
├── skills/
│   └── search/
│       ├── SKILL.md            # YAML frontmatter + body
│       └── references/         # bundled 文件，激活时一并通知 agent
│           └── api.md
├── agents/
│   └── triage.md               # sub-agent 定义
├── commands/                   # 每个 .md = 一个 /<name> slash 命令
│   └── linear.md
├── mcp.json                    # 如果把 mcpServers 拆到独立文件
├── hooks/
│   ├── hooks.json              # 如果把 hooks 拆到独立文件
│   ├── lint.js
│   └── audit.sh
├── README.md
└── LICENSE
```

不必严格按这个布局——`skills` / `agents` / `commands` / `mcpServers` / `hooks` 字段每个都可以指任意相对路径。跟着约定走只是让别人读起来更顺。

---

## 本地迭代流程

1. 写 manifest 和贡献内容
2. `xc plugin install ./my-plugin`——拷贝到 `~/.x-code/plugins/cache/local/<name>/<version>/` 并登记
3. 重启 `xc` 让贡献生效
4. 改 + 再装。同版本重装会覆盖缓存（支持同版本重装）；要并存多个版本就 bump 一下 manifest version

更紧的循环可以直接编辑 cache 目录里的文件——重启 xc 仍能看到改动。但不要把这个当开发流程：定期 reinstall 一下让你的源目录保持权威。

---

## 测试插件

仓库现有测试 fixture 展示了测试插件的形态——见
`packages/core/tests/plugins-install-load.test.ts`，里面有从临时目录装插件并断言 loader 加载贡献的例子。

集成边界（plugin → existing loaders）在 `packages/core/src/plugins/integration.ts`。如果插件的 MCP / hook 配置有解析错误，它会进 `/plugin doctor` 而不是炸 CLI——你的测试也应该覆盖那条路径。

---

## 常见坑

| 坑                          | 处理                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name` 报 regex 错          | 只能用小写字母、数字、短横线。不能有下划线和大写                                                                                                                                                 |
| Hook 不触发                 | 装完跑 `/plugin refresh`（in-session 热加载，无需重启），或重启 `xc`。验证：`xc --plugin-debug` 后看 `hooks.exec-ran` 日志条目                                                                   |
| `${pluginDir}` 没展开       | 只在 hook command 和 slash command 模板里展开。MCP server 的 args / env 走 MCP 自己的 `${VAR}` 展开（仅 env 变量，见 `packages/core/src/mcp/expand-env.ts`）                                     |
| `${pluginDataDir}` 写入失败 | 自动创建在 `~/.x-code/plugins/data/<sanitised-plugin-id>/`，跨版本保留。第一次替换时 `mkdir -p`，权限错误会让 shell 报错。**别**把可持久化数据写到 `${pluginDir}` —— 它会在重装/升级时整个被擦掉 |
| 插件装上了贡献不出现        | `/plugin info <id>` 确认 manifest 解析成功，且贡献路径在磁盘上存在                                                                                                                               |
| 想公开发布                  | 发一个 marketplace.json 列你的插件 git URL，告诉用户 `xc plugin marketplace add <name> <source>`。见 [marketplace.md](./marketplace.md)                                                          |
