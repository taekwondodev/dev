import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve, sep } from 'node:path'
import { StatementSync } from 'node:sqlite'
import { isMainThread } from 'node:worker_threads'

const RELEASE_FAULTS = [
  'after-release-intent',
  'during-selected-files',
  'after-selected-files',
  'after-git-remove',
] as const
export type ReleaseFault = (typeof RELEASE_FAULTS)[number]

const parseFault = (value: string): ReleaseFault => {
  const fault = RELEASE_FAULTS.find(known => known === value)
  if (fault === undefined) throw new Error(`Unknown release fault: ${value}`)
  return fault
}

const boundary = process.env.DEV_RELEASE_FAULT
const checkout = process.env.DEV_RELEASE_FAULT_CHECKOUT

const crash = (): never => process.exit(1)

const startsRelease = (parameter: unknown): boolean => {
  if (typeof parameter !== 'string' || !parameter.startsWith('{')) return false
  try {
    const record: unknown = JSON.parse(parameter)
    return (
      typeof record === 'object' &&
      record !== null &&
      'kind' in record &&
      record.kind === 'release' &&
      'phase' in record &&
      record.phase === 'started'
    )
  } catch {
    return false
  }
}
const removesWorktree = (args: readonly string[] | undefined): boolean =>
  args !== undefined && args.includes('worktree') && args.includes('remove')

const arm = (fault: ReleaseFault, root: string): void => {
  switch (fault) {
    case 'after-release-intent': {
      const { run } = StatementSync.prototype
      StatementSync.prototype.run = function (this: StatementSync, ...parameters: unknown[]) {
        if (parameters.some(startsRelease)) crash()
        return Reflect.apply(run, this, parameters) as ReturnType<StatementSync['run']>
      }
      return
    }
    case 'during-selected-files': {
      const unlink = fs.unlinkSync
      fs.unlinkSync = path => {
        unlink(path)
        if (resolve(String(path)).startsWith(`${root}${sep}`)) crash()
      }
      return
    }
    case 'after-selected-files':
    case 'after-git-remove': {
      const spawn = childProcess.spawnSync
      childProcess.spawnSync = ((command: string, args?: readonly string[], options?: object) => {
        if (removesWorktree(args) && fault === 'after-selected-files') crash()
        const result = spawn(command, args, options)
        if (removesWorktree(args)) crash()
        return result
      }) as typeof childProcess.spawnSync
    }
  }
}

if (!isMainThread && boundary !== undefined && checkout !== undefined) {
  arm(parseFault(boundary), resolve(checkout))
  syncBuiltinESMExports()
}
