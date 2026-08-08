type SettingsScope = 'user' | 'project'

export function parseScopeFlag(arg: string, defaultScope: SettingsScope): { value: string; scope: SettingsScope }
export function parseScopeFlag(arg: string): { value: string; scope: SettingsScope | undefined }
export function parseScopeFlag(
  arg: string,
  defaultScope?: SettingsScope,
): { value: string; scope: SettingsScope | undefined } {
  const tokens = arg.split(/\s+/).filter(Boolean)
  let scope = defaultScope
  const remaining: string[] = []
  for (const token of tokens) {
    const match = token.match(/^(?:--scope|-s)(?:=(.+))?$/)
    if (match) {
      const value = match[1]?.toLowerCase()
      if (value === 'user' || value === 'project') scope = value
      continue
    }
    remaining.push(token)
  }
  return { value: remaining.join(' '), scope }
}
