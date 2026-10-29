import { realpathSync } from 'node:fs'
import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { constants as osConstants, tmpdir } from 'node:os'
import { Effect, Option, Schema } from 'effect'
import type {
  BashOperations,
  EditOperations,
  ExtensionAPI,
  ExtensionContext,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent'
import type { PiApi } from '../pi-runtime.ts'
import { errorText } from '../error-text.ts'
import { isWithin } from '../workspace-paths.ts'
import { orbFailure } from './domain.ts'
import { shq, ttyScript, type OrbSsh } from './ssh.ts'

export interface MacHomes {
  readonly read: (path: string) => boolean
  readonly write: (path: string) => boolean
}

const insideAny = (roots: readonly string[], path: string): boolean =>
  roots.some(root => isWithin(root, path))

const SPILL_FILE = /^pi-[a-z]+-[0-9a-f]{16}\.[a-z0-9]+$/

export const macHomes = (input: {
  readonly checkout: string
  readonly skillPaths: readonly string[]
  readonly artifacts: () => readonly string[]
}): MacHomes => {
  const temporary = new Set([tmpdir(), realOrSelf(tmpdir())])
  const skills = input.skillPaths.filter(path => !isWithin(input.checkout, path))
  return {
    read: path =>
      (temporary.has(dirname(path)) && SPILL_FILE.test(basename(path))) ||
      insideAny([...skills, ...input.artifacts()], path),
    write: path => insideAny(input.artifacts(), path),
  }
}

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export interface OrbToolsInput {
  readonly pi: PiApi
  readonly ssh: OrbSsh
  readonly cwd: string
  readonly homes: MacHomes
  readonly label: string
  readonly status: () => string
  readonly describe: () => string
  readonly sync: () => Promise<string>
  readonly commandPrefix?: string
}

const GREP_LIMIT = 100
const STATUS_KEY = 'dev:orb'

class RemoteFileError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

const remote = (ssh: OrbSsh, script: string, input?: string | Buffer): Promise<Buffer> =>
  Effect.runPromise(ssh.checked(script, input === undefined ? {} : { input }))

const probe = async (ssh: OrbSsh, script: string): Promise<number> =>
  Effect.runPromise(
    ssh
      .run(script)
      .pipe(
        Effect.flatMap(reply =>
          reply.code === 255
            ? Effect.fail(orbFailure(`ssh ${ssh.destination} failed: ${reply.stderr.trim()}`))
            : Effect.succeed(reply.code)
        )
      )
  )

const accessScript = (path: string, writable: boolean): string =>
  `p=${shq(path)}; [ -e "$p" ] || exit 2; [ -r "$p" ] || exit 3${writable ? '; [ -w "$p" ] || exit 3' : ''}`

const remoteAccess = async (ssh: OrbSsh, path: string, writable: boolean): Promise<void> => {
  const code = await probe(ssh, accessScript(path, writable))
  if (code === 2) throw new RemoteFileError(`ENOENT: no such file on the orb: ${path}`, 'ENOENT')
  if (code !== 0)
    throw new RemoteFileError(`EACCES: permission denied on the orb: ${path}`, 'EACCES')
}

const sniffImage = (head: Buffer): string | undefined => {
  const hex = head.toString('hex')
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png'
  if (hex.startsWith('ffd8ff')) return 'image/jpeg'
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return undefined
}

const readOperations = (ssh: OrbSsh, homes: MacHomes): ReadOperations => ({
  readFile: path => (homes.read(path) ? readFile(path) : remote(ssh, `cat -- ${shq(path)}`)),
  access: path =>
    homes.read(path) ? access(path, constants.R_OK) : remoteAccess(ssh, path, false),
  detectImageMimeType: async path => {
    if (homes.read(path)) {
      const head = (await readFile(path)).subarray(0, 12)
      return sniffImage(head) ?? null
    }
    return sniffImage(await remote(ssh, `head -c 12 -- ${shq(path)}`)) ?? null
  },
})

const writeOperations = (ssh: OrbSsh, homes: MacHomes): WriteOperations => ({
  writeFile: (path, content) =>
    homes.write(path)
      ? writeFile(path, content)
      : remote(ssh, `cat > ${shq(path)}`, content).then(() => undefined),
  mkdir: dir =>
    homes.write(dir)
      ? mkdir(dir, { recursive: true }).then(() => undefined)
      : remote(ssh, `mkdir -p -- ${shq(dir)}`).then(() => undefined),
})

const editOperations = (ssh: OrbSsh, homes: MacHomes): EditOperations => {
  const reads = readOperations(ssh, homes)
  const writes = writeOperations(ssh, homes)
  return {
    readFile: reads.readFile,
    writeFile: writes.writeFile,
    access: path =>
      homes.write(path)
        ? access(path, constants.R_OK | constants.W_OK)
        : remoteAccess(ssh, path, true),
  }
}

const lsOperations = (ssh: OrbSsh): LsOperations => {
  const listed = new Map<string, boolean>()
  return {
    exists: async path => (await probe(ssh, `[ -e ${shq(path)} ]`)) === 0,
    stat: async path => {
      const known = listed.get(path)
      if (known !== undefined) {
        listed.delete(path)
        return { isDirectory: () => known }
      }
      const code = await probe(ssh, `p=${shq(path)}; [ -e "$p" ] || exit 2; [ -d "$p" ] || exit 1`)
      if (code === 2) throw new RemoteFileError(`ENOENT: ${path}`, 'ENOENT')
      return { isDirectory: () => code === 0 }
    },
    readdir: async path => {
      const output = await remote(
        ssh,
        `find ${shq(path)} -mindepth 1 -maxdepth 1 -printf '%Y %f\\0'`
      )
      const names: string[] = []
      for (const entry of output.toString('utf8').split('\0')) {
        if (entry.length < 3) continue
        const name = entry.slice(2)
        listed.set(`${path.replace(/\/+$/, '')}/${name}`, entry[0] === 'd')
        names.push(name)
      }
      return names
    },
  }
}

const findOperations = (ssh: OrbSsh): FindOperations => ({
  exists: async path => (await probe(ssh, `[ -e ${shq(path)} ]`)) === 0,
  glob: async (pattern, cwd, { ignore, limit }) => {
    const excluded = ignore.map(glob => `--glob ${shq(`!${glob}`)}`).join(' ')
    const output = await remote(
      ssh,
      `rg --files --hidden --no-config --no-messages --glob ${shq(pattern)} ${excluded} -- ${shq(cwd)} | head -n ${Math.max(1, Math.floor(limit))}; exit 0`
    )
    return output
      .toString('utf8')
      .split('\n')
      .filter(line => line.length > 0)
  },
})

const sshTtyError = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? (signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0))

