// @x-code-cli/cli — yargs argument definitions for the `xc` CLI.
//
// Kept separate from the entrypoint so a long option list (8-10 flags + 2
// version/help aliases) doesn't crowd the startup orchestration in
// index.ts. The shape of `Argv` is whatever yargs infers from the option
// chain below — kept implicit on purpose so adding / renaming a flag in
// one place updates the consumer's type automatically.
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { VERSION } from './version.js'

export async function parseCliArgs() {
  return yargs(hideBin(process.argv))
    .scriptName('x-code')
    .usage('$0 [options] [prompt]')
    .option('model', {
      alias: 'm',
      type: 'string',
      describe: 'Model to use (e.g. sonnet, deepseek, openai:gpt-5.5)',
    })
    .option('trust', {
      alias: 't',
      type: 'boolean',
      default: false,
      describe: 'Trust mode: skip write operation confirmations',
    })
    .option('print', {
      alias: 'p',
      type: 'boolean',
      default: false,
      describe: 'Non-interactive mode: output result and exit',
    })
    .option('max-turns', {
      type: 'number',
      // No default — interactive mode runs without a cap (the user presses
      // Esc to stop). Pass a value to enforce a cap; mainly useful with
      // `--print` where there's no human in the loop.
      describe: 'Cap on agent loop iterations per submission (default: unlimited)',
    })
    .option('plan', {
      type: 'boolean',
      default: false,
      // No short alias — `-p` is already `--print`. Plan mode constrains the
      // model to read-only exploration + a plan file until the user approves.
      describe: 'Start the session in plan mode (read-only exploration; user must approve before code edits)',
    })
    .option('plugins', {
      type: 'boolean',
      default: true,
      // Declared as positive `--plugins` (default on) so yargs auto-derives
      // the `--no-plugins` negation. The flag is an escape hatch for
      // diagnosing whether a misbehaving plugin (broken skill, runaway
      // hook, etc.) is the cause of a problem — `--no-plugins` skips
      // loadAllPlugins entirely so only built-in contributions are active.
      describe: 'Enable plugin discovery (default true). `--no-plugins` to disable for one session.',
    })
    .option('hooks', {
      type: 'boolean',
      default: true,
      // Same `--no-hooks` negation pattern as `--plugins`. Plugins still
      // load (skills / agents / mcp contributions still register), only
      // the hook subsystem is skipped — wires `emptyHookBus()` instead
      // of the integration-built one. Use when a slow / runaway hook
      // is suspected, without losing the rest of a plugin's content.
      describe: 'Enable plugin hooks (default true). `--no-hooks` to skip hook execution for one session.',
    })
    .option('plugin-debug', {
      type: 'boolean',
      default: false,
      // Targeted debug output for plugin / hook / marketplace activity.
      // Mirrors the matching debugLog() lines to stderr in addition to the
      // log file, so you can see them live without tailing ~/.x-code/logs/.
      // Equivalent to setting `XC_PLUGIN_DEBUG=1`. Doesn't change behaviour
      // — only changes where the breadcrumbs go.
      describe: 'Mirror plugin / hook / marketplace debug breadcrumbs to stderr (also XC_PLUGIN_DEBUG=1).',
    })
    .option('continue', {
      alias: 'c',
      type: 'boolean',
      default: false,
      describe: 'Resume the most recent session in this project (no picker)',
    })
    .option('resume', {
      alias: 'r',
      type: 'string',
      // Optional value: `xc --resume` (no value) opens the picker; `xc
      // --resume <id-or-slug>` jumps directly to the session whose
      // filename matches. Yargs treats this as a string-typed flag, so
      // `argv.resume === undefined` means "flag not given", `''` means
      // "given without a value", and any other string is the user's
      // lookup key.
      describe: 'Resume a session: `--resume` opens the picker; `--resume <id>` jumps directly',
    })
    .version(VERSION)
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .parse()
}
