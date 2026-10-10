import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Duration, Effect, Option, Schedule, Schema } from 'effect'
import { errorText } from './error-text.ts'
import { acquireExclusiveLock } from './runtime-coordination.ts'
import type { GateRelease } from './workspace-gates.ts'

export class BrowserProfileError extends Schema.TaggedError<BrowserProfileError>()(
  'BrowserProfileError',
  {
    reason: Schema.Literals(['chrome-missing', 'disabled', 'source', 'copy', 'in-use', 'storage']),
    message: Schema.String,
  }
) {}

const fail = (reason: BrowserProfileError['reason'], message: string) =>
  new BrowserProfileError({ reason, message })

export interface BrowserProfilePaths {
  readonly root: string
  readonly userDataDir: string
  readonly lock: string
  readonly gate: string
  readonly locator: string
  readonly disabled: string
  readonly state: string
}

export const browserProfilePaths = (dataHome: string): BrowserProfilePaths => {
  const root = join(dataHome, 'browser')
  return {
    root,
    userDataDir: join(root, 'user-data'),
    lock: join(root, 'profile.sqlite'),
    gate: join(root, 'owner.sqlite'),
    locator: join(root, 'owner.json'),
    disabled: join(root, 'disabled'),
    state: join(root, 'copy-state.json'),
  }
}

export const CHROME_EXECUTABLES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
]

const chromeUserData = (): string => join(homedir(), 'Library/Application Support/Google/Chrome')

export const findChrome = (
  candidates: readonly string[] = CHROME_EXECUTABLES
): string | undefined =>
  candidates.find(candidate => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })

const LocalState = Schema.Struct({
  profile: Schema.optional(
    Schema.Struct({
      last_used: Schema.optional(Schema.String),
    })
  ),
})
const decodeLocalState = Schema.decodeUnknownOption(Schema.fromJsonString(LocalState))

const activeProfileDirectory = (userData: string): string => {
  const localState = join(userData, 'Local State')
  if (!existsSync(localState)) return 'Default'
  const decoded = decodeLocalState(readFileSync(localState, 'utf8'))
  const lastUsed = Option.isSome(decoded) ? decoded.value.profile?.last_used : undefined
  return lastUsed === undefined ||
    lastUsed === '' ||
    lastUsed.includes('/') ||
    lastUsed.includes('..')
    ? 'Default'
    : lastUsed
}

const CopyState = Schema.Struct({
  complete: Schema.Boolean,
  source: Schema.String,
  profileDirectory: Schema.String,
  refreshedAt: Schema.Finite,
})
type CopyState = typeof CopyState.Type
const decodeCopyState = Schema.decodeUnknownOption(Schema.fromJsonString(CopyState))
const encodeCopyState = Schema.encodeSync(Schema.fromJsonString(CopyState))

const AUTHENTICATION_DATABASES = ['Cookies', 'Network/Cookies'] as const
const COPIED_PROFILE_FILES = ['Preferences', 'Secure Preferences', 'Network/TransportSecurity']
const COPIED_PROFILE_DIRECTORIES = ['Local Storage', 'IndexedDB']
const LEVELDB_LOCK = 'LOCK'

export const privateBrowserDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (lstatSync(path).isSymbolicLink())
    throw new Error(`Browser storage must not be a symlink: ${path}`)
  chmodSync(path, 0o700)
}
const privateDirectory = privateBrowserDirectory

