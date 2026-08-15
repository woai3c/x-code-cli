import type { ManagedProcess } from '../src/tools/shell-session/provider.js'
import {
  forceTerminateManagedShellsSync,
  managedShellTargetCount,
  registerManagedShellTarget,
  unregisterManagedShellTarget,
} from '../src/tools/shell-session/shutdown-target-registry.js'

function processTarget(force: ManagedProcess['forceTreeSync']): ManagedProcess {
  return {
    waitForRootExit: async () => ({}),
    waitForTreeExit: async () => {},
    probeTree: async () => 'live',
    terminateTree: async () => ({
      gracefulAttempted: false,
      forceAttempted: false,
      rootExited: false,
      treeConfirmedExited: false,
    }),
    forceTreeSync: force,
  }
}

describe('managed shell shutdown registry', () => {
  const managerId = 'shutdown-registry-test'
  const ids: string[] = []

  afterEach(() => {
    for (const id of ids.splice(0)) unregisterManagedShellTarget(managerId, id)
  })

  it('uses one absolute deadline and skips targets after it is exhausted', () => {
    const first = 'first'
    const second = 'second'
    ids.push(first, second)
    let firstCalls = 0
    let secondCalls = 0
    registerManagedShellTarget(
      managerId,
      first,
      processTarget(() => {
        firstCalls++
        return 'force-sent-unconfirmed'
      }),
    )
    registerManagedShellTarget(
      managerId,
      second,
      processTarget(() => {
        secondCalls++
        return 'force-sent-unconfirmed'
      }),
    )

    const expired = performance.now() - 1
    const result = forceTerminateManagedShellsSync('double-sigint', expired)

    expect(result.requested).toBeGreaterThanOrEqual(2)
    expect(result.results.filter((entry) => entry.managerInstanceId === managerId)).toEqual([
      { managerInstanceId: managerId, shellId: first, disposition: 'deadline-exhausted' },
      { managerInstanceId: managerId, shellId: second, disposition: 'deadline-exhausted' },
    ])
    expect(firstCalls).toBe(0)
    expect(secondCalls).toBe(0)
  })

  it('isolates provider failures and keeps exact registered identities', () => {
    const before = managedShellTargetCount()
    const failed = 'failed'
    const forced = 'forced'
    ids.push(failed, forced)
    registerManagedShellTarget(
      managerId,
      failed,
      processTarget(() => {
        throw new Error('provider exploded')
      }),
    )
    registerManagedShellTarget(
      managerId,
      forced,
      processTarget(() => 'force-sent-unconfirmed'),
    )
    expect(managedShellTargetCount()).toBe(before + 2)

    const result = forceTerminateManagedShellsSync('fatal-exit', performance.now() + 1_000)
    const own = result.results.filter((entry) => entry.managerInstanceId === managerId)

    expect(own[0]).toMatchObject({ shellId: failed, disposition: 'failed' })
    expect(own[0]?.failure?.message).toBe('provider exploded')
    expect(own[1]).toEqual({ managerInstanceId: managerId, shellId: forced, disposition: 'force-sent-unconfirmed' })
  })
})
