import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import * as PiTui from '@earendil-works/pi-tui'
import { TERMINAL_MODULE_REQUEST, type TerminalModuleAnswer } from './terminal-module.ts'

export default function terminalModuleExtension(pi: ExtensionAPI): void {
  pi.events.on(TERMINAL_MODULE_REQUEST, answer => {
    ;(answer as TerminalModuleAnswer)(PiTui)
  })
}
