export const INIT_PROMPT = `Please analyze this codebase and create an AGENTS.md file at the project root. AGENTS.md is loaded into every X-Code CLI (\`xc\`) session, so future agents will read it as their primary project context.

What to include:
1. Common commands the agent should prefer: how to build, lint, run tests, run a single test. Only include what's non-obvious from manifest files.
2. High-level architecture that requires reading multiple files to understand — module boundaries, key data flows, the "big picture" a new contributor needs.
3. Important conventions that DIFFER from language defaults (e.g. "prefer type over interface", "errors live in errors.ts, never inline").
4. Non-obvious gotchas, required env vars, repo etiquette (branch naming, commit style).

Usage notes:
- If AGENTS.md already exists, read it first and use the Edit tool to merge improvements rather than overwriting — preserve the user's hand-written content.
- Apply the minimalism test to every line: "If I removed this line, would the agent make a mistake?" If no, cut it. AGENTS.md is read every turn — bloat costs tokens forever.
- If a README.md exists, mine it for project overview / commands / setup steps. If \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`, \`.windsurfrules\`, or \`.clinerules\` exist, fold the important parts in.
- Do not list every file or component — those are discoverable via Glob/Grep. Focus on what's NOT discoverable.
- Do not invent sections like "Common Development Tasks", "Tips for Development", or "Support and Documentation" — only write what's expressly grounded in files you've read.
- Do not include generic engineering advice ("write clean code", "add tests"), standard language conventions, or obvious commands ("npm test", "cargo test").
- Personal preferences (the user's role, sandbox URLs, communication style) belong in AGENTS.local.md — gitignored, loaded alongside AGENTS.md. Mention this only if the user has clearly personal context to record; otherwise leave AGENTS.local.md alone.

Prefix the file with:

\`\`\`
# AGENTS.md

This file is loaded into the agent's context at the start of every session. Keep it concise — the agent reads it every turn.
\`\`\`

When you finish, summarize what you wrote (or what you changed if updating an existing file) in a few bullets so the user can review.`

export const REVIEW_PROMPT = (args: string) => `You are an expert code reviewer. Use \`gh\` directly — no wrappers.

If no PR number is provided in the args:
1. Run \`gh pr list\` to show open PRs.
2. If the output is empty, reply with exactly: "No open PRs in this repository — re-run \`/review <number>\` to review a specific PR." and stop.
3. Otherwise, list the open PRs and ask the user which to review. Stop and wait.
4. Do NOT investigate further — no \`gh auth\`, no branch / diff / status checks, no reviewing uncommitted changes. The user will re-invoke /review.

If a PR number is provided:
1. Run \`gh pr view <number>\` to get PR details.
2. Run \`gh pr diff <number>\` to get the diff.
3. Write a concise but thorough review with clear sections and bullet points covering:
   - Overview of what the PR does
   - Code correctness
   - Project conventions
   - Performance implications
   - Test coverage
   - Security considerations
   - Specific suggestions and risks

PR number: ${args}`
