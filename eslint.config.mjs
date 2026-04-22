import reactHooks from 'eslint-plugin-react-hooks'
import unusedImports from 'eslint-plugin-unused-imports'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// Not using `recommendedTypeChecked` / `projectService: true` — type-aware
// linting would make save-time autofix unreliable (the VS Code ESLint
// extension's code-action timeout is tighter than cold TS project service
// startup). The only type-aware rule we'd benefit from is
// `no-misused-promises`, which isn't worth a broken auto-remove-unused-imports
// on save.
export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.mjs',
      '**/tests/**',
      '**/vitest.config.ts',
    ],
  },
  tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        // Vitest globals
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'unused-imports': unusedImports,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // `unused-imports/no-unused-imports` is the only rule in the ecosystem
      // that autofixes unused code on save. It only covers imports — unused
      // variable declarations have no autofix path and are reported for the
      // user to remove manually (Ctrl+. → "Remove unused declaration") or to
      // silence by prefixing with `_`.
      'unused-imports/no-unused-imports': 'error',
    },
  },
)
