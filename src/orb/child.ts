import type { GitRunner } from '../pi-child.ts'
import type { PiApi } from '../pi-runtime.ts'
import type { OrbReader } from '../work-domain.ts'
import { makeOrbSsh, shq, sshEnvironment, sshOptions } from './ssh.ts'
import { createOrbReaderExtension, macHomes } from './tools.ts'

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