export const orbBashOperations = (ssh: OrbSsh): BashOperations => ({
  exec: (command, cwd, { onData, signal, timeout }) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('aborted'))
        return
      }
      const child = ssh.spawnTty(ttyScript(cwd, command))
      let aborted = false
      let timedOut = false
      child.stdin.on('error', () => undefined)
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      const stop = (): void => {
        child.kill('SIGTERM')
      }
      const onAbort = (): void => {
        aborted = true
        stop()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer =
        timeout === undefined || timeout <= 0
          ? undefined
          : setTimeout(() => {
              timedOut = true
              stop()
            }, timeout * 1000)
      child.once('error', cause => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(cause)
      })
      child.once('close', (code, exitSignal) => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        child.stdin.destroy()
        if (aborted) reject(new Error('aborted'))
        else if (timedOut) reject(new Error(`timeout:${timeout}`))
        else resolve({ exitCode: sshTtyError(code, exitSignal) })
      })
    }),
})

const RgEventSchema = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    data: Schema.optional(
      Schema.Struct({
        path: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
        line_number: Schema.optional(Schema.NullOr(Schema.Finite)),
        lines: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
      })
    ),
  })
)
const decodeRgEvent = Schema.decodeUnknownOption(RgEventSchema)

interface GrepInput {
  readonly pattern: string
  readonly path?: string
  readonly glob?: string
  readonly ignoreCase?: boolean
  readonly literal?: boolean
  readonly context?: number
  readonly limit?: number
}

