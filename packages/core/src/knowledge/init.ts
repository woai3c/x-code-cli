// @x-code-cli/core — Project initialization (xc init / /init)
//
// Creates the .x-code/ directory structure (for CLI internal state only) and
// seeds an AGENTS.md template at the project root for the user to fill in.
//
// AGENTS.md is the industry-convergent convention (Codex, OpenCode, etc.) for
// "user-authored project context the agent should read every session". Placing
// it at the repo root — not in a hidden directory — matches how Claude Code,
// Codex, and OpenCode all treat this kind of file: as a first-class,
// discoverable, user-maintained document, same category as README.md.
//
// We do NOT scan manifest files (package.json, Cargo.toml, etc.) to infer tech
// stack — that biases the CLI toward a specific ecosystem. Language and
// framework discovery is left to the agent's own exploration; AGENTS.md
// captures whatever the user (or a future AI-driven /init) chooses to record.
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR, fileExists } from '../utils.js'

interface InitResult {
  createdFiles: string[]
}

/** Initialize .x-code/ directory structure and seed AGENTS.md at the project root */
export async function initProject(cwd: string = process.cwd()): Promise<InitResult> {
  const createdFiles: string[] = []

  // AGENTS.md at the project root — the user-facing project spec.
  const agentsPath = path.join(cwd, 'AGENTS.md')
  if (!(await fileExists(agentsPath))) {
    await fs.writeFile(agentsPath, AGENTS_TEMPLATE, 'utf-8')
    createdFiles.push('AGENTS.md')
  }

  // .x-code/ directory — CLI internal state only (memory, sessions, plans, local overrides).
  const xDir = path.join(cwd, XCODE_DIR)
  const dirs = [
    xDir,
    path.join(xDir, 'memory'),
    path.join(xDir, 'sessions'),
    path.join(xDir, 'plans'),
    path.join(xDir, 'local'),
  ]
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
  }

  const localGitignore = path.join(xDir, 'local', '.gitignore')
  if (!(await fileExists(localGitignore))) {
    await fs.writeFile(localGitignore, '*\n', 'utf-8')
    createdFiles.push('.x-code/local/.gitignore')
  }

  const prefsPath = path.join(xDir, 'local', 'preferences.md')
  if (!(await fileExists(prefsPath))) {
    await fs.writeFile(prefsPath, PREFERENCES_TEMPLATE, 'utf-8')
    createdFiles.push('.x-code/local/preferences.md')
  }

  return { createdFiles }
}

const AGENTS_TEMPLATE = `# AGENTS.md

<!--
  This file is loaded into the agent's context at the start of every session.
  Keep it concise — the agent reads it every turn.

  In a monorepo, package-level AGENTS.md files (e.g. packages/web/AGENTS.md)
  are concatenated after this one, so you can override root-level guidance
  with more specific context in sub-packages.
-->

## Overview

<!-- One or two sentences: what does this project do? Who uses it? -->

## Tech Stack

<!--
  Language, frameworks, key libraries. Example:
  - Language: Rust 1.75 (2021 edition)
  - Build: cargo
  - Test: cargo test, integration tests under tests/
-->

## Commands

<!--
  Common commands the agent should prefer. Example:
  - Build: make build
  - Test: pytest tests/
  - Lint: ruff check .
  - Run locally: docker compose up
-->

## Conventions

<!--
  Project-specific conventions that aren't obvious from the code. Example:
  - All public APIs must have doctests
  - Error types live in errors.rs, never inline
  - Database migrations are numbered, never renamed
-->

## Business Context

<!--
  Domain knowledge, non-obvious constraints, key stakeholders.
  What would a new contributor spend their first week figuring out?
-->
`

const PREFERENCES_TEMPLATE = `# Personal Preferences

<!--
  Your personal preferences for this project. This file is gitignored.
  Example:
  - Reply in Chinese
  - Prefer terse commit messages
  - Don't run the test suite unless I ask
-->
`

