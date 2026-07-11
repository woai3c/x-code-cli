import path from 'node:path'

/** Package managers run workspace scripts from the package directory while
 *  preserving the user's invocation directory in INIT_CWD. Restore it before
 *  the CLI loads project-scoped state so dev runs match the installed binary. */
export function restoreInvocationCwd(
  initCwd: string | undefined = process.env.INIT_CWD,
  chdir: (directory: string) => void = process.chdir,
): boolean {
  if (!initCwd || !path.isAbsolute(initCwd)) return false
  try {
    chdir(initCwd)
    return true
  } catch {
    return false
  }
}
