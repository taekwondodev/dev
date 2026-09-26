import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { loadPi } from '../src/pi-runtime.ts'

// A claim enters the report only after the assertions of its own block ran and passed. A
// failing block throws before anything is recorded, so the printed list cannot outrun its
// evidence.
export interface Claims {
  claim<A>(text: string, assertions: () => A | Promise<A>): Promise<A>
  readonly passed: readonly string[]
}

export const makeClaims = (): Claims => {
  const passed: string[] = []
  return {
    passed,
    async claim(text, assertions) {
      if (passed.includes(text)) throw new Error(`Claim recorded twice: ${text}`)
      const value = await assertions()
      passed.push(text)
      return value
    },
  }
}

// Scripts resolve and load the installed global Pi exactly as the launcher does. Modules the
// SDK entry does not export are imported from the same resolved package root, as the
// launcher imports its project-trust resolver.
export const loadInstalledPi = async () => {
  const { api, packageInfo } = await Effect.runPromise(
    loadPi.pipe(Effect.provide(NodeServices.layer))
  )
  const importFromPi = <Module>(path: string): Promise<Module> =>
    import(pathToFileURL(join(packageInfo.root, path)).href)
  return { pi: api, packageInfo, importFromPi }
}
