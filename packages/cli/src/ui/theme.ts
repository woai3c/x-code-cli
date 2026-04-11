// @x-code-cli/cli — Shared UI colour tokens
//
// Palette mirrors Claude Code's dark theme (`src/utils/theme.ts` darkTheme).
// All values are hex strings so Ink <Text color={...}> renders them on any
// modern 24-bit terminal.

/** Primary accent — Claude brand orange (`rgb(215,119,87)`) */
export const ACCENT = '#d77757'

/** Muted accent — medium gray, used for secondary labels in the status bar */
export const ACCENT_DIM = '#999999'

/** System spinner blue (`claudeBlue_FOR_SYSTEM_SPINNER = rgb(147,165,255)`) */
export const SPINNER_BLUE = '#93a5ff'

/** Success / completed / diff-added (`success = rgb(78,186,101)`) */
export const SUCCESS = '#4eba65'

/** Warning / permission prompt / pending (`warning = rgb(255,193,7)`) */
export const WARNING = '#ffc107'

/** Error / denied / diff-removed (`error = rgb(255,107,128)`) */
export const ERROR = '#ff6b80'

/** Muted elements — uses named ANSI gray for broad compatibility */
export const DIM = 'gray'

/** Prompt input top/bottom rules (`promptBorder = rgb(136,136,136)`) */
export const PROMPT_BORDER = '#888888'
