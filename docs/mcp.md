# MCP（Model Context Protocol）— 使用指南

X-Code CLI 内置 MCP 客户端，可以把任意符合 MCP 协议的服务器接入 agent——它们提供的工具会自动并入 agent 工具集，agent 可以像调用内置工具一样调用它们。

支持 **stdio**（本地子进程）和 **streamable HTTP**（远端，含 OAuth）两种传输。

英文版：[mcp.en.md](./mcp.en.md)

---

## TL;DR

在 `~/.x-code/config.json` 加 `mcpServers` 字段（文件不存在就新建），然后重启 `xc`：

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed-dir"],
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
    },
  },
}
```

启动后用 `/mcp list` 查看连接状态，`/mcp tools` 查看可用工具。

---

## 配置文件位置

| Scope | 路径                         | 何时用                                     |
| ----- | ---------------------------- | ------------------------------------------ |
| 用户  | `~/.x-code/config.json`      | 个人通用 MCP 服务（filesystem、github 等） |
| 项目  | `<repo>/.x-code/config.json` | 仅此项目的 MCP 服务（公司内部 server 等）  |

两个 scope 合并：项目级覆盖同名用户级。**项目级配置首次出现时弹"是否信任"对话框**（同 Claude Code 的安全模型），用户拒绝则跳过项目级。信任决定持久化到 `~/.x-code/trusted-projects.json`。

> **Windows 路径**：`~/.x-code` 在 Windows 上是 `%USERPROFILE%\.x-code`，下文不再重复。

---

## mcpServers 配置 schema

### stdio（本地子进程）

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx", // 必需
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${env:WORK_DIR}"],
      "env": {
        // 可选：额外环境变量
        "DEBUG": "1",
      },
      "cwd": "/some/dir", // 可选：子进程工作目录
      "timeout": 30000, // 可选：首次连接超时（ms，默认 30000）
      "enabled": true, // 可选：false 跳过此服务器
    },
  },
}
```

### HTTP（远端，含可选 OAuth）

```jsonc
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/", // 必需
      "headers": {
        // 可选：静态请求头
        "X-Client": "x-code",
      },
      "timeout": 30000,
      "enabled": true,
    },
  },
}
```

**OAuth**：HTTP server 若需 OAuth 认证，首次连接返回 `needs_auth` 状态。用 `/mcp auth <name>` 触发完整 OAuth 流程——浏览器打开授权 URL，回调后 token 持久化到 `~/.x-code/mcp/tokens/<server>.json`。下次启动自动注入 `Authorization: Bearer ...` 头。

**不要把 token 手写到 `headers`** 里——OAuth 流程会自动处理。

### 环境变量展开

任何字段值里的 `${VAR}` 与 `${env:VAR}` 会被启动期展开成 `process.env.VAR`。变量不存在时报错并将该 server 标记为 `failed`（不影响其他 server）。

```jsonc
{
  "github": {
    "url": "${env:GITHUB_MCP_URL}",
    "headers": { "Authorization": "Bearer ${env:GITHUB_TOKEN}" },
  },
}
```

> **提示**：含密钥的字段强烈推荐用 `${env:...}`，把密钥放进 shell 启动文件而非提交到 git 的 config.json。

---

## `/mcp` 命令族

| 命令                   | 说明                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `/mcp list`            | 列出所有配置的 server + 当前状态（connected / disabled / needs_auth / failed） |
| `/mcp tools [server]`  | 列出可用工具；可选按 server 名过滤                                             |
| `/mcp add`             | 交互式添加一个 stdio / HTTP server 到用户或项目 config                         |
| `/mcp add-json`        | 从一段裸 JSON 添加一个 server（适合粘贴文档示例）                              |
| `/mcp remove`          | 从 config 移除 server                                                          |
| `/mcp auth <server>`   | 触发 HTTP server 的 OAuth 流程                                                 |
| `/mcp logout <server>` | 清除 server 的 OAuth token                                                     |
| `/mcp refresh`         | 重读 config 文件并重连所有 server（无需重启 xc）                               |

`/mcp list` 输出示例：

```
MCP servers:
  filesystem    connected — 11 tools, 0 resources
  github        needs auth — run /mcp auth github to log in
  internal      failed — connect ECONNREFUSED 127.0.0.1:8080
```

---

## 工具命名

MCP 工具名格式为 `<server>__<tool>`（双下划线分隔）。例：

- `filesystem__read_file`
- `github__create_issue`

两个 server 都暴露同名工具时，第二个会自动追加哈希后缀避免冲突（如 `read_file_a3f2`），并写日志说明。

---

## 实战示例

### 示例 1：filesystem server（官方提供）

```jsonc
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"],
    },
  },
}
```

启动后 agent 多了 `fs__read_file`、`fs__write_file`、`fs__list_directory` 等工具，可以读写 `D:/work` 下的文件。

### 示例 2：自建 stdio server

```jsonc
{
  "mcpServers": {
    "company": {
      "command": "node",
      "args": ["D:/tools/company-mcp/index.js"],
      "env": {
        "API_KEY": "${env:COMPANY_API_KEY}",
        "ENDPOINT": "https://internal.corp/api",
      },
      "cwd": "D:/tools/company-mcp",
    },
  },
}
```

### 示例 3：HTTP server + OAuth

```jsonc
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/sse",
    },
  },
}
```

首次启动：

```
$ xc
[mcp] linear: needs auth
> /mcp auth linear
Opening browser to authorize linear...
Listening on http://localhost:33421/oauth/callback
[browser opens, user authorizes]
[token saved to ~/.x-code/mcp/tokens/linear.json]
linear connected — 8 tools, 2 resources
```

之后所有启动自动带 Bearer token，无需重新认证（token 过期前）。

---

## Plugin 提供的 mcpServers

Plugin 可以在 manifest 里声明 `mcpServers`（inline 或 path 形式），加载方式与用户配置相同：

- **算 already-trusted**：不弹项目信任对话框（用户已经在安装 plugin 时同意了）
- **合并顺序**：user → plugin → project，名字冲突时项目级覆盖
- **`/mcp list` 会一并显示**

详情见 [plugins.md](./plugins.md) §贡献内容。

---

## 故障排查

| 现象                               | 处理                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/mcp list` 显示 `failed`          | 看 `stderrTail` 字段（`/mcp list` 输出末尾）；最常见是命令找不到或工作目录错误                                     |
| `needs_auth` 且 `/mcp auth` 没反应 | 确认你的 HTTP server 支持 OAuth；某些自定义 server 用静态 token，直接写 `headers: {"Authorization": "Bearer ..."}` |
| 工具名冲突                         | 同名 server 会被加 hash 后缀；想换名直接改 `mcpServers` 的 key                                                     |
| 重启太慢                           | `/mcp refresh` 增量重连，不需 CLI 重启                                                                             |
| 项目级 config 不生效               | 启动时拒绝过信任对话框？删 `~/.x-code/trusted-projects.json` 里对应路径重启再次确认                                |
| 想临时跳过某个 server              | `enabled: false` 字段，比注释掉整段更明显                                                                          |

启用 `DEBUG_STDOUT=1` 后所有 MCP 事件写入 `~/.x-code/logs/debug.log`，grep `mcp.` 看连接 / 调用 / 错误。

---

## 与 Claude Code MCP 配置的兼容性

X-Code CLI 的 `mcpServers` schema 与 Claude Code 一致——你可以直接把 Claude Code 的 `~/.claude/config.json` 里的 `mcpServers` 段复制到 `~/.x-code/config.json`。一份配置两边都能跑。