const grepScript = (input: GrepInput, searchPath: string): string => {
  const context = input.context !== undefined && input.context > 0 ? Math.floor(input.context) : 0
  const flags = [
    '--no-config',
    '--json',
    '--line-number',
    '--color=never',
    '--hidden',
    ...(input.ignoreCase === true ? ['--ignore-case'] : []),
    ...(input.literal === true ? ['--fixed-strings'] : []),
    ...(context > 0 ? ['--context', String(context)] : []),
    ...(input.glob === undefined ? [] : ['--glob', input.glob]),
  ]
  return [
    `p=${shq(searchPath)}`,
    '[ -e "$p" ] || { echo "Path not found: $p" >&2; exit 64; }',
    'if [ -d "$p" ]; then echo D; else echo F; fi',
    `rg ${flags.map(shq).join(' ')} -- ${shq(input.pattern)} "$p"`,
    's=$?; [ $s -le 1 ] && exit 0; exit $s',
  ].join('\n')
}

const runGrep = (
  pi: PiApi,
  ssh: OrbSsh,
  input: GrepInput,
  searchPath: string,
  signal: AbortSignal | undefined
): Promise<{ text: string; details: Record<string, unknown> | undefined }> =>
  new Promise((resolve, reject) => {
    const limit = Math.max(1, input.limit ?? GREP_LIMIT)
    const spawned = ssh.spawnPlain(grepScript(input, searchPath))
    spawned.stdin.on('error', () => undefined)
    spawned.stdin.end()
    const lines: string[] = []
    let kind: 'D' | 'F' | undefined
    let matches = 0
    let limited = false
    let truncatedLines = false
    let aborted = false
    let stderr = ''
    const onAbort = (): void => {
      aborted = true
      spawned.kill('SIGTERM')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const format = (path: string): string => {
      if (kind === 'D') {
        const rel = relative(searchPath, path)
        if (rel.length > 0 && !rel.startsWith('..')) return rel
      }
      return basename(path)
    }
    const reader = createInterface({ input: spawned.stdout })
    reader.on('line', line => {
      if (kind === undefined) {
        kind = line.trim() === 'D' ? 'D' : 'F'
        return
      }
      if (limited) return
      const event = decodeRgEvent(line)
      if (Option.isNone(event)) return
      const { type, data } = event.value
      if (type !== 'match' && type !== 'context') return
      const path = data?.path?.text
      const number = data?.line_number
      if (path === undefined || typeof number !== 'number') return
      const raw = (data?.lines?.text ?? '').replace(/\r?\n$/, '').replace(/\r/g, '')
      const { text, wasTruncated } = pi.truncateLine(raw)
      if (wasTruncated) truncatedLines = true
      if (type === 'match') {
        matches += 1
        lines.push(`${format(path)}:${number}: ${text}`)
        if (matches >= limit) {
          limited = true
          spawned.kill('SIGTERM')
        }
      } else lines.push(`${format(path)}-${number}- ${text}`)
    })
    spawned.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    spawned.once('error', cause => {
      signal?.removeEventListener('abort', onAbort)
      reject(cause)
    })
    spawned.once('close', code => {
      signal?.removeEventListener('abort', onAbort)
      reader.close()
      if (aborted) {
        reject(new Error('Operation aborted'))
        return
      }
      if (!limited && code !== 0) {
        reject(new Error(stderr.trim() || `ripgrep on the orb exited with code ${code}`))
        return
      }
      if (matches === 0) {
        resolve({ text: 'No matches found', details: undefined })
        return
      }
      const truncation = pi.truncateHead(lines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
      const notices: string[] = []
      const details: Record<string, unknown> = {}
      if (limited) {
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`
        )
        details.matchLimitReached = limit
      }
      if (truncation.truncated) {
        notices.push(`${pi.formatSize(pi.DEFAULT_MAX_BYTES)} limit reached`)
        details.truncation = truncation
      }
      if (truncatedLines) {
        notices.push('Some lines truncated. Use read tool to see full lines')
        details.linesTruncated = true
      }
      resolve({
        text:
          notices.length === 0
            ? truncation.content
            : `${truncation.content}\n\n[${notices.join('. ')}]`,
        details: Object.keys(details).length > 0 ? details : undefined,
      })
    })
  })

type OrbReadersInput = Pick<OrbToolsInput, 'pi' | 'ssh' | 'cwd' | 'homes'>

const registerReaders = (api: ExtensionAPI, { pi, ssh, cwd, homes }: OrbReadersInput): void => {
  api.registerTool(pi.createReadToolDefinition(cwd, { operations: readOperations(ssh, homes) }))
  api.registerTool({
    ...pi.createFindToolDefinition(cwd, { operations: findOperations(ssh) }),
    defaultActive: false,
  })
  api.registerTool({
    ...pi.createLsToolDefinition(cwd, { operations: lsOperations(ssh) }),
    defaultActive: false,
  })
  const grep = pi.createGrepToolDefinition(cwd)
  api.registerTool({
    ...grep,
    defaultActive: false,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (signal?.aborted === true) throw new Error('Operation aborted')
      const base = context?.cwd ?? cwd
      const target = params.path === undefined || params.path === '' ? '.' : params.path
      const searchPath = target.startsWith('/') ? target : `${base.replace(/\/+$/, '')}/${target}`
      const result = await runGrep(pi, ssh, params, searchPath, signal)
      return { content: [{ type: 'text', text: result.text }], details: result.details }
    },
  })
}

const describeTools = (api: ExtensionAPI, text: string): void => {
  api.on('before_agent_start', (event, context) => {
    const line = `Current working directory: ${context.cwd}`
    if (!event.systemPrompt.includes(line)) return undefined
    return { systemPrompt: event.systemPrompt.replace(line, `${line}\n${text}`) }
  })
}

export interface OrbReaderInput extends OrbReadersInput {
  readonly label: string
}

export const createOrbReaderExtension =
  (input: OrbReaderInput) =>
  (api: ExtensionAPI): void => {
    registerReaders(api, input)
    describeTools(
      api,
      `The read, grep, find, ls and git_inspect tools read ${input.label} over SSH, at the same absolute paths as on the Mac: the orb holds the current files, uncommitted ones included. Only tool output spill files, skill files and the task artifact directory are read on the Mac.`
    )
  }

export const createOrbExtension =
  (input: OrbToolsInput) =>
  (api: ExtensionAPI): void => {
    const { pi, ssh, cwd, homes } = input
    const bash = orbBashOperations(ssh)
    api.registerTool(
      pi.createBashToolDefinition(cwd, {
        operations: bash,
        ...(input.commandPrefix === undefined ? {} : { commandPrefix: input.commandPrefix }),
      })
    )
    registerReaders(api, input)
    api.registerTool(pi.createWriteToolDefinition(cwd, { operations: writeOperations(ssh, homes) }))
    api.registerTool(pi.createEditToolDefinition(cwd, { operations: editOperations(ssh, homes) }))

    const showStatus = (context: ExtensionContext): void => {
      if (context.hasUI) context.ui.setStatus(STATUS_KEY, input.status())
    }
    api.on('session_start', (_event, context) => showStatus(context))
    api.on('tool_execution_end', (_event, context) => showStatus(context))
    api.on('user_bash', (_event, context) => ({
      operations: {
        exec: (command, directory, options) =>
          bash.exec(command, directory, options).finally(() => showStatus(context)),
      },
    }))
    describeTools(
      api,
      `The bash, read, write, edit, grep, find and ls tools run on ${input.label} over SSH, at the same absolute paths as on the Mac, and so do ! commands, work processes and the read-only tools of delegated agents. The orb has no Internet access and no interactive terminal. Only tool output spill files, skill files and the task artifact directory stay on the Mac. Work returns to the Mac checkout when the user runs /orb sync and at quit.`
    )
    api.registerCommand('orb', {
      description: 'Show the orb of this session, or return its work with /orb sync',
      handler: async (args, context) => {
        const command = args.trim()
        let text = 'Usage: /orb [sync]'
        if (command === '') text = input.describe()
        else if (command === 'sync')
          text = await input
            .sync()
            .catch((cause: unknown) => `orb sync failed: ${errorText(cause)}`)
        if (context.hasUI) {
          showStatus(context)
          api.sendMessage(
            { customType: 'dev/orb', content: text, display: true },
            { triggerTurn: false }
          )
        } else process.stderr.write(`${text}\n`)
      },
    })
  }
