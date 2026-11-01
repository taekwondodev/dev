import { createSocket } from 'node:dgram'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Effect, type FileSystem } from 'effect'
import type { WorkspaceLifecycle } from '../workspace-domain.ts'
import { openCloud, type Keystone, type Orbit } from './cloud.ts'
import {
  DEFAULT_IMAGE,
  DEFAULT_SIZE,
  readOrbCredentials,
  readStoredOrbFiles,
  writeOrbFiles,
} from './config.ts'
import { deleteOrb, deleteRecorded } from './deletion.ts'
import {
  holdsWork,
  isSpare,
  orbFailure,
  shortId,
  type OrbCredentials,
  type OrbError,
} from './domain.ts'
import { settlePresence } from './recovery.ts'
import { claimRecord, readRecord, recordDirectories } from './registry.ts'

type Cloud = (credentials: OrbCredentials) => {
  readonly keystone: Keystone
  readonly orbit: Orbit
}

const connect = (credentials: OrbCredentials, cloud: Cloud | undefined) =>
  cloud === undefined ? openCloud(credentials) : Effect.succeed(cloud(credentials))

export interface Prompt {
  ask(question: string, hidden?: boolean): Effect.Effect<string, OrbError>
}

export interface SetupOptions {
  readonly dataHome: string
  readonly prompt: Prompt
  readonly print: (line: string) => void
  readonly cloud?: Cloud
  readonly sourceAddress?: (authUrl: string) => Effect.Effect<string | void>
}

const CLEAR = '-'

type Io = Pick<SetupOptions, 'prompt' | 'print'>

const ask = Effect.fnUntraced(function* (
  io: Io,
  label: string,
  current: string | undefined,
  rejection: (answer: string) => string | undefined = () => undefined
): Effect.fn.Return<string, OrbError> {
  for (;;) {
    const answer = yield* io.prompt.ask(
      current === undefined ? `${label}: ` : `${label} [${current}]: `
    )
    const value = answer === '' ? current : answer
    const refused = value === undefined ? 'A value is required.' : rejection(value)
    if (refused === undefined && value !== undefined) return value
    io.print(refused ?? 'A value is required.')
  }
})

const askOptional = Effect.fnUntraced(function* (
  { prompt }: Io,
  label: string,
  current: string | undefined
): Effect.fn.Return<string | undefined, OrbError> {
  const answer = yield* prompt.ask(
    `${label} [${current ?? 'none'}${current === undefined ? '' : `, ${CLEAR} clears`}]: `
  )
  if (answer === CLEAR) return undefined
  return answer === '' ? current : answer
})

const askCount = (io: Io, label: string, current: number) =>
  Effect.map(
    ask(io, label, String(current), answer =>
      /^[1-9]\d*$/.test(answer) ? undefined : 'Enter a whole number greater than 0.'
    ),
    Number
  )

export const isCidr = (text: string): boolean => {
  const [address = '', prefix, ...rest] = text.split('/')
  const family = isIP(address)
  if (family === 0 || prefix === undefined || rest.length > 0 || !/^\d+$/.test(prefix)) return false
  return Number(prefix) <= (family === 4 ? 32 : 128)
}

export const routeSourceAddress = (authUrl: string): Effect.Effect<string | void> =>
  Effect.callback<string | void>(resume => {
    const target = URL.parse(authUrl)
    if (target === null) {
      resume(Effect.void)
      return
    }
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const socket = createSocket(isIP(host) === 6 ? 'udp6' : 'udp4')
    const done = (address: string | undefined): void => {
      socket.close()
      resume(Effect.succeed(address))
    }
    socket.on('error', () => done(undefined))
    socket.connect(Number(target.port || (target.protocol === 'https:' ? 443 : 80)), host, () =>
      done(socket.address().address)
    )
    return Effect.sync(() => {
      socket.removeAllListeners()
      socket.close()
    })
  })

