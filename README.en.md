# X-Code CLI

[简体中文](./README.md) · [English](./README.en.md)

**X-Code CLI** is an AI coding assistant that runs in your terminal. Talk to your codebase in natural language and let it read, modify, debug, and build your project — all without leaving the command line.

It supports all major LLM providers (Claude, GPT, DeepSeek, Gemini, Qwen, Grok, GLM, Kimi, etc.), ships with 11 built-in tools (file I/O, shell execution, code search, etc.), and offers advanced capabilities such as a permission model, plan mode, context compression, and a knowledge system.

## Highlights

- **Multi-model support** — 8 built-in providers plus any OpenAI-compatible custom endpoint
- **11 built-in tools** — covers file, shell, search, web fetch, and other day-to-day dev tasks
- **3-level permission model** — safe by default; ask before writing, or use `--trust` to skip
- **Streaming output** — see results as they generate
- **Context compression** — long chats are auto-compressed to stay within token limits
- **Knowledge system** — 7-layer context loading (project rules, memory, session summary, etc.)
- **Plan mode** — propose a plan first for complex tasks, review before executing
- **Slash commands** — quick controls like `/help`, `/model`, `/usage`, `/plan`
- **Cross-platform** — works on Windows, macOS, and Linux
- **Non-interactive mode** — `--print` + pipes for scripts and CI

## Install

```bash
# Install globally via npm
npm install -g @x-code-cli/cli

# Or with pnpm / yarn
pnpm add -g @x-code-cli/cli
yarn global add @x-code-cli/cli
```

After installation, launch with the `xc` or `x-code` command.

## Configure API Keys

