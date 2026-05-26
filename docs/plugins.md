# 插件 — 使用指南

**插件**是可分发的功能包：把 skills / sub-agents / MCP 服务器 / hooks 打包成一个安装单元，第三方可以编写并分发，用户一行命令安装。

英文版：[plugins.en.md](./plugins.en.md) · 相关：[hooks.md](./hooks.md) · [marketplace.md](./marketplace.md) · 自己写插件见 [plugin-authoring.md](./plugin-authoring.md)

---

## TL;DR

```bash
# 从订阅的 marketplace 安装
xc plugin install linear@anthropic-marketplace

# 从 GitHub 仓库安装
xc plugin install github:owner/repo

# 从本地路径安装（适合插件开发迭代）
xc plugin install ./my-plugin

# 列出已安装
xc plugin list

# 卸载
xc plugin uninstall linear@anthropic-marketplace
```

**在交互式 CLI 里**做完安装/卸载/启用/禁用，跑 `/plugin refresh` 让贡献的 skill / agent / 命令 / hooks / MCP server 全部立即生效（无需重启）。MCP server 重连会触发一次 prompt-cache miss，跟 `/mcp refresh` 同代价；如果只是想单独刷 MCP 配置（没动插件），用 `/mcp refresh` 即可。

---

## 两种使用方式

| 操作             | 交互内 slash 命令              | 命令行                               |
| ---------------- | ------------------------------ | ------------------------------------ |
| 列出插件         | `/plugin list`                 | `xc plugin list`                     |
| 看插件详情       | `/plugin info <id>`            | `xc plugin info <id>`                |
| 安装             | `/plugin install <source>`     | `xc plugin install [--yes] <source>` |
| 卸载             | `/plugin uninstall <id>`       | `xc plugin uninstall <id>`           |
| 启用 / 禁用      | `/plugin enable\|disable <id>` | `xc plugin enable\|disable <id>`     |
| 搜索 marketplace | `/plugin search <keyword>`     | `xc plugin search <keyword>`         |
| 升级             | `/plugin update <id\|--all>`   | `xc plugin update <id\|--all>`       |
| 诊断             | `/plugin doctor`               | `xc plugin doctor`                   |
| 管理 marketplace | `/plugin marketplace …`        | `xc plugin marketplace …`            |

`xc plugin` 命令行形式适合脚本和 CI。`xc plugin install` 默认走 y/N consent 提示——加 `--yes` 跳过。

---

## 安装源的四种写法

| 形式                          | 示例                                      | 说明                                                                                       |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `<name>@<marketplace>`        | `linear@anthropic-marketplace`            | 在缓存的 marketplace 索引里查，按其声明的 source 下载。要求 marketplace 已订阅并已 refresh |
| `github:<owner>/<repo>[#ref]` | `github:foo/bar`、`github:foo/bar#v1.2.0` | 浅克隆 GitHub repo。ref 可选，分支或 tag                                                   |
| `https://…` 或 `git@…`        | `https://gitlab.example/foo/bar.git`      | 任意 git URL                                                                               |
| 文件路径                      | `./my-plugin`、`/abs/path/to/plugin`      | 适合插件开发者本地迭代                                                                     |

后三种安装的插件归到 `local` marketplace。`/plugin list` 会按 marketplace 标注来源。

---

## 安装时的 consent 提示

`xc plugin install` 在真正落盘前会显示预览：

```
About to install: linear@anthropic-marketplace v1.2.0
  Linear issue integration

  Source:      github:anthropics/linear-plugin
  Marketplace: anthropic-marketplace [reserved/official] [verified]
  Author:      Anthropic
  License:     MIT

  Will contribute:
    - skills (added to /skill list)
    - MCP servers (will be spawned as subprocesses): linear
    - Lifecycle hooks (will run shell commands on: PostToolUse)

Proceed with install? [y/N]
```

预览中**红色**的两项——MCP 服务器和 lifecycle hooks——是关键的信任决策：两者都会在你的机器上跑代码。来自不熟悉 marketplace 的插件，按 `y` 前先看一眼源码。

非 TTY 环境（CI、脚本管道）下默认拒绝；显式跳过：

```bash
xc plugin install --yes linear@anthropic-marketplace
```

### Slash 命令 `/plugin install` 的限制

`/plugin install` **永远以 `--yes` 模式运行**——交互内打命令本身视为同意。具体说，它**不弹**：

