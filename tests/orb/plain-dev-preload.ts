import { appendFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

const report = process.env.ORB_PLAIN_REPORT
if (report === undefined) throw new Error('ORB_PLAIN_REPORT names the report file')
const record = (line: string): void => appendFileSync(report, `${line}\n`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    if (resolved.url.includes('/src/orb/')) record(`module ${resolved.url}`)
    return resolved
  },
})

const watched = (key: string | symbol): boolean => typeof key === 'string' && key.startsWith('OS_')
process.env = new Proxy(process.env, {
  get(target, key, receiver) {
    if (watched(key)) record(`env ${String(key)}`)
    return Reflect.get(target, key, receiver)
  },
  has(target, key) {
    if (watched(key)) record(`env ${String(key)}`)
    return Reflect.has(target, key)
  },
  getOwnPropertyDescriptor(target, key) {
    if (watched(key)) record(`env ${String(key)}`)
    return Reflect.getOwnPropertyDescriptor(target, key)
  },
})
record('hooks installed')