export const setupOrb = Effect.fnUntraced(function* (
  options: SetupOptions
): Effect.fn.Return<void, OrbError, FileSystem.FileSystem> {
  const { prompt, print } = options
  const stored = yield* readStoredOrbFiles(options.dataHome)
  const was = stored.credentials
  print(
    `Configuring dev --orb for the data home ${options.dataHome}. Enter keeps the value in brackets.`
  )
  const authUrl = yield* ask(options, 'Keystone URL', was?.auth_url, answer =>
    URL.canParse(answer) ? undefined : 'Enter an absolute URL, such as http://192.0.2.1/identity.'
  )
  const username = yield* ask(options, 'User', was?.username)
  const projectName = yield* ask(options, 'Project', was?.project_name)
  const userDomain = yield* ask(options, 'User domain id', was?.user_domain_id ?? 'default')
  const projectDomain = yield* ask(
    options,
    'Project domain id',
    was?.project_domain_id ?? 'default'
  )
  const region = yield* askOptional(options, 'Region', was?.region_name)
  const cacert = yield* askOptional(options, 'CA certificate file', was?.cacert)
  let password = was?.password
  for (;;) {
    const answer = yield* prompt.ask(
      password === undefined ? 'Password: ' : 'Password [Enter keeps the stored one]: ',
      true
    )
    if (answer !== '') password = answer
    if (password !== undefined) break
    print('A value is required.')
  }
  const credentials: OrbCredentials = {
    auth_url: authUrl,
    username,
    password,
    project_name: projectName,
    user_domain_id: userDomain,
    project_domain_id: projectDomain,
    ...(region === undefined ? {} : { region_name: region }),
    ...(cacert === undefined ? {} : { cacert }),
  }
  print(`Authenticating as ${username} with Keystone at ${authUrl}…`)
  const token = yield* connect(credentials, options.cloud).pipe(
    Effect.flatMap(({ keystone }) => keystone.token),
    Effect.mapError(error =>
      orbFailure(
        `The credentials were not accepted: ${error.message}\nNothing was written.`,
        error,
        error.status
      )
    )
  )
  print(`Keystone accepted them for project ${token.project.name}; orbit is at ${token.orbitUrl}.`)
  const { config } = stored
  const routed =
    config === undefined ? yield* (options.sourceAddress ?? routeSourceAddress)(authUrl) : undefined
  const cidr = yield* ask(
    options,
    'Network the orbs admit SSH from',
    config?.sshAllowedCidr ?? (routed === undefined ? undefined : `${routed}/32`),
    answer => (isCidr(answer) ? undefined : 'Enter an address with a prefix, such as 192.0.2.1/32.')
  )
  const image = yield* ask(options, 'Orb image', config?.image ?? DEFAULT_IMAGE)
  const size = config?.size ?? DEFAULT_SIZE
  const vcpus = yield* askCount(options, 'Orb vCPUs', size.vcpus)
  const memory = yield* askCount(options, 'Orb memory in MB', size.memory_mb)
  const disk = yield* askCount(options, 'Orb disk in GB', size.disk_gb)
  const written = yield* writeOrbFiles(options.dataHome, {
    credentials,
    config: {
      size: { vcpus, memory_mb: memory, disk_gb: disk },
      image,
      ssh_allowed_cidr: cidr,
    },
  })
  print(`Wrote ${written.join(' and ')}. dev --orb is ready.`)
})

export interface DeleteOptions {
  readonly dataHome: string
  readonly orbId: string
  readonly lifecycle: Pick<WorkspaceLifecycle, 'inspect' | 'writeBranch' | 'settleOrbPresence'>
  readonly print: (line: string) => void
  readonly cloud?: Cloud
}

const gone = (error: OrbError) => error.status === 404

const findRecord = Effect.fnUntraced(function* (dataHome: string, orbId: string) {
  for (const directory of yield* recordDirectories(dataHome)) {
    if (!existsSync(join(directory, 'record.json'))) continue
    const record = yield* readRecord(directory).pipe(
      Effect.mapError(error =>
        orbFailure(
          `${error.message}\nIt may name orb ${shortId(orbId)} of a running session, so nothing was deleted.`,
          error
        )
      )
    )
    if (record.orbId === orbId) return { directory, spare: isSpare(record) }
  }
  return undefined
})

