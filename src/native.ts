import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorText } from './error-text.ts'

export interface DevNative {
  readonly observeDirectory: (path: string) => readonly [string, string, string]
  readonly filesystem: (path: string) => readonly [string, boolean, string]
  readonly processTable: () => Float64Array
}

const source = fileURLToPath(new URL('./native/dev-native.c', import.meta.url))
const artifactDirectory = fileURLToPath(new URL('../.dev/native/', import.meta.url))
const artifactPattern = /^dev-native-[0-9a-f]+\.node$/

const nodeIncludeDirectory = (): string =>
  join(dirname(dirname(realpathSync(process.execPath))), 'include', 'node')

const artifactName = (): string => {
  const digest = createHash('sha256')
    .update(readFileSync(source))
    .update('\0')
    .update(process.arch)
    .digest('hex')
    .slice(0, 16)
  return `dev-native-${digest}.node`
}

const compile = (output: string): void => {
  const include = nodeIncludeDirectory()
  if (!existsSync(join(include, 'node_api.h')))
    throw new Error(
      `Cannot build the dev native addon: Node headers are missing at ${join(include, 'node_api.h')}. Use a Node.js installation that ships its include directory.`
    )
  try {
    execFileSync(
      'clang',
      [
        '-std=c17',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        `-I${include}`,
        '-o',
        output,
        source,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
    )
  } catch (cause) {
    const stderr =
      typeof cause === 'object' && cause !== null && 'stderr' in cause ? String(cause.stderr) : ''
    throw new Error(
      `Cannot build the dev native addon with the system clang; install the Xcode Command Line Tools with xcode-select --install: ${stderr.trim() || errorText(cause)}`,
      { cause }
    )
  }
}

export const ensureNative = (): string => {
  const name = artifactName()
  const artifact = join(artifactDirectory, name)
  if (!existsSync(artifact)) {
    mkdirSync(artifactDirectory, { recursive: true })
    const temporary = join(artifactDirectory, `.${name}.${randomUUID()}.tmp`)
    try {
      compile(temporary)
      renameSync(temporary, artifact)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  for (const entry of readdirSync(artifactDirectory))
    if (entry !== name && artifactPattern.test(entry))
      rmSync(join(artifactDirectory, entry), { force: true })
  return artifact
}

let loaded: DevNative | undefined

export const native = (): DevNative => {
  loaded ??= createRequire(import.meta.url)(ensureNative()) as DevNative
  return loaded
}