- **consent 预览**：装之前看不到 plugin 会贡献什么（commands / agents / MCP / hooks）
- **userConfig prompt**：带 `userConfig` 字段的插件装上去后值是空的，hook 子进程拿到的 env 全是 `<unset>`

**如果插件有 userConfig，或者你想看 consent 预览，请用命令行版**：

```bash
# 在另一个终端跑（不加 --yes，会逐项问值）
xc plugin install <source>
```

装完后回到交互式 CLI 跑 `/plugin refresh` 让新插件立即生效（无需重启）。

未来可能改成内联 modal 让 slash 也能弹 prompt，目前算已知限制。

---

## Scope（启用范围）

启用状态可写到两个 scope（与 skills、mcp 同约定）：

| Scope     | 路径                                | 说明                                     |
| --------- | ----------------------------------- | ---------------------------------------- |
| `user`    | `~/.x-code/settings.json`           | `xc plugin enable\|disable` 的默认 scope |
| `project` | `<cwd>/.x-code/settings.local.json` | per-user 在该 repo 的覆盖，gitignored    |

显式选定 scope 用 `--scope`：

```bash
# 仅在当前项目禁用某插件，不影响其他项目
xc plugin disable linear@anthropic-marketplace --scope=project
# 用户级启用（默认行为）
xc plugin enable linear@anthropic-marketplace --scope=user
```

`/plugin enable | disable` 在交互模式下接受同样的 flag。

文件格式：

```jsonc
{
  "enabledPlugins": {
    "linear@anthropic-marketplace": true,
    "k8s-debug@local": false,
  },
}
```

未列出的插件默认**启用**，显式禁用才生效。`project` 设置赢过 `user`。

---

## 文件系统布局

所有插件相关的东西都在 `~/.x-code/plugins/` 下：

```
~/.x-code/plugins/
├── known_marketplaces.json              # 订阅的 marketplace 列表
├── marketplaces/
│   └── anthropic-marketplace/
│       └── marketplace.json             # 缓存的 marketplace 索引
├── cache/
│   └── anthropic-marketplace/
│       └── linear/
│           └── 1.2.0/                   # 实际安装的插件内容
│               ├── .claude-plugin/plugin.json
│               ├── skills/
│               ├── mcp.json
│               └── hooks/hooks.json
├── data/
│   └── linear@anthropic-marketplace/    # 插件持久化数据，卸载也保留
└── installed_plugins.json               # 安装登记
```

`data/` 在卸载时不删，重装时插件能恢复之前的状态。

> **Windows 路径**：`~/.x-code` 在 Windows 上是 `%USERPROFILE%\.x-code`。

---

## 关掉整个插件系统

两个启动开关：

```bash
xc --no-plugins    # 完全跳过插件发现
xc --no-hooks      # 插件正常加载，但 hooks 全部不执行
```

`--no-plugins` 用于排查"是不是某个插件搞砸了"；`--no-hooks` 保留 skills / agents / MCP 但关掉所有 lifecycle 回调。

---

## 改动何时生效 + `/plugin refresh`

插件的贡献（skill / sub-agent / 命令 / hooks / MCP server）在 CLI 启动时合入对应的 registry。会话期间安装/卸载/启用/禁用之后，用 **`/plugin refresh`** 在当前会话一次性重新加载所有内容，无需重启：

```text
> /plugin refresh
Reloaded plugins — added: my-new-plugin@local; unchanged: linear@anthropic-marketplace, code-review@anthropic-marketplace.
Downstream: 3 skill change(s), 1 command change(s).
MCP — added: my-new-mcp-server.
Note: next message rebuilds the system prompt, so prompt-cache will miss once.
```

刷新过程：

1. 重扫已安装插件 + 解析 manifest
2. 重建 PluginRegistry（保留对象身份，所有 captured ref 仍然有效）
3. 把新的 skill / sub-agent / 命令 / hook 折回各自的 registry
4. 重读用户级 + 项目级 MCP 配置，跟新插件贡献的 MCP server 合并后调 `McpRegistry.restartAll(...)`——跟 `/mcp refresh` 走同一条 restart 路径
5. 失效 `systemPromptCache` —— 下一条消息会重建系统 prompt（cache miss 一次，正常）

`/mcp refresh` 仍然独立可用：只想刷新 MCP 配置（没动插件）时跑它即可，会带上当前插件的 MCP 贡献一起重连，不会因此丢失它们。

