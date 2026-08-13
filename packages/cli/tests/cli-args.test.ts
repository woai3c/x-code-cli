import { parseCliArgs } from '../src/cli-args.js'

describe.sequential('peer CLI arguments', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  async function parse(...args: string[]) {
    process.argv = ['node', 'x-code', ...args]
    return parseCliArgs()
  }

  it('does not expose a separate peer-messaging flag', async () => {
    const argv = await parse()
    expect(argv).not.toHaveProperty('peer-messaging')
  })

  it('parses the advertised peer name', async () => {
    expect((await parse('--name', 'frontend')).name).toBe('frontend')
  })
})
