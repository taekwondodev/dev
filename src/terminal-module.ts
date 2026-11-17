import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type * as PiTui from '../node_modules/@earendil-works/pi-tui/dist/index.js'

export type TerminalModule = Pick<
  typeof PiTui,
  'ProcessTerminal' | 'getCapabilities' | 'getCellDimensions' | 'allocateImageId'
>

export const TERMINAL_MODULE_REQUEST = 'dev/terminal-module'

export type TerminalModuleAnswer = (terminalModule: TerminalModule) => void

export interface TerminalModuleSource {
  readonly answeringExtensionPath: string
  readonly askingExtension: (pi: ExtensionAPI) => void
  readonly current: () => TerminalModule | undefined
}

export const makeTerminalModuleSource = (): TerminalModuleSource => {
  let terminalModule: TerminalModule | undefined
  const answer: TerminalModuleAnswer = answered => {
    terminalModule = answered
  }
  return {
    answeringExtensionPath: fileURLToPath(
      new URL('./terminal-module-extension.ts', import.meta.url)
    ),
    askingExtension: pi => {
      pi.events.emit(TERMINAL_MODULE_REQUEST, answer)
    },
    current: () => terminalModule,
  }
}

const CELL_SIZE_REPLY = /\[6;(\d+);(\d+)t/
const CELL_SIZE_WAIT_MS = 300

interface CellSize {
  readonly widthPx: number
  readonly heightPx: number
}

const awaitCellSize = (
  input: NodeJS.ReadStream,
  out: NodeJS.WriteStream
): Effect.Effect<CellSize> =>
  Effect.callback<CellSize>(resume => {
    let reply = ''
    const onData = (data: Buffer): void => {
      reply += data.toString('latin1')
      const match = CELL_SIZE_REPLY.exec(reply)
      if (match === null) return
      input.removeListener('data', onData)
      resume(Effect.succeed({ heightPx: Number(match[1]), widthPx: Number(match[2]) }))
    }
    input.on('data', onData)
    out.write('\x1b[16t')
    return Effect.sync(() => {
      input.removeListener('data', onData)
    })
  })

const askCellSize = (input: NodeJS.ReadStream, out: NodeJS.WriteStream): Effect.Effect<CellSize> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const raw = input.isRaw
      input.setRawMode(true)
      input.resume()
      return raw
    }),
    () => awaitCellSize(input, out),
    raw =>
      Effect.sync(() => {
        input.setRawMode(raw)
        input.pause()
      })
  )

export const loadStartupTerminalModule = (
  packageRoot: string,
  input: NodeJS.ReadStream,
  out: NodeJS.WriteStream
): Effect.Effect<
  Pick<TerminalModule, 'getCapabilities' | 'getCellDimensions' | 'allocateImageId'> | undefined
> =>
  Effect.gen(function* () {
    if (input.isTTY !== true || out.isTTY !== true) return undefined
    const loaded = yield* Effect.tryPromise(
      (): Promise<typeof PiTui> =>
        import(pathToFileURL(join(dirname(packageRoot), 'pi-tui', 'dist', 'index.js')).href)
    ).pipe(Effect.option)
    if (Option.isNone(loaded)) return undefined
    const tui = loaded.value
    if (tui.getCapabilities().images !== 'kitty') return tui
    const cell = Option.getOrElse(
      yield* askCellSize(input, out).pipe(Effect.timeoutOption(CELL_SIZE_WAIT_MS)),
      () => ({ widthPx: 0, heightPx: 0 })
    )
    return {
      getCapabilities: tui.getCapabilities,
      getCellDimensions: () => cell,
      allocateImageId: tui.allocateImageId,
    }
  })
