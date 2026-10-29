import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Duration, Effect, Schedule, type Scope } from 'effect'
import { errorText } from '../error-text.ts'
import { orbFailure, type OrbError } from './domain.ts'

export interface SshTarget {
  readonly user: string
  readonly host: string
  readonly keyPath: string
  readonly knownHostsPath: string
  readonly controlPath: string
}

export interface SshReply {
  readonly stdout: Buffer
  readonly stderr: string
  readonly code: number
}

export interface RunOptions {
  readonly input?: string | Buffer
  readonly timeout?: Duration.Input
}

export interface OrbSsh {
  readonly target: SshTarget
  readonly destination: string
  readonly gitSshCommand: string
  run(script: string, options?: RunOptions): Effect.Effect<SshReply, OrbError>
  checked(script: string, options?: RunOptions): Effect.Effect<Buffer, OrbError>
  ttyArgs(script: string): readonly string[]
  spawnTty(script: string): ChildProcessWithoutNullStreams
  spawnPlain(script: string): ChildProcessWithoutNullStreams
  readonly master: Effect.Effect<void, OrbError, Scope.Scope>
}

export const shq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const baseOptions = (target: SshTarget): readonly string[] => [
  '-F',
  '/dev/null',
  '-i',
  target.keyPath,
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'IdentityAgent=none',
  '-o',
  `UserKnownHostsFile=${target.knownHostsPath}`,
  '-o',
  'GlobalKnownHostsFile=/dev/null',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'LogLevel=ERROR',
  '-o',
  `ControlPath=${target.controlPath}`,
]

export const sshOptions = (target: SshTarget): readonly string[] => [
  ...baseOptions(target),
  '-o',
  'ControlMaster=no',
]

export const masterOptions = (target: SshTarget): readonly string[] => [
  ...baseOptions(target),
  '-o',
  'ControlMaster=yes',
  '-o',
  'ControlPersist=no',
  '-N',
]

export const ttyScript = (cwd: string, command: string): string =>
  `stty -onlcr -echo 2>/dev/null; cd ${shq(cwd)} || exit 1; exec bash -c ${shq(command)} </dev/null`

export const sshEnvironment = (): NodeJS.ProcessEnv => {
  const { SSH_AUTH_SOCK: _agent, ...rest } = process.env
  return { ...rest, TERM: 'dumb' }
}

const DEFAULT_TIMEOUT = Duration.minutes(2)
const SSH_FAILED = 255

export const makeOrbSsh = (
  target: SshTarget,
  observe: (reachable: boolean) => void = () => undefined
): OrbSsh => {
  const options = sshOptions(target)
  const destination = `${target.user}@${target.host}`
  const observed = (child: ChildProcessWithoutNullStreams, tty: boolean) => {
    let clientError = false
    if (tty)
      child.stderr.on('data', () => {
        clientError = true
      })
    child.once('close', code => {
      if (code !== null) observe(code !== SSH_FAILED || (tty && !clientError))
    })
    return child
  }
  const run = (script: string, runOptions: RunOptions = {}): Effect.Effect<SshReply, OrbError> =>
    Effect.callback<SshReply, OrbError>(resume => {
      const child = spawn('ssh', [...options, destination, script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sshEnvironment(),
        detached: true,
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.stdin.on('error', () => undefined)
      child.once('error', cause =>
        resume(Effect.fail(orbFailure(`Cannot run ssh: ${errorText(cause)}`, cause)))
      )
      child.once('close', (code, signal) => {
        if (code !== null) observe(code !== SSH_FAILED)
        resume(
          Effect.succeed({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr).toString('utf8'),
            code: code ?? (signal === null ? SSH_FAILED : 128),
          })
        )
      })
      child.stdin.end(runOptions.input)
      return Effect.sync(() => {
        child.kill('SIGKILL')
      })
    }).pipe(
      Effect.timeoutOrElse({
        duration: runOptions.timeout ?? DEFAULT_TIMEOUT,
        orElse: () => Effect.fail(orbFailure(`ssh ${destination} timed out`)),
      })
    )
  const checked = (script: string, runOptions?: RunOptions): Effect.Effect<Buffer, OrbError> =>
    Effect.flatMap(run(script, runOptions), reply =>
      reply.code === 0
        ? Effect.succeed(reply.stdout)
        : Effect.fail(
            orbFailure(
              reply.code === SSH_FAILED
                ? `ssh ${destination} failed: ${reply.stderr.trim() || 'connection error'}`
                : reply.stderr.trim() || `the orb command exited with ${reply.code}`,
              undefined,
              reply.code
            )
          )
    )
  const master = Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn('ssh', [...masterOptions(target), destination], {
        stdio: 'ignore',
        env: sshEnvironment(),
        detached: true,
      })
      const stop = (): void => {
        child.kill('SIGTERM')
      }
      process.once('exit', stop)
      return { child, stop }
    }),
    ({ child, stop }) =>
      Effect.sync(() => {
        process.removeListener('exit', stop)
        child.kill('SIGTERM')
      })
  ).pipe(
    Effect.map(({ child }) => child),
    Effect.flatMap(child =>
      Effect.suspend(() => {
        if (existsSync(target.controlPath)) return Effect.void
        if (child.exitCode === null)
          return Effect.fail(orbFailure('the SSH control connection is not ready'))
        return Effect.fail(orbFailure('the SSH control connection ended'))
      }).pipe(
        Effect.retry({
          schedule: Schedule.spaced(Duration.millis(200)),
          times: 75,
          while: error => error.message.endsWith('not ready'),
        })
      )
    )
  )
  return {
    target,
    destination,
    gitSshCommand: ['ssh', ...options].map(shq).join(' '),
    run,
    checked,
    ttyArgs: script => [...options, '-tt', destination, script],
    spawnPlain: script =>
      observed(
        spawn('ssh', [...options, destination, script], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: sshEnvironment(),
        }),
        false
      ),
    spawnTty: script =>
      observed(
        spawn('ssh', [...options, '-tt', destination, script], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: sshEnvironment(),
        }),
        true
      ),
    master,
  }
}
