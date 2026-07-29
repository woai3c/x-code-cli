// ─── UI Theme system ──────────────────────────────────────────────────
//
// Mirrors Claude Code's `/theme` design: the user picks one of six UI
// themes, and that choice drives BOTH the diff background colors AND
// the syntax-highlight palette. Diff bg colors used to be static
// constants — that meant /theme switching had no effect on the diff
// surface, which is the most visible code-display element. Now the
// constants are derived at render time from the active theme.
//
// Each theme also pins a syntax palette (e.g. dark → monokai,
// dark-ansi → ansi). We expose the syntax-palette name on the theme
// object so the startup wiring and `/theme` command stay in one place.
//
// UI chrome colors (spinner, borders, success/error, selection…) do NOT
// live here — they're semantic tokens in `ui/tokens.ts`, which resolves
// dark/light/ansi values from `getTheme()` at call time.
import type { SyntaxThemeName } from './syntax-highlight.js'

export type ThemeName = 'dark' | 'light' | 'dark-daltonized' | 'light-daltonized' | 'dark-ansi' | 'light-ansi'

export interface ThemeColors {
  name: ThemeName
  label: string
  description: string
  /** `#rrggbb` for 24-bit colors, or `'ansi:default'` for the ANSI-only
   *  themes (which leave the bg as terminal default and use dim styling/
   *  decoration-fg to mark `-` lines). render-diff translates these
   *  strings into the right chalk calls.
   *
   *  Values match Claude Code's `native-ts/color-diff/index.ts buildTheme()`
   *  — these are the colors actually painted onto the terminal. The
   *  separate (lighter) values in CC's `utils/theme.ts` are just UI
   *  indicator colors used in the picker preview, not what the diff
   *  body looks like in scrollback. */
  diffAdded: string
  diffRemoved: string
  /** Foreground color for the gutter (line number + `+`/`-` sigil) on
   *  diff rows. CC paints the gutter in a saturated "decoration" color
   *  that pops off the near-black bg — without this, the gutter is
   *  invisible at the depths used for diffAdded/diffRemoved. */
  diffAddedDecoration: string
  diffRemovedDecoration: string
  /** Default fg for unhighlighted text inside diff rows. Mirrors CC's
   *  `Theme.foreground` (color-diff/index.ts:303,334) — `#f8f8f2` on
   *  dark, `#333333` on light. Without this, unmatched chars and
   *  plain `-` lines fall back to the terminal's default white
   *  (typically `#cccccc`), so CC's diff rows look noticeably
   *  brighter. ANSI themes pass `null` — they should honor the user's
   *  16-color terminal palette, not force a hex value. */
  defaultFg: string | null
  /** Which syntax-highlighter palette this theme drives. Picked to
   *  match the theme's overall vibe — daltonized themes use a low-
   *  contrast palette, ANSI themes use the 16-color ansi palette. */
  syntaxPalette: SyntaxThemeName
}

// Theme labels match CC's ThemePicker exactly (just the label string;
// CC has no description field on theme rows). Syntax palette mapping
// also mirrors CC's `defaultSyntaxThemeName` (color-diff/index.ts:182):
// dark* → Monokai, light* → GitHub, *ansi → ansi.
export const THEMES: ThemeColors[] = [
  {
    name: 'dark',
    label: 'Dark mode',
    description: '',
    diffAdded: '#022800',
    diffRemoved: '#3d0100',
    diffAddedDecoration: '#50c850',
    diffRemovedDecoration: '#dc5a5a',
    defaultFg: '#f8f8f2',
    syntaxPalette: 'monokai',
  },
  {
    name: 'light',
    label: 'Light mode',
    description: '',
    diffAdded: '#dcffdc',
    diffRemoved: '#ffdcdc',
    diffAddedDecoration: '#248a3d',
    diffRemovedDecoration: '#cf222e',
    defaultFg: '#333333',
    syntaxPalette: 'github-light',
  },
  {
    name: 'dark-daltonized',
    label: 'Dark mode (colorblind-friendly)',
    description: '',
    diffAdded: '#001b29',
    diffRemoved: '#3d0100',
    diffAddedDecoration: '#51a0c8',
    diffRemovedDecoration: '#dc5a5a',
    defaultFg: '#f8f8f2',
    syntaxPalette: 'monokai',
  },
  {
    name: 'light-daltonized',
    label: 'Light mode (colorblind-friendly)',
    description: '',
    diffAdded: '#dbedff',
    diffRemoved: '#ffdcdc',
    diffAddedDecoration: '#24578a',
    diffRemovedDecoration: '#cf222e',
    defaultFg: '#333333',
    syntaxPalette: 'github-light',
  },
  {
    name: 'dark-ansi',
    label: 'Dark mode (ANSI colors only)',
    description: '',
    diffAdded: 'ansi:default',
    diffRemoved: 'ansi:default',
    diffAddedDecoration: 'ansi:green',
    diffRemovedDecoration: 'ansi:red',
    // CC sets ansi `foreground: ansiIdx(7)` (color-diff/index.ts:296),
    // i.e. it explicitly paints unmatched chars in white. Without
    // this, our `+` row punctuation (`()`, `;`, `.`, `log`) inherits
    // terminal default and reads as visibly less defined than CC's.
    // Chalk `white` produces \e[37m which maps to ansiIdx(7) exactly.
    defaultFg: 'white',
    syntaxPalette: 'ansi',
  },
  {
    name: 'light-ansi',
    label: 'Light mode (ANSI colors only)',
    description: '',
    diffAdded: 'ansi:default',
    diffRemoved: 'ansi:default',
    diffAddedDecoration: 'ansi:green',
    diffRemovedDecoration: 'ansi:red',
    defaultFg: 'white',
    syntaxPalette: 'ansi',
  },
]

export const DEFAULT_THEME: ThemeName = 'dark'

let currentTheme: ThemeName = DEFAULT_THEME

export function setTheme(name: ThemeName): void {
  currentTheme = name
}

export function getTheme(): ThemeName {
  return currentTheme
}

export function getThemeColors(name?: ThemeName): ThemeColors {
  const target = name ?? currentTheme
  return THEMES.find((t) => t.name === target) ?? THEMES[0]!
}

export function parseThemeName(input: unknown): ThemeName | null {
  if (typeof input !== 'string') return null
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
  const aliases: Record<string, ThemeName> = {
    daltonized: 'dark-daltonized',
    colorblind: 'dark-daltonized',
    'colorblind-friendly': 'dark-daltonized',
    ansi: 'dark-ansi',
    'dark-colorblind': 'dark-daltonized',
    'light-colorblind': 'light-daltonized',
  }
  if (normalized in aliases) return aliases[normalized]!
  if (THEMES.some((t) => t.name === normalized)) return normalized as ThemeName
  return null
}
