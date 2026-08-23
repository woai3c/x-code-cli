import { SLASH_COMMANDS, buildHelpText } from '../src/ui/app/command-content.js'
import { routeSlashCommand } from '../src/ui/app/commands/router.js'

describe('ChatGPT auth slash commands', () => {
  it('advertises login and logout in completion and help', () => {
    const commands = SLASH_COMMANDS.map((command) => command.name)
    expect(commands).toContain('/login')
    expect(commands).toContain('/logout')
    expect(buildHelpText([], [])).toContain('/login')
    expect(buildHelpText([], [])).toContain('/logout')
  })

  it('routes login options and logout to their auth handlers', async () => {
    const login = vi.fn(async () => undefined)
    const logout = vi.fn(async () => undefined)
    const router = { handlers: { login, logout } } as unknown as Parameters<typeof routeSlashCommand>[1]

    await routeSlashCommand('/login --device-auth', router)
    await routeSlashCommand('/logout', router)

    expect(login).toHaveBeenCalledWith('/login --device-auth', '--device-auth')
    expect(logout).toHaveBeenCalledWith('/logout', '')
  })
})
