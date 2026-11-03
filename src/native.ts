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
  readonly renameExclusive: (from: string, to: string) => boolean
}

const source = fileURLToPath(new URL('./native/dev-native.c', import.meta.url))
const artifactDirectory = fileURLToPath(new URL('../.dev/native/', import.meta.url))
const artifactPattern = /^dev-native-[0-9a-f]+\.node$/

const compilerFlags = [
  '-std=c17',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-bundle',
  '-undefined',
  'dynamic_lookup',
] as const

const nodeIncludeDirectory = (): string =>
  join(dirname(dirname(realpathSync(process.execPath))), 'include', 'node')

const artifactName = (include: string): string => {
  const hash = createHash('sha256').update(readFileSync(source))
  for (const input of [process.arch, process.versions.node, include, ...compilerFlags])
    hash.update('\0').update(input)
  return `dev-native-${hash.digest('hex').slice(0, 16)}.node`
}

const compilerOutput = (cause: unknown): string => {
  const stderr =
    typeof cause === 'object' && cause !== null && 'stderr' in cause ? cause.stderr : undefined
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  return text === '' ? errorText(cause) : text
}

const compile = (include: string, output: string): void => {
  if (!existsSync(join(include, 'node_api.h')))
    throw new Error(
      `Cannot build the dev native addon: Node headers are missing at ${join(include, 'node_api.h')}. Use a Node.js installation that ships its include directory.`
    )
  try {
    execFileSync('clang', [...compilerFlags, `-I${include}`, '-o', output, source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
  } catch (cause) {
    throw new Error(
      `Cannot build the dev native addon with the system clang; install the Xcode Command Line Tools with xcode-select --install: ${compilerOutput(cause)}`,
      { cause }
    )
  }
}

export const ensureNative = (): string => {
  const include = nodeIncludeDirectory()
  const name = artifactName(include)
  const artifact = join(artifactDirectory, name)
  if (!existsSync(artifact)) {
    mkdirSync(artifactDirectory, { recursive: true })
    const temporary = join(artifactDirectory, `.${name}.${randomUUID()}.tmp`)
    try {
      compile(include, temporary)
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

let loaded: { readonly addon: DevNative } | { readonly failure: unknown } | undefined

export const native = (): DevNative => {
  if (loaded === undefined) {
    try {
      loaded = {
        addon: createRequire(import.meta.url)(ensureNative()) as DevNative,
      }
    } catch (failure) {
      loaded = { failure }
    }
  }
  if ('failure' in loaded) throw loaded.failure
  return loaded.addon
}
