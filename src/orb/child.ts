import { Effect } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import type { GitRunner } from '../pi-child.ts'
import type { PiApi } from '../pi-runtime.ts'
import type { OrbReader, OrbReturn } from '../work-domain.ts'
import type { OrbError } from './domain.ts'
import { makeOrbSsh, shq, sshEnvironment, sshOptions } from './ssh.ts'
import { createOrbReaderExtension, createOrbWriterExtension, macHomes } from './tools.ts'
import { orbRepository, returnWork } from './transfer.ts'

export interface OrbReaderOpenInput {
  readonly pi: PiApi
  readonly reader: OrbReader
  readonly cwd: string
  readonly checkout: string
  readonly skillPaths: readonly string[]
  readonly artifacts: readonly string[]
}

export const openOrbReader = (input: OrbReaderOpenInput) => {
  const { reader } = input
  const ssh = makeOrbSsh({
    user: reader.user,
    host: reader.host,
    keyPath: reader.keyPath,
    knownHostsPath: reader.knownHostsPath,
    controlPath: reader.controlPath,
  })
  return {
    extensionFactory: createOrbReaderExtension({
      pi: input.pi,
      ssh,
      cwd: input.cwd,
      homes: macHomes({
        checkout: input.checkout,
        skillPaths: input.skillPaths,
        artifacts: () => input.artifacts,
      }),
      label: reader.label,
    }),
    git: ((args, env) => ({
      file: 'ssh',
      args: [
        ...sshOptions(ssh.target),
        ssh.destination,
        ['env', ...Object.entries(env).map(([name, value]) => `${name}=${value}`), 'git', ...args]
          .map(shq)
          .join(' '),
      ],
      env: sshEnvironment(),
    })) satisfies GitRunner,
  }
}

export interface OrbWriterOpenInput extends OrbReaderOpenInput {
  readonly record: string
  readonly commandPrefix?: string
}

export const openOrbWriter = (input: OrbWriterOpenInput) => {
  const { reader, checkout } = input
  const ssh = makeOrbSsh({
    user: reader.user,
    host: reader.host,
    keyPath: reader.keyPath,
    knownHostsPath: reader.knownHostsPath,
    controlPath: reader.controlPath,
  })
  return {
    extensionFactory: createOrbWriterExtension({
      pi: input.pi,
      ssh,
      cwd: input.cwd,
      homes: macHomes({
        checkout,
        skillPaths: input.skillPaths,
        artifacts: () => input.artifacts,
      }),
      label: reader.label,
      ...(input.commandPrefix === undefined ? {} : { commandPrefix: input.commandPrefix }),
    }),
    returnWork: returnWork({
      root: checkout,
      orbPath: checkout,
      repository: orbRepository(ssh, checkout),
      baseRef: `refs/dev/orb/${input.record}/base`,
      endRef: `refs/dev/orb/${input.record}/end`,
      beforeWrite: Effect.void,
    }).pipe(
      Effect.map((outcome): OrbReturn => {
        switch (outcome.kind) {
          case 'unchanged':
            return outcome
          case 'returned':
            return { kind: 'returned', commits: outcome.commits, files: outcome.files }
          case 'diverged':
            return { kind: 'diverged', reason: outcome.reason }
        }
      })
    ) satisfies Effect.Effect<OrbReturn, OrbError, ChildProcessSpawner.ChildProcessSpawner>,
  }
}
