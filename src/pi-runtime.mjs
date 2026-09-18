import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function executablePath() {
  const requested = process.env.DEV_PI_EXECUTABLE ?? 'pi'
  try {
    return realpathSync(execFileSync('which', [requested], { encoding: 'utf8' }).trim())
  } catch (error) {
    throw new Error(
      `Cannot resolve the global Pi executable "${requested}". Set DEV_PI_EXECUTABLE to its installed executable: ${error.message}`,
      { cause: error }
    )
  }
}

export function resolvePiPackage() {
  let current = dirname(executablePath())
  while (current !== dirname(current)) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      const packageJson = JSON.parse(readFileSync(manifest, 'utf8'))
      if (packageJson.name === '@earendil-works/pi-coding-agent' && packageJson.main) {
        return {
          root: current,
          version: packageJson.version,
          packageJson,
          entry: join(current, packageJson.main),
        }
      }
    }
    current = dirname(current)
  }
  throw new Error(
    'The resolved Pi executable is not backed by @earendil-works/pi-coding-agent. No private Pi copy was selected.'
  )
}

export async function loadPi() {
  const packageInfo = resolvePiPackage()
  const api = await import(pathToFileURL(packageInfo.entry).href)
  return { api, packageInfo }
}
