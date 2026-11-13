import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type * as PiTui from '../node_modules/@earendil-works/pi-tui/dist/index.js'

export type QuitTerminal = Pick<
  typeof PiTui,
  'getCapabilities' | 'getCellDimensions' | 'allocateImageId'
>

export const QUIT_TERMINAL_REQUEST = 'dev/quit-terminal'

export type QuitTerminalAnswer = (terminal: QuitTerminal) => void

export interface QuitTerminalSource {
  readonly answeringExtensionPath: string
  readonly askingExtension: (pi: ExtensionAPI) => void
  readonly current: () => QuitTerminal | undefined
}

export const makeQuitTerminalSource = (): QuitTerminalSource => {
  let terminal: QuitTerminal | undefined
  const answer: QuitTerminalAnswer = answered => {
    terminal = answered
  }
  return {
    answeringExtensionPath: fileURLToPath(new URL('./quit-terminal-extension.ts', import.meta.url)),
    askingExtension: pi => {
      pi.on('session_start', () => {
        pi.events.emit(QUIT_TERMINAL_REQUEST, answer)
      })
    },
    current: () => terminal,
  }
}
