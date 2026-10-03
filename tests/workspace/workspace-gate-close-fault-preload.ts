import { existsSync, rmSync } from 'node:fs'
import { sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isMainThread } from 'node:worker_threads'

const arm = process.env.DEV_GATE_CLOSE_FAULT_ARM
const gates = process.env.DEV_GATE_CLOSE_FAULT_GATES

if (!isMainThread && arm !== undefined && gates !== undefined) {
  const { close } = DatabaseSync.prototype
  DatabaseSync.prototype.close = function (this: DatabaseSync) {
    const location = this.isOpen ? this.location() : null
    if (location?.startsWith(`${gates}${sep}`) === true && existsSync(arm)) {
      rmSync(arm)
      throw new Error('injected gate close failure')
    }
    Reflect.apply(close, this, [])
  }
}
