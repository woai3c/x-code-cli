import {
  WindowsSupervisorFrameDecoder,
  WindowsSupervisorFrameKind,
  encodeWindowsSupervisorFrame,
  encodeWindowsSupervisorLaunch,
  quoteWindowsCommandArgument,
} from '../src/tools/shell-session/providers/windows-supervisor-protocol.js'

describe('Windows shell supervisor protocol', () => {
  it('decodes fragmented and coalesced binary frames without touching output bytes', () => {
    const first = encodeWindowsSupervisorFrame(WindowsSupervisorFrameKind.stdout, Buffer.from([0, 1, 2, 255]))
    const second = encodeWindowsSupervisorFrame(WindowsSupervisorFrameKind.treeEmpty)
    const bytes = Buffer.concat([first, second])
    const decoder = new WindowsSupervisorFrameDecoder()

    expect(decoder.push(bytes.subarray(0, 7))).toEqual([])
    const frames = decoder.push(bytes.subarray(7))

    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ kind: WindowsSupervisorFrameKind.stdout, payload: Buffer.from([0, 1, 2, 255]) })
    expect(frames[1]).toEqual({ kind: WindowsSupervisorFrameKind.treeEmpty, payload: Buffer.alloc(0) })
    expect(() => decoder.end()).not.toThrow()
  })

  it('rejects bad magic, version, oversized length, and truncated EOF', () => {
    const badMagic = encodeWindowsSupervisorFrame(WindowsSupervisorFrameKind.force)
    badMagic[0] = 0
    expect(() => new WindowsSupervisorFrameDecoder().push(badMagic)).toThrow(/magic/)

    const badVersion = encodeWindowsSupervisorFrame(WindowsSupervisorFrameKind.force)
    badVersion[4] = 99
    expect(() => new WindowsSupervisorFrameDecoder().push(badVersion)).toThrow(/protocol mismatch/)

    const tooLarge = encodeWindowsSupervisorFrame(WindowsSupervisorFrameKind.force)
    tooLarge.writeUInt32LE(64 * 1024 * 1024 + 1, 8)
    expect(() => new WindowsSupervisorFrameDecoder().push(tooLarge)).toThrow(/exceeds/)

    const truncated = new WindowsSupervisorFrameDecoder()
    truncated.push(encodeWindowsSupervisorFrame(WindowsSupervisorFrameKind.stdout, Buffer.from('x')).subarray(0, -1))
    expect(() => truncated.end()).toThrow(/truncated/)
  })

  it('encodes a launch request and quotes Windows arguments', () => {
    const launch = encodeWindowsSupervisorLaunch({
      cwd: 'C:\\work dir',
      application: 'C:\\Program Files\\PowerShell\\pwsh.exe',
      commandLine: 'pwsh.exe -Command test',
    })
    expect(launch.subarray(0, 4).toString('ascii')).toBe('XCSH')
    expect(quoteWindowsCommandArgument('plain')).toBe('plain')
    expect(quoteWindowsCommandArgument('two words')).toBe('"two words"')
    expect(quoteWindowsCommandArgument('')).toBe('""')
    expect(quoteWindowsCommandArgument('a"b')).toBe('"a\\"b"')
    expect(quoteWindowsCommandArgument('C:\\path with space\\')).toBe('"C:\\path with space\\\\"')
  })
})
