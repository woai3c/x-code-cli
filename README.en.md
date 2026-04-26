# X-Code CLI

[简体中文](./README.md) · [English](./README.en.md)

**X-Code CLI** is an AI coding assistant for the command line. It enables natural-language interaction with the codebase to read, modify, debug, and build projects without leaving the terminal.

X-Code CLI supports the major LLM providers (Claude, GPT, DeepSeek, Gemini, Qwen, Grok, GLM, Kimi, etc.), ships with 11 built-in tools (file I/O, shell execution, code search, etc.), and provides capabilities such as a permission model, context compression, file attachments, and a knowledge system.

## Features

- **Multi-model support** — 8 built-in providers and any OpenAI-compatible custom endpoint
- **11 built-in tools** — covers file, shell, search, web fetch, and other common development tasks
- **3-level permission model** — safe by default, prompts before write operations; `--trust` bypasses prompts
- **Streaming output** — results render as they are generated
- **Context compression** — long conversations are auto-compressed; loop-guard detects repeated tool invocations; prompt caching reuses prefixes to reduce input cost
- **Knowledge system** — layered context loading (global / project AGENTS.md chain / auto-memory / local preferences / session summary)
- **File attachments** — `@path` mentions or bare absolute paths in the prompt auto-ingest text / code / PDF / docx / xlsx / pptx / images
- **Vision sub-agent** — text-only providers such as DeepSeek can borrow another configured vision model to generate image descriptions
- **Slash commands** — quick controls including `/help`, `/model`, `/thinking`, `/usage`, `/usage history`
- **Unified thinking-mode toggle** — `/thinking on|off` consolidates each provider's bespoke thinking/reasoning parameters into a single switch
- **Cross-platform** — runs on Windows, macOS, and Linux
- **Non-interactive mode** — `--print` with pipes for scripts and CI

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

