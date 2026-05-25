# Marketplace — 使用指南

Marketplace 是一个**插件索引**——一个 JSON 文件（一个 URL），列出 `{ name, source }` 条目指向插件实际所在的 git repo 或本地路径。Marketplace 不托管插件代码，它是目录。

x-code 不自己运营 marketplace。它只**订阅**别人的 marketplace。Marketplace.json schema 与 Claude Code 字节级兼容，所以订阅 Anthropic 官方 marketplace 开箱即用。

英文版：[marketplace.en.md](./marketplace.en.md) · 相关：[plugins.md](./plugins.md) · [plugin-authoring.md](./plugin-authoring.md)

---

## 开箱默认有什么

x-code 首次启动 CLI **或首次跑任何 `xc plugin …` 子命令时**自动写一条订阅：

| 名字                    | 源                                          | 说明                                                        |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `anthropic-marketplace` | `github:anthropics/claude-plugins-official` | Anthropic 官方 Claude Code marketplace（200+ 插件），保留名 |

如果你用 `/plugin marketplace remove anthropic-marketplace` 删掉了，后续启动**不会自动重加**（详见 [幂等性](#幂等性)）。

---

## 订阅一个 marketplace

```bash
# 从 GitHub repo（约定路径 .claude-plugin/marketplace.json）
xc plugin marketplace add community github:foo/x-code-marketplace

# 从直接服务 marketplace.json 的 HTTPS URL
xc plugin marketplace add internal https://intranet.example.com/plugins.json

# 然后拉它的索引
xc plugin marketplace refresh community
```

列出订阅：

```bash
xc plugin marketplace list
# →
# Subscribed marketplaces (2):
#   anthropic-marketplace github:anthropics/claude-plugins-official [official]
#   community             github:foo/x-code-marketplace
```

看某个订阅里有啥：

```bash
xc plugin marketplace info community
xc plugin search linear
```

取消订阅：

```bash
xc plugin marketplace remove community
```

---

## 保留名

少数 marketplace 名字保留用于防仿冒：

| 名字                    | 只接受来源            |
| ----------------------- | --------------------- |
| `anthropic-marketplace` | `github:anthropics/…` |
| `claude-plugins`        | `github:anthropics/…` |
| `x-code-official`       | `github:woai3c/…`     |

用保留名但源不对的订阅会被 API 直接拒：

```bash
$ xc plugin marketplace add anthropic-marketplace github:bad/marketplace
Marketplace name "anthropic-marketplace" is reserved; only sources
under github:anthropics/* may use it. Got: github:bad/marketplace
```

这只是命名碰撞保护，不是安全审计——任何非保留名你都可以随便订阅任何源。

---

## marketplace.json schema

x-code 用 Anthropic 公开的 Claude Code marketplace schema——你写的文件可以被 Claude Code 直接用。文件位置约定：repo 的 **`.claude-plugin/marketplace.json`**。

参考真实文件：`anthropics/claude-code` 与 `anthropics/claude-plugins-official`。

```jsonc
{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "community",
  "version": "1.0.0",
  "description": "Community-curated plugins.",
  "owner": { "name": "Foo Org", "url": "https://foo.example" },
  "plugins": [
    {
      "name": "linear",
      "description": "Linear issue 集成",
      "version": "1.2.0",
      "author": { "name": "...", "email": "..." },
      "category": "productivity",
      "source": "./plugins/linear", // 字符串相对路径，最常用
    },
    {
      "name": "k8s",
      "source": "github:foo/k8s-plugin", // 字符串 github 简写
    },
    {
      "name": "from-monorepo",
      "source": {
        // git-subdir：其他 git repo 的子目录
        "source": "git-subdir",
        "url": "https://github.com/42Crunch-AI/claude-plugins.git",
        "path": "plugins/api-security",
        "ref": "v1.5.5",
      },
    },
  ],
}
```

> **`name` vs 订阅别名**：marketplace.json 里的 `name`（例如官方那个写 `claude-plugins-official`）是**作者自己声明的名字**；而你订阅时用 `xc plugin marketplace add <alias> <source>` 给的 `<alias>` 才是 x-code 内部使用的规范身份（cache 路径、`<plugin>@<alias>` install id、`/plugin marketplace list` 显示等都走 alias）。两者不一致时，`/plugin marketplace info <alias>` 会额外打一行 `Upstream name: <作者声明的 name>`。这样订阅 Anthropic 官方时你用方便记的 `anthropic-marketplace` 就好，不必每次都打 `claude-plugins-official`。

### 源（source）允许的形式

x-code 接受 Anthropic Claude Code 的全部 wire 形式（见 anthropics/claude-code、anthropics/claude-plugins-official 真实 marketplace.json）：

| 形式                                                                                                      | 说明                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `"./plugins/foo"` 或 `"../shared/x"`                                                                      | **字符串相对路径**——指代订阅此 marketplace 的 git repo 内的子目录。最常见，适合 monorepo 集中托管多个插件（Anthropic 自家用这个） |
| `"github:owner/repo[#ref]"`                                                                               | **字符串 GitHub 简写**                                                                                                            |
| `"https://..."` 或 `"git@..."`                                                                            | **字符串 git URL**                                                                                                                |
| `{ source: "git-subdir", url, path, ref?, sha? }`                                                         | **对象 git-subdir**——其他 git repo 的子目录。`sha` 可选；填了就走完整性校验，clone 后 HEAD 不匹配硬失败                           |
| `{ source: "url", url, sha? }`                                                                            | **对象 git URL**                                                                                                                  |
| `{ source: "github", owner, repo, ref?, subdir? }` 或 `{ source: "github", repo: "owner/repo", commit? }` | **对象 GitHub**——owner/repo 可分开也可合并；`commit` 等价于 `ref`                                                                 |
| `{ source: "git", url, ref?, subdir? }`                                                                   | **对象 git**                                                                                                                      |
| `{ source: "local", path }`                                                                               | **本地路径**——开发用，不可移植                                                                                                    |

约束：

- 字符串相对路径只有当 marketplace 通过 git clone 拉取时才有意义——订阅 raw HTTPS JSON URL 的 marketplace 不能用相对路径
- **完整性校验（`sha`）已生效**：git/github/git-subdir/url 形态可选填 `sha` 字段（≥7 字符 hex commit hash）。installer clone 完会跑 `git rev-parse HEAD` 跟 `sha` 对比，**不匹配硬失败**——防御上游 force-push 或 repo 被入侵的供应链攻击。未声明则跳过校验（向后兼容老 marketplace）。短 sha 走前缀匹配，跟 `git checkout <short>` 一个语义
- 内部统一归一化成 `{ kind: 'git'|'github'|'local', ..., subdir?, expectedSha? }`；wire 格式只在 marketplace.json 这层暴露

---

## 自己 host 一份 marketplace

两种简单形态：

**1. 一个 GitHub repo**，路径约定 `.claude-plugin/marketplace.json`（与 Claude Code 一致）。

订阅者执行：

```bash
xc plugin marketplace add <name> github:youruser/yourrepo
```

CLI 浅克隆 → 优先读 `.claude-plugin/marketplace.json`、缺失时回退到 repo 根的 `marketplace.json` → 缓存、删克隆。之后 `xc plugin marketplace refresh <name>` 再克隆刷新。

**2. 一个 HTTPS 端点**直接服务 `marketplace.json`。

订阅者执行：

```bash
xc plugin marketplace add <name> https://example.com/marketplace.json
```

CLI 用 `fetch()` 拉取。适合企业内部 marketplace——可按 VPN 服务不同索引、强制 TLS 等。

两种形态都会把解析后的索引缓存到 `~/.x-code/plugins/marketplaces/<name>/marketplace.json`，首次 refresh 之后就能离线用了。

---

## 缓存

`xc plugin marketplace refresh <name>` 之后索引在 `~/.x-code/plugins/marketplaces/<name>/marketplace.json`。缓存文件的 mtime 作为"新鲜度"标记——目前**没有自动 TTL 刷新**，需要用户（或脚本）主动 `refresh` 拉新。

未来计划做可选的后台刷新；目前手动。

---

## 怎么策划自己的 marketplace

看到三种可用模式：

1. **纯策划**——你的 marketplace.json 列别人 repo 的插件。零托管成本；你是信任中介。适合企业内部 marketplace（"这些是我们安全团队审过的"）。

2. **创作 + 策划**——你在自己 GitHub org 下发布插件并在自己的 marketplace 列出。标准的生态主理模式。

3. **镜像**——你的 marketplace.json 指向另一个 marketplace 列的同一批 repo。适合做高可用，或者从一个大上游列表里筛掉非强制的条目。

三种模式 marketplace.json 本身都很小——就是个索引。插件本身在哪都行。

---

## 幂等性

`ensureDefaultMarketplaces()`（首次启动 CLI 或首次跑 `xc plugin …` 子命令时写 `anthropic-marketplace` 默认订阅的函数）会先检查 `known_marketplaces.json`，任何条目存在就跳过。**文件一旦存在就不会被覆盖**——所以删掉默认订阅在重启间保留。

之后想要回来：`xc plugin marketplace add anthropic-marketplace github:anthropics/claude-plugins-official`。

---

## 与 Claude Code 的兼容性

Anthropic 官方 Claude Code marketplace 发布的 `marketplace.json` 用的就是上面描述的 schema。x-code 直接读，不需要翻译。任何第三方 Claude Code marketplace 也一样——x-code 订阅后能正常工作，只要里面列的插件用：

- `.claude-plugin/plugin.json`
- `.x-code-plugin/plugin.json`
- `plugin.json`

之一作为 manifest（x-code 按这个优先级探测三个路径）。

只用 Claude Code 独有 manifest 字段（`output-styles`、`lspServers`）的插件能正常装，那两个字段会被静默忽略。

---

## 故障排查

| 症状                                | 处理                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `add` 报 "reserved"                 | 名字是 [保留名](#保留名) 且源不匹配。换别的名字                         |
| `refresh` 失败 HTTP error           | URL 错了，或者 git repo 根目录没有 `marketplace.json`                   |
| `info` 报 "no cached index"         | 先 `refresh`                                                            |
| `search` 找不到已知插件             | 跑 `refresh`——索引可能 stale，或者该插件根本不在你订阅的 marketplace 里 |
| 想从 Claude Code marketplace 迁过来 | 它默认就订阅了。`xc plugin install <name>@anthropic-marketplace` 即可   |