export const deleteOrbById = Effect.fnUntraced(function* (
  options: DeleteOptions
): Effect.fn.Return<void, OrbError, FileSystem.FileSystem> {
  const { orbId, print } = options
  const label = shortId(orbId)
  const credentials = yield* readOrbCredentials(options.dataHome)
  const { keystone, orbit } = yield* connect(credentials, options.cloud)
  const token = yield* keystone.token
  const found = yield* findRecord(options.dataHome, orbId)
  if (found === undefined) {
    yield* deleteOrb(orbit, orbId, print).pipe(
      Effect.catchIf(gone, () =>
        Effect.fail(
          orbFailure(`orbit has no orb ${orbId} in project ${token.project.name}`, undefined, 404)
        )
      )
    )
    return
  }
  const claim = yield* claimRecord(found.directory)
  if (claim.kind === 'owned')
    return yield* orbFailure(
      found.spare
        ? `Orb ${label} is the spare orb of a running dev --orb session, which releases it when it quits; nothing was deleted.`
        : `Orb ${label} belongs to a running dev --orb session, which deletes it when it quits; nothing was deleted.`
    )
  if (claim.kind === 'incomplete')
    return yield* orbFailure(`The record of orb ${label} vanished meanwhile; nothing was deleted.`)
  const { record } = claim
  const fields = record.current()
  if (
    fields.keystone.authUrl !== credentials.auth_url ||
    fields.keystone.projectId !== token.project.id
  ) {
    yield* record.release
    return yield* orbFailure(
      `Orb ${label} belongs to project ${fields.keystone.projectName} at ${fields.keystone.authUrl}, not to the project of the OpenStack credentials; nothing was deleted.`
    )
  }
  if (holdsWork(fields))
    print(
      `Orb ${label} holds work that has not returned to ${fields.checkout}; deleting the orb discards it.`
    )
  yield* deleteRecorded(orbit, record, orbId, print).pipe(
    Effect.catchIf(gone, () =>
      Effect.sync(() => print(`orb ${label} no longer exists in orbit`)).pipe(
        Effect.andThen(record.remove)
      )
    ),
    Effect.ensuring(record.release)
  )
  print(`Removed the record of orb ${label}.`)
  yield* settlePresence({ lifecycle: options.lifecycle, print }, fields)
})

const interrupted = () => orbFailure('Cancelled; nothing was written.', undefined, 130)

export const terminalPrompt: Prompt = {
  ask: (question, hidden = false) =>
    hidden
      ? Effect.callback<string, OrbError>(resume => {
          const input = process.stdin
          let answer = ''
          let escaping = false
          const finish = (result: Effect.Effect<string, OrbError>): void => {
            input.off('data', onData)
            input.setRawMode(false)
            input.pause()
            process.stdout.write('\n')
            resume(result)
          }
          const onData = (chunk: Buffer): void => {
            for (const character of chunk.toString('utf8')) {
              if (escaping) {
                escaping = !/[A-Za-z~]/.test(character)
                continue
              }
              if (character === '\u001b') {
                escaping = true
                continue
              }
              if (character === '\r' || character === '\n') return finish(Effect.succeed(answer))
              if (character === '\u0003' || character === '\u0004')
                return finish(Effect.fail(interrupted()))
              if (character === '\u007f' || character === '\b') answer = answer.slice(0, -1)
              else if (character >= ' ') answer += character
            }
          }
          process.stdout.write(question)
          input.setRawMode(true)
          input.resume()
          input.on('data', onData)
          return Effect.sync(() => {
            input.off('data', onData)
            input.setRawMode(false)
            input.pause()
          })
        })
      : Effect.callback<string, OrbError>(resume => {
          const reader = createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
          })
          let answered = false
          reader.on('SIGINT', () => {
            answered = true
            process.stdout.write('\n')
            reader.close()
            resume(Effect.fail(interrupted()))
          })
          reader.on('close', () => {
            if (!answered) resume(Effect.fail(interrupted()))
          })
          reader.question(question, line => {
            answered = true
            reader.close()
            resume(Effect.succeed(line.trim()))
          })
          return Effect.sync(() => reader.close())
        }),
}
