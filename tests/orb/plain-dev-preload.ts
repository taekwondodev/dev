import fs, { appendFileSync } from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

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

const ORB_FILES = new Set(['openstack.json', 'orb.json'])
const touch = (path: unknown): void => {
  const name = path instanceof URL ? path.pathname : String(path)
  if (ORB_FILES.has(basename(name))) record(`file ${name}`)
}
const watched = <T extends object>(target: T, names: readonly string[]): void => {
  for (const name of names) {
    const original = Reflect.get(target, name) as (...args: unknown[]) => unknown
    Reflect.set(target, name, (...args: unknown[]) => {
      touch(args[0])
      return original.apply(target, args)
    })
  }
}
watched(fs, ['open', 'openSync', 'readFile', 'readFileSync', 'stat', 'statSync', 'existsSync'])
watched(fs.promises, ['open', 'readFile', 'stat'])
syncBuiltinESMExports()
record('hooks installed')
