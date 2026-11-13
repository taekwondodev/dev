import { getCompileCacheDir } from 'node:module'
import { dirname } from 'node:path'

const INHERITED = 'DEV_COMPILE_CACHE_INHERITED'

export const withCompileCache = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const active = getCompileCacheDir()
  if (active === undefined || env.NODE_COMPILE_CACHE !== undefined) return env
  return { ...env, NODE_COMPILE_CACHE: dirname(active), [INHERITED]: '1' }
}

export const adoptCompileCache = (): void => {
  if (process.env[INHERITED] !== '1') return
  delete process.env.NODE_COMPILE_CACHE
  delete process.env[INHERITED]
}
