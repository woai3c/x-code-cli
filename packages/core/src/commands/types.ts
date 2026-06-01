// @x-code-cli/core — File-based slash command types
//
// A "command" is a markdown file shipped by a plugin (or, in future,
// authored directly under ~/.x-code/commands/) that turns into a slash
// command at startup. Real Claude Code plugins ship them as
// `commands/<name>.md` next to their plugin.json — `code-review.md`
// inside `code-review` plugin's `commands/` registers as `/code-review`.
//
// File format (matches Claude Code spec verified against
// anthropics/claude-code real plugin contents):
//
//     ---
//     description: Code review a pull request
//     allowed-tools: Bash(gh pr view:*), …      # ignored by us today
//     ---
//
//     <body — a prompt template the model executes>
//
//     Substitutions applied to the body before sending to the model:
//       $ARGUMENTS                — text typed after the command name
//       ${ARGUMENTS}              — same, brace form
//       ${CLAUDE_PLUGIN_ROOT}     — absolute path to the plugin root
//                                   (so command bodies can reference
//                                   bundled scripts via shell)

export interface CommandDefinition {
  /** Command invocation name without the leading slash. Derived from
   *  the filename (`code-review.md` → `code-review`). */
  name: string
  /** Short one-line summary from the frontmatter `description` field —
   *  used by `/help` and `/plugin info` to label the command. */
  description?: string
  /** The prompt template (everything after the frontmatter), trimmed. */
  body: string
  /** Where this command came from. `'user'` = `~/.x-code/commands/*.md`,
   *  `'project'` = `<repo-root>/.x-code/commands/*.md`, `'plugin'` =
   *  plugin-contributed `commands/*.md`. Mirrors SkillDefinition / SubAgentDefinition. */
  source: 'user' | 'project' | 'plugin'
  /** When source === 'plugin', the owning plugin's id
   *  (`name@marketplace`). Used by `/plugin info` and to set
   *  `${CLAUDE_PLUGIN_ROOT}` correctly. */
  pluginId?: string
  /** Absolute path to the plugin's root dir. Substituted in for
   *  `${CLAUDE_PLUGIN_ROOT}` in the body — so command bodies that
   *  reference bundled scripts can resolve them correctly. */
  pluginRoot?: string
}