const regularSource = (path: string): boolean => {
  try {
    const info = lstatSync(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

const snapshotDatabase = (source: string, destination: string): void => {
  for (const sidecar of ['', '-journal', '-wal', '-shm'])
    rmSync(`${destination}${sidecar}`, { force: true })
  const db = new DatabaseSync(source, { readOnly: true, timeout: 2000 })
  try {
    db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  chmodSync(destination, 0o600)
}

const copyDirectorySnapshot = (source: string, destination: string): void => {
  rmSync(destination, { recursive: true, force: true })
  if (!existsSync(source) || !lstatSync(source).isDirectory()) return
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
    filter: candidate => {
      const name = candidate.split('/').at(-1)
      if (name === LEVELDB_LOCK) return false
      try {
        return !lstatSync(candidate).isSymbolicLink()
      } catch {
        return false
      }
    },
  })
  for (const entry of readdirSync(destination, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    chmodSync(path, entry.isDirectory() ? 0o700 : 0o600)
  }
}

export interface ProfileCopy {
  readonly userDataDir: string
  readonly profileDirectory: string
  readonly source: string
  readonly refreshedAt: number
}

export interface AcquiredProfile {
  readonly copy: ProfileCopy
  readonly chrome: string
  readonly release: () => void
}

export interface BrowserProfileOwner {
  readonly paths: BrowserProfilePaths
  readonly status: Effect.Effect<BrowserProfileStatus, BrowserProfileError>
  readonly disabled: Effect.Effect<boolean, BrowserProfileError>
  readonly acquire: (now: number) => Effect.Effect<AcquiredProfile, BrowserProfileError>
  readonly disable: Effect.Effect<void, BrowserProfileError>
  readonly removeHeldCopy: Effect.Effect<RevocationOutcome, BrowserProfileError>
  readonly revoke: (
    settleWithin: Duration.Duration
  ) => Effect.Effect<RevocationOutcome, BrowserProfileError>
  readonly enable: Effect.Effect<void, BrowserProfileError>
}

export interface BrowserProfileStatus {
  readonly chrome: string | undefined
  readonly source: string
  readonly profileDirectory: string
  readonly enabled: boolean
  readonly copy: CopyState | undefined
  readonly inUse: boolean
}

export const RevocationOutcomeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('removed'), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('already-absent') }),
  Schema.Struct({ kind: Schema.Literal('kept-live'), path: Schema.String }),
])
export type RevocationOutcome = typeof RevocationOutcomeSchema.Type

export interface BrowserProfileOptions {
  readonly dataHome: string
  readonly chromeExecutables?: readonly string[]
  readonly sourceUserData?: string
}

const lockConflict = 'The dev browser profile copy is in use by its browser owner.'
const LOCK_RETRY_INTERVAL = Duration.millis(250)

const withLock = <A>(paths: BrowserProfilePaths, run: (release: GateRelease) => A): A => {
  privateDirectory(paths.root)
  const release = (() => {
    try {
      return acquireExclusiveLock(paths.lock, lockConflict)
    } catch (cause) {
      throw fail('in-use', errorText(cause))
    }
  })()
  try {
    return run(release)
  } catch (cause) {
    release()
    throw cause
  }
}

const native = <A>(operation: () => A): Effect.Effect<A, BrowserProfileError> =>
  Effect.try({
    try: operation,
    catch: cause =>
      cause instanceof BrowserProfileError
        ? cause
        : fail('storage', `Browser profile storage failed: ${errorText(cause)}`),
  })

