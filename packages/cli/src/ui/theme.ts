// @x-code/cli — Shared UI colour tokens
//
// Soft colour palette inspired by Claude Code's dark theme.
// All colours are hex values so they render consistently across terminals
// that support 24-bit colour (most modern terminals).
// Ink <Text color={...}> accepts hex strings natively.

/** Primary accent — soft sky-blue */
export const ACCENT = '#89b4fa'

/** Muted / dimmed accent — for unselected or less prominent items */
export const ACCENT_DIM = '#6a8fc7'

/** Success / completed / diff-added — soft green */
export const SUCCESS = '#a6e3a1'

/** Warning / permission prompt / pending — warm yellow */
export const WARNING = '#f9e2af'

/** Error / denied / diff-removed — soft red-pink */
export const ERROR = '#f38ba8'

/** Muted elements — uses named ANSI gray for broad compatibility */
export const DIM = 'gray'