`/plugin list` 与 `/plugin info` 始终展示当前真正在跑的状态。

---

## 升级插件 `update`

```bash
# 升一个
xc plugin update linear@anthropic-marketplace

# 升全部已装
xc plugin update --all
```

`--all` 顺序跑、单条失败不影响其它（skip-on-error），结束打印汇总：`Summary: N updated, M unchanged, K failed.`。**裸跑 `xc plugin update` 会被拒**——必须显式 `<id>` 或 `--all`，避免误操作把所有插件重克隆一遍（行业惯例同 Gemini CLI 的 `extensions update --all`）。

slash 形式 `/plugin update <id|--all>` 同语义。升完跑 `/plugin refresh` 把新版本的 skill / agent / 命令 / hooks 折回 registry。

---

## userConfig：装时问值

插件 manifest 可以声明它需要哪些用户提供的配置（API key、账号 ID、URL 等）：

```jsonc
{
  "userConfig": [
    {
      "key": "LINEAR_API_KEY",
      "type": "string",
      "sensitive": true,
      "prompt": "Enter your Linear API key",
      "required": true,
    },
    { "key": "BASE_URL", "type": "string", "default": "https://api.example.com" },
  ],
}
```

装这个插件时（**非** `--yes` 模式），CLI 会按顺序逐项问值；`sensitive: true` 的字段输入时不回显（git 风格的密码输入）。

值存到 `~/.x-code/plugins/user-config.json`，文件权限 `0600`（仅本用户可读）。Hook 跑的时候、plugin-contributed MCP server 启动的时候，这些值会自动注入到子进程 `env`，key 名就是 manifest 里的 `key` 字段。所以 hook 脚本里直接 `process.env.LINEAR_API_KEY` 就能用，无需额外胶水。

⚠️ 当前 v1：`sensitive: true` 只控制**输入时的回显**，存储是 `0600` 文件不是系统 keychain。真正的 keychain 集成（macOS Keychain / Windows Credential Manager / Linux libsecret）规划在 followup。Windows 上 `0600` 实际是 no-op，注意场景。

`--yes` 安装跳过 prompt，user-config 留空。需要 CI 装的话，提前手写 `~/.x-code/plugins/user-config.json` 即可。**`/plugin install` slash 命令也跳过**（等同 `--yes`），所以 userConfig 类插件请用 `xc plugin install` 命令行版安装——详见上文"Slash 命令 `/plugin install` 的限制"。

## `--plugin-debug` 排查

要看插件加载 / hook 执行 / marketplace fetch 的实时细节：

```bash
xc --plugin-debug
# 等价于
XC_PLUGIN_DEBUG=1 xc
```

把 `plugins.` / `plugin.` / `hooks.` / `marketplace.` 标签的 debug 行实时镜像到 stderr，不需要 `DEBUG_STDOUT=1`（那个会把所有 debug 都喷出来）。装/卸/启用插件后看不到预期效果时用这个。

## 故障排查

| 症状                            | 先试                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------- |
| 安装后插件不出现                | 跑 `/plugin refresh`（在交互内）或重启 `xc`。贡献绑定在 registry 上          |
| `/plugin doctor` 报 load errors | 看它打印的路径——通常是 manifest 拼写错                                       |
| 插件的 MCP 服务连不上           | `/mcp list`——插件提供的 server 也会列在那里                                  |
| Hook 触发意外                   | `DEBUG_STDOUT=1` 重启 → `tail ~/.x-code/logs/debug.log` 搜 `hooks.`          |
| 怀疑某插件搞砸                  | `xc --no-plugins` 启动；若问题消失就用 `/plugin disable <id>` + refresh 排查 |
| Hook 跑得慢 / 卡住              | `xc --no-hooks` 启动；每个 hook 默认 5s 超时                                 |

---

## 与 Claude Code / Codex 插件的兼容性

x-code 故意同时识别 `.claude-plugin/plugin.json` 和原生的 `.x-code-plugin/plugin.json`。Claude Code 写的插件原样安装在 x-code 里——skills、agents、MCP servers、hooks 全部按一样的方式接入。两个 Claude Code 独有字段（`output-styles`、`lspServers`）会被静默忽略。

Gemini extension（`gemini-extension.json`）**不支持**——安装时会报错并指向本文档。

---

## 写自己的插件

见 [plugin-authoring.md](./plugin-authoring.md)，里面有完整 manifest schema、目录约定、本地迭代流程。