export const makeBrowserProfileOwner = (options: BrowserProfileOptions): BrowserProfileOwner => {
  const paths = browserProfilePaths(options.dataHome)
  const source = options.sourceUserData ?? chromeUserData()
  const readCopyState = (): CopyState | undefined => {
    if (!regularSource(paths.state)) return undefined
    return Option.getOrUndefined(decodeCopyState(readFileSync(paths.state, 'utf8')))
  }
  const writeCopyState = (state: CopyState): void => {
    writeFileSync(paths.state, `${encodeCopyState(state)}\n`, { mode: 0o600 })
  }
  const refresh = (now: number): { readonly copy: ProfileCopy; readonly chrome: string } => {
    const chrome = findChrome(options.chromeExecutables)
    if (chrome === undefined)
      throw fail(
        'chrome-missing',
        'Google Chrome is not installed in /Applications or ~/Applications; browser rendering is unavailable until it is.'
      )
    if (regularSource(paths.disabled))
      throw fail(
        'disabled',
        'Authenticated browser rendering is disabled for this data home; run `dev browser enable` to allow it again.'
      )
    if (!existsSync(join(source, 'Local State')))
      throw fail(
        'source',
        `No Chrome user data was found at ${source}; sign in to Chrome once so dev can copy an authenticated profile.`
      )
    const profileDirectory = activeProfileDirectory(source)
    const sourceProfile = join(source, profileDirectory)
    if (!existsSync(sourceProfile))
      throw fail('source', `Chrome's active profile directory is missing: ${sourceProfile}`)
    const cookieDatabase = AUTHENTICATION_DATABASES.map(name => join(sourceProfile, name)).find(
      regularSource
    )
    if (cookieDatabase === undefined)
      throw fail('source', `Chrome's active profile has no cookie database: ${sourceProfile}`)
    writeCopyState({ complete: false, source, profileDirectory, refreshedAt: now })
    privateDirectory(paths.userDataDir)
    const destinationProfile = join(paths.userDataDir, profileDirectory)
    privateDirectory(destinationProfile)
    for (const stale of [
      'SingletonLock',
      'SingletonSocket',
      'SingletonCookie',
      'DevToolsActivePort',
    ])
      rmSync(join(paths.userDataDir, stale), { force: true })
    const localState = join(source, 'Local State')
    writeFileSync(join(paths.userDataDir, 'Local State'), readFileSync(localState), { mode: 0o600 })
    try {
      privateDirectory(join(destinationProfile, 'Network'))
      snapshotDatabase(cookieDatabase, join(destinationProfile, 'Cookies'))
      snapshotDatabase(cookieDatabase, join(destinationProfile, 'Network', 'Cookies'))
    } catch (cause) {
      throw fail(
        'copy',
        `Chrome's cookie database could not be snapshotted coherently (${errorText(cause)}); close Chrome or retry in a moment.`
      )
    }
    for (const name of COPIED_PROFILE_FILES) {
      const from = join(sourceProfile, name)
      const to = join(destinationProfile, name)
      if (!regularSource(from)) continue
      privateDirectory(join(to, '..'))
      writeFileSync(to, readFileSync(from), { mode: 0o600 })
    }
    for (const name of COPIED_PROFILE_DIRECTORIES)
      copyDirectorySnapshot(join(sourceProfile, name), join(destinationProfile, name))
    writeCopyState({ complete: true, source, profileDirectory, refreshedAt: now })
    return {
      chrome,
      copy: { userDataDir: paths.userDataDir, profileDirectory, source, refreshedAt: now },
    }
  }
  const removeCopy = (): RevocationOutcome => {
    const present = existsSync(paths.userDataDir)
    if (present) {
      const root = realpathSync(paths.root)
      const real = realpathSync(paths.userDataDir)
      if (real !== root && real.startsWith(`${root}/`))
        rmSync(real, { recursive: true, force: true })
    }
    rmSync(paths.state, { force: true })
    return present ? { kind: 'removed', path: paths.userDataDir } : { kind: 'already-absent' }
  }
  const writeDisabled = (): void => {
    privateDirectory(paths.root)
    closeSync(openSync(paths.disabled, 'a', 0o600))
  }
  return {
    paths,
    disabled: native(() => regularSource(paths.disabled)),
    disable: native(writeDisabled),
    removeHeldCopy: native(removeCopy),
    status: native(() => {
      let inUse = false
      try {
        withLock(paths, release => release())
      } catch (cause) {
        if (cause instanceof BrowserProfileError && cause.reason === 'in-use') inUse = true
        else throw cause
      }
      return {
        chrome: findChrome(options.chromeExecutables),
        source,
        profileDirectory: existsSync(join(source, 'Local State'))
          ? activeProfileDirectory(source)
          : 'Default',
        enabled: !regularSource(paths.disabled),
        copy: readCopyState(),
        inUse,
      }
    }),
    acquire: now => native(() => withLock(paths, release => ({ ...refresh(now), release }))),
    revoke: Effect.fnUntraced(function* (settleWithin: Duration.Duration) {
      yield* native(writeDisabled)
      const keptLive: RevocationOutcome = { kind: 'kept-live', path: paths.userDataDir }
      const removeLockedCopy: Effect.Effect<RevocationOutcome, BrowserProfileError> = native(() =>
        withLock(paths, release => {
          try {
            return removeCopy()
          } finally {
            release()
          }
        })
      ).pipe(
        Effect.catchIf(
          error => error.reason === 'in-use',
          () => Effect.succeed(keptLive)
        )
      )
      return yield* Effect.repeat(removeLockedCopy, {
        schedule: Schedule.spaced(LOCK_RETRY_INTERVAL).pipe(
          Schedule.upTo({ duration: settleWithin })
        ),
        until: outcome => outcome.kind !== 'kept-live',
      })
    }),
    enable: native(() => {
      rmSync(paths.disabled, { force: true })
    }),
  }
}
