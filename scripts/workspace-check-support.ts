import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { loadPi } from '../src/pi-runtime.ts'

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