> **Note**: X-Code CLI does not bundle a free model. **At least one provider API key must be configured before use.** Sign up with any provider listed below to obtain a key.
>
> **Recommended: [DeepSeek](https://platform.deepseek.com/)** — affordable, reliable, sufficient coding capability for everyday development, and free credits on signup. A suitable starting point for first-time users.

At least one provider key is required:

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

To enable web search (the `web_search` tool), configure **either** of the following. Both providers offer a free tier sufficient for everyday use:

| Variable         | Provider                                      | Free quota                                                          | Signup requirements              |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com)                  | **1,000 credits / month** (1 credit per basic search, ~1,000/month) | Email signup, **no credit card** |
| `BRAVE_API_KEY`  | [Brave Search](https://brave.com/search/api/) | **$5 free credit / month** ($5 per 1,000 requests, ~1,000/month)    | Credit card required to activate |

> **Tavily is recommended for first-time setup**: simpler signup, with response formats optimized for LLM use (cleaned summaries rather than raw SERP). When both are configured, Tavily is preferred and Brave serves as the automatic fallback.
>
> Quota figures are sourced from official documentation ([Tavily](https://docs.tavily.com/documentation/api-credits), [Brave](https://brave.com/search/api/)); refer to the linked pages for current limits.

**Configuration**

Once the API key is exported as an environment variable, `xc` can be invoked from any directory. The example below uses `ANTHROPIC_API_KEY`; substitute the variable name for the provider in use:

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

> For temporary use within a single session, run `export X=...` (bash) or `$env:X = '...'` (PowerShell); these settings are discarded when the terminal closes.
>
> Per-project configuration: place a `.env` file in the project root. `xc` loads it by walking up from the current directory.

## Quick Start

```bash
# Enter the project directory
cd your-project

# Launch an interactive session
xc

# Run with a prompt
xc "Explain the overall architecture of this project"

# Specify a model
xc -m sonnet "Refactor the formatDate function in src/utils.ts"

# Trust mode: skip write-operation confirmations
xc -t

# Non-interactive mode: print the result and exit, suitable for scripting
xc -p "Generate a CHANGELOG for this repository"
```

## CLI Options

```text
xc [options] [prompt]

--model, -m <id>      Model to use (e.g. sonnet, deepseek, openai:gpt-4.1)
--trust, -t           Trust mode: skip write-operation confirmations
--print, -p           Non-interactive mode: print result and exit
--max-turns <n>       Maximum agent loop turns (default: 100)
--version, -v         Show version
--help, -h            Show help
```

## Slash Commands

| Command               | Description                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `/help`               | Show available commands                                                                                  |
| `/model [alias]`      | Switch model or list available models                                                                    |
| `/thinking [on\|off]` | Enable / disable thinking mode (no argument opens the picker)                                            |
| `/usage`              | Show current-session token usage (including cache hit rate); `/usage history` lists past project sessions |
| `/clear`              | Clear the current conversation                                                                           |
| `/compact`            | Manually compress context                                                                                |
| `/init`               | Initialize the project knowledge base                                                                    |
| `/session save`       | Save the current session without exiting                                                                 |
| `/exit`               | Save the session and exit                                                                                |

### Thinking-mode notes

The 8 supported providers exhibit different default behaviors for thinking / reasoning mode:

- **Enabled by default**: Gemini 2.5 Pro, Kimi K2.5
- **Disabled by default**: Claude Sonnet, DeepSeek V4, Qwen Max — must be explicitly enabled to reach published benchmark scores
- **Not supported**: GPT-4.1, Grok 3, GLM-4-Plus do not expose a thinking option on the listed model IDs

`/thinking` consolidates these differences into a single switch:

- `/thinking` (no argument): opens an interactive picker showing the current state with arrow-key switching
- `/thinking on`: enables thinking mode for every provider that supports it (slower responses, stronger on hard problems)
- `/thinking off`: disables thinking mode (faster responses, lower cost)

The setting is persisted to `~/.x-code/config.json` and survives restarts. Toggles take effect immediately on the next message; no model rebuild is required.

## File Attachments

Reference a file path in the prompt and the CLI attaches its contents to the request automatically:

```bash
# @ syntax (explicit reference)
> Explain the main function in @D:\code\app\src\main.ts

# Bare absolute paths (extension required)
> Summarize the key points of /home/me/report.pdf

# Images, PDFs, docx, xlsx, and pptx are all supported
> Identify the issue in this screenshot: @D:\screenshots\bug.png
```

Per-provider support:

| Type                 | Claude / GPT / Gemini / Grok / Kimi / Qwen / GLM | DeepSeek                |
| -------------------- | ------------------------------------------------ | ----------------------- |
| Source / text files  | Inlined                                          | Inlined                 |
| Text PDF             | Extracted locally (saves tokens)                 | Extracted locally       |
| Scanned PDF          | Native PDF input                                 | Local raster + OCR      |
| docx / xlsx / pptx   | Extracted locally                                | Extracted locally       |
| Images (png/jpg/...) | Native vision                                    | Vision sub-agent / OCR  |

**DeepSeek image handling — vision sub-agent**: The DeepSeek API does not support multimodal vision input. When the user attaches an image, the CLI automatically delegates image understanding to another configured provider:

1. Checks whether any other multimodal provider key is configured in the environment (priority: Google → Zhipu → Alibaba → OpenAI → Anthropic → Moonshot → xAI)
2. If found, invokes a lightweight vision model from that provider (e.g. `gemini-2.5-flash` or `glm-4v-flash`) to generate an image description
3. Injects the description text into the message sent to DeepSeek so the image content remains accessible
4. The terminal prints `⎿  Captioned image via google:gemini-2.5-flash` to indicate which sub-agent was used
5. If no vision provider is configured, the CLI falls back to local `tesseract.js` OCR (text-in-image only)

**Recommendation** for DeepSeek users: register a free vision model key for richer image understanding:

- **Google Gemini** (`GOOGLE_GENERATIVE_AI_API_KEY`): free tier of approximately 10 RPM / 250 RPD on Gemini 2.5 Flash (refer to the [official rate-limits page](https://ai.google.dev/gemini-api/docs/rate-limits) for current quotas). Provides the highest description quality; access from some regions requires a VPN. Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) by signing in with a Google account.
- **Zhipu GLM-4V-Flash** (`ZHIPU_API_KEY`): officially marked permanently free, sufficient for personal use, directly accessible from China. Register at [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) and create a key from the user center.

**Limitations of the vision sub-agent**:

- The sub-agent returns a text description rather than supporting true multimodal interaction; DeepSeek cannot ask follow-up questions about the image (e.g. "what color is the button in the top-right corner" cannot be answered)
- For complex UI reproduction or pixel-level layout review, the text description may omit fine details
- For such scenarios, switch to a multimodal model (Claude, Gemini, GLM-4V, etc.) via `/model` and continue the conversation directly

## Troubleshooting

To capture a debug log, launch with the `DEBUG_STDOUT=1` environment variable:

```bash
DEBUG_STDOUT=1 xc
```

The log is written under the user directory:

- **Path**: `~/.x-code/logs/debug.log` (with rotated `debug.log.1`)
- **Size limit**: 10 MB per file, ~20 MB total including the rotated backup; the oldest data is overwritten automatically
- **Capacity reference**: a typical 50-turn agent session produces ~5 MB of log, which fits entirely within the active file; rotation only occurs after ~100 turns
- **Per-entry limit**: each entry is capped at 1 KB (truncated with a marker if longer), guaranteeing at least 20,000 entries per rotation cycle
- **Inspection**: use `tail -f ~/.x-code/logs/debug.log`, or attach the file to a GitHub Issue

The log file is written only when `DEBUG_STDOUT=1` is set; default runs incur zero overhead.

## Project Structure

```text
x-code-cli/
├── packages/
│   ├── core/        @x-code-cli/core    AI engine (no UI deps)
│   │   └── src/
│   │       ├── agent/        Agent loop, system prompt, file ingest, vision fallback, loop guard
│   │       ├── config/       Model config, API key management
│   │       ├── knowledge/    Knowledge loader, auto-memory, session summary and usage
│   │       ├── permissions/  3-level permission system
│   │       ├── providers/    AI SDK provider registry, thinking switch, cache control
│   │       ├── tools/        11 tool implementations
│   │       └── types/        Public TypeScript interfaces
│   │
│   └── cli/         @x-code-cli/cli     Terminal UI
│       └── src/
│           ├── index.ts        CLI entry point
│           ├── app.tsx         Ink app root
│           └── ui/             React components, hooks, theme
│
└── .x-code/         Project knowledge directory (created on first /init)
    ├── memory/      AI-written auto memory (auto.md)
    ├── sessions/    Session summaries and token usage
    └── local/       Personal preferences (gitignored)
```

## Build From Source

```bash
# Clone the repository
git clone https://github.com/woai3c/x-code-cli.git
cd x-code-cli

# Install dependencies
pnpm install

# Build
pnpm build

# Run the build output
node packages/cli/dist/cli.js

# Or run from source (builds core once, then runs the CLI through tsx; does not watch for changes)
pnpm dev
```

> Source changes require rerunning `pnpm build` or `pnpm dev` to take effect. To watch for changes, run `pnpm dev` inside `packages/core` in a separate terminal (which executes `tsc -b --watch`).

## Feedback & Contributing

Issues and pull requests are welcome: <https://github.com/woai3c/x-code-cli>

## License

[MIT](./LICENSE)