> **Important**: X-Code CLI does **not** ship with a built-in free model — **it won't run until you configure an API key**. Sign up with any provider below to get one.
>
> **Recommended: [DeepSeek](https://platform.deepseek.com/)** — cheap, reliable, strong coding ability, and free credits on signup. The best starting point for first-time users.

You need at least one provider API key:

| Variable                       | Provider           | Sign up                                                                     |
| ------------------------------ | ------------------ | --------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com/)                     |
| `OPENAI_API_KEY`               | OpenAI (GPT)       | [platform.openai.com/api-keys](https://platform.openai.com/api-keys)        |
| `DEEPSEEK_API_KEY`             | DeepSeek           | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)    |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google (Gemini)    | [aistudio.google.com/apikey](https://aistudio.google.com/apikey)            |
| `ALIBABA_API_KEY`              | Alibaba (Qwen)     | [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com/apiKey) |
| `XAI_API_KEY`                  | xAI (Grok)         | [console.x.ai](https://console.x.ai/)                                       |
| `ZHIPU_API_KEY`                | Zhipu (GLM)        | [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys)             |
| `MOONSHOT_API_KEY`             | Moonshot (Kimi)    | [platform.moonshot.ai](https://platform.moonshot.ai/console/api-keys)       |

### Web Search Keys (optional)

To enable web search (the `web_search` tool), set **either one** of the following. **Both providers have a free tier — no payment required for everyday use**:

| Variable         | Provider                                      | Free quota                                                       | Signup friction                  |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com)                  | **1,000 credits / month** (basic search = 1 credit, so 1000 searches/mo) | Email signup, **no credit card** |
| `BRAVE_API_KEY`  | [Brave Search](https://brave.com/search/api/) | **$5 free credit / month** (Search at $5 per 1k requests = ~1000 searches/mo) | Credit card required to activate |

> **For first-time setup we recommend Tavily** — lighter signup, and the response format is purpose-built for LLMs (clean summaries instead of raw SERP snippets). If you set both, Tavily wins; Brave is the automatic fallback.
>
> Quota figures come from the official docs ([Tavily](https://docs.tavily.com/documentation/api-credits), [Brave](https://brave.com/search/api/)) and may change — check the linked pages for current numbers.

**How to configure your API key**

Set the key as an environment variable so `xc` can use it from any directory. The example uses `ANTHROPIC_API_KEY` — swap in whichever provider variable you need:

<details>
<summary>bash (Linux / Git Bash / WSL)</summary>

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.bashrc
source ~/.bashrc
```

</details>

<details>
<summary>zsh (macOS default)</summary>

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc
source ~/.zshrc
```

</details>

<details>
<summary>fish</summary>

```fish
set -Ux ANTHROPIC_API_KEY sk-ant-...
```

</details>

<details>
<summary>Windows PowerShell (user-level, persistent)</summary>

```powershell
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', 'sk-ant-...', 'User')
# Restart PowerShell to take effect
```

</details>

<details>
<summary>Windows CMD (user-level, persistent)</summary>

```cmd
setx ANTHROPIC_API_KEY "sk-ant-..."
:: Restart CMD to take effect
```

</details>

> Session-only alternatives like `export X=...` (current bash) or `$env:X = '...'` (current PowerShell) are handy for quick testing but evaporate when you close the terminal.
>
> Per-project overrides: drop a `.env` file in your project root — `xc` loads it by walking up from the current directory.

## Quick Start

```bash
# Enter your project
cd your-project

# Launch interactive session
xc

# Run with a prompt directly
xc "Explain the overall architecture of this project"

# Specify a model
xc -m sonnet "Refactor formatDate in src/utils.ts"

# Trust mode (skip write confirmations — use when you trust the workflow)
xc -t

# Non-interactive mode (print result and exit, great for scripts)
xc -p "Generate a CHANGELOG for this repo"
```

## CLI Options

```text
xc [options] [prompt]

--model, -m <id>      Model to use (e.g. sonnet, deepseek, openai:gpt-4.1)
--trust, -t           Trust mode: skip write confirmations
--print, -p           Non-interactive: print and exit
--max-turns <n>       Max agent loop turns (default: 100)
--version, -v         Show version
--help, -h            Show help
```

## Slash Commands

| Command          | Description                               |
| ---------------- | ----------------------------------------- |
| `/help`          | Show available commands                   |
| `/model [alias]` | Switch model or list available            |
| `/usage`         | Show current-session token usage incl. cache hits; `/usage history` lists past sessions in this project |
| `/clear`         | Clear conversation                        |
| `/compact`       | Manually compress context                 |
| `/init`          | Initialize project knowledge              |
| `/session save`  | Save session without exiting              |
| `/plan`          | Enter plan mode                           |
| `/exit`          | Save session and exit                     |

## File Attachments

Mention a file path in your prompt and the CLI attaches its contents automatically:

```bash
# Explicit @-mention
> what does @D:\code\app\src\main.ts do in its main function?

# Bare absolute paths (must include an extension) work too
> summarize the key points in /home/me/report.pdf

# Images, PDFs, docx, xlsx, pptx are all supported
> what's wrong in this screenshot? @D:\screenshots\bug.png
```

Per-provider support:

| Kind                 | Claude / GPT / Gemini / Grok / Kimi / Qwen / GLM | DeepSeek             |
| -------------------- | ------------------------------------------------ | -------------------- |
| Source / text files  | Inlined                                          | Inlined              |
| Text PDF             | Extracted locally (saves tokens)                 | Extracted locally    |
| Scanned PDF          | Native PDF input                                 | Local raster + OCR   |
| docx / xlsx / pptx   | Extracted locally                                | Extracted locally    |
| Images (png/jpg/...) | Native vision                                    | Vision sub-agent / OCR |

**DeepSeek + images — automatic vision sub-agent**: the DeepSeek API has no multimodal vision input, but the CLI will automatically borrow another configured provider as a "vision sub-agent" to look at the image for it:

1. Detects whether **any other multimodal provider key** is set in your environment (priority order: Google → Zhipu → Alibaba → OpenAI → Anthropic → Moonshot → xAI).
2. If found, calls a lightweight vision model on that provider (e.g. `gemini-2.5-flash` / `glm-4v-flash`) to generate a description of the image.
3. Injects the description as text into the message sent to DeepSeek — DeepSeek "sees" the image transparently, no manual switch needed.
4. The terminal prints a single line `⎿  Captioned image via google:gemini-2.5-flash` so you know which sub-agent ran.
5. If no vision provider is configured, it falls back to local `tesseract.js` OCR (text-in-image only).

**Strongly recommended** for DeepSeek users — register a free vision model key for the smoothest experience:

- **Google Gemini** (`GOOGLE_GENERATIVE_AI_API_KEY`) — free tier ~10 RPM / 250 RPD on Gemini 2.5 Flash (verify current quota on the [official rate-limits page](https://ai.google.dev/gemini-api/docs/rate-limits) — Google has been tightening the free tier). Best quality, requires VPN in some regions. Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) by signing in with any Google account.
- **Zhipu GLM-4V-Flash** (`ZHIPU_API_KEY`) — officially marked permanently free by Zhipu, generous enough for personal use, directly accessible from China. Register at [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) and create a key from the user center.

**Limits of the vision sub-agent** (please be aware):

- The sub-agent returns **a text description**, not true multimodal interaction — DeepSeek cannot ask follow-up questions about the image (e.g. "what color is the button in the top-right?" will fail).
- For complex UI reproduction or pixel-level layout review, the description loses detail.
- For those cases, `/model` switch directly to Claude / Gemini / GLM-4V or another multimodal model and continue the conversation there.

## Troubleshooting

To capture a debug log when reporting a bug, launch with `DEBUG_STDOUT=1`:

```bash
DEBUG_STDOUT=1 xc
```

The log lives under your home directory:

- **Path**: `~/.x-code/logs/debug.log` (with rotated `debug.log.1`)
- **Size cap**: 10 MB per file, ~20 MB total with rotation — oldest data is overwritten automatically
- **Capacity guide**: ~5 MB of debug log per ~50-turn agent run, so a typical multi-turn need fits entirely in the active file; rotation only triggers past ~100 turns
- **Line guarantee**: each entry is capped at 1 KB (truncated with a marker if longer), so each rotation cycle holds **≥ 20,000 lines**
- **View**: `tail -f ~/.x-code/logs/debug.log`, or attach the file to your issue

The log file is written only when `DEBUG_STDOUT=1` is set; default runs incur zero overhead.

## Project Structure

```text
x-code-cli/
├── packages/
│   ├── core/        @x-code-cli/core    AI engine (no UI deps)
│   │   └── src/
│   │       ├── agent/        Agent loop, system prompt, plan mode
│   │       ├── config/       Model config, API key management
│   │       ├── knowledge/    Knowledge loader, auto-memory, session, project scan
│   │       ├── permissions/  3-level permission system
│   │       ├── providers/    AI SDK provider registry (8+)
│   │       ├── tools/        11 tool implementations
│   │       └── types/        Public TypeScript interfaces
│   │
│   └── cli/         @x-code-cli/cli     Terminal UI
│       └── src/
│           ├── index.ts        CLI entry point
│           ├── app.tsx         Ink app root
│           └── ui/             React components, hooks, theme
│
└── .x-code/         Project knowledge directory
    ├── memory/      Auto-generated memory
    ├── plans/       Implementation plans
    ├── rules/       Custom agent rules
    ├── sessions/    Session summaries
    └── local/       Personal preferences (gitignored)
```

## Build From Source

```bash
# Clone the repo
git clone https://github.com/woai3c/x-code-cli.git
cd x-code-cli

# Install dependencies
pnpm install

# Build
pnpm build

# Run directly
node packages/cli/dist/cli.js

# Or development mode
pnpm dev
```

## Feedback & Contributing

Issues and PRs are welcome: <https://github.com/woai3c/x-code-cli>

## License

[MIT](./LICENSE)
