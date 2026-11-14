import { fileURLToPath } from 'node:url'
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
