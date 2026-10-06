import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { isMainThread } from 'node:worker_threads'

const RELEASE_FAULTS = ['before-git-remove', 'after-git-remove', 'clock-after-git-remove'] as const
export type ReleaseFault = (typeof RELEASE_FAULTS)[number]

const parseFault = (value: string): ReleaseFault => {
  const fault = RELEASE_FAULTS.find(known => known === value)
  if (fault === undefined) throw new Error(`Unknown release fault: ${value}`)
  return fault
}

const boundary = process.env.DEV_RELEASE_FAULT
const checkout = process.env.DEV_RELEASE_FAULT_CHECKOUT

const crash = (): never => process.exit(1)

const removesWorktree = (args: readonly string[] | undefined): boolean =>
  args !== undefined && args.includes('worktree') && args.includes('remove')

const arm = (fault: ReleaseFault): void => {
  const spawn = childProcess.spawnSync
  if (fault === 'clock-after-git-remove') {
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    childProcess.spawnSync = ((command: string, args?: readonly string[], options?: object) => {
      const result = spawn(command, args, options)
      if (removesWorktree(args)) offset = 3_600_000
      return result
    }) as typeof childProcess.spawnSync
    return
  }
  childProcess.spawnSync = ((command: string, args?: readonly string[], options?: object) => {
    if (removesWorktree(args) && fault === 'before-git-remove') crash()
    const result = spawn(command, args, options)
    if (removesWorktree(args)) crash()
    return result
  }) as typeof childProcess.spawnSync
}

if (!isMainThread && boundary !== undefined && checkout !== undefined) {
  arm(parseFault(boundary))
  syncBuiltinESMExports()
}
