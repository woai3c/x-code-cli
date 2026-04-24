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

| Variable                       | Provider           |
| ------------------------------ | ------------------ |
| `ANTHROPIC_API_KEY`            | Anthropic (Claude) |
| `OPENAI_API_KEY`               | OpenAI (GPT)       |
| `DEEPSEEK_API_KEY`             | DeepSeek           |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google (Gemini)    |
| `ALIBABA_API_KEY`              | Alibaba (Qwen)     |
| `XAI_API_KEY`                  | xAI (Grok)         |
| `ZHIPU_API_KEY`                | Zhipu (GLM)        |
| `MOONSHOT_API_KEY`             | Moonshot (Kimi)    |

### Web Search Keys (optional)

To enable web search (the `web_search` tool), set **either one** of the following:

| Variable         | Provider                                      |
| ---------------- | --------------------------------------------- |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com)                  |
| `BRAVE_API_KEY`  | [Brave Search](https://brave.com/search/api/) |

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
| `/usage`         | Show token usage (input / output / total) |
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
| Images (png/jpg/...) | Native vision                                    | Local OCR fallback   |

**Heads-up on DeepSeek and images**: the DeepSeek API has no multimodal vision input, so the CLI falls back to local OCR via `tesseract.js` to pull text out of images. That means:

- You only get the **text printed in the image**; colors, layout, diagrams, photos, and any non-textual content are invisible to the model.
- CJK OCR accuracy is mediocre, and stylized or handwritten text often fails.
- For anything where you need the model to actually *see* the image, **switch to Claude / Kimi / Qwen-VL / GLM-4V** or another multimodal model (`/model` swaps instantly).

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
