import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import * as PiTui from '@earendil-works/pi-tui'
import { QUIT_TERMINAL_REQUEST, type QuitTerminalAnswer } from './quit-terminal.ts'

export default function quitTerminalExtension(pi: ExtensionAPI): void {
  pi.events.on(QUIT_TERMINAL_REQUEST, answer => {
    ;(answer as QuitTerminalAnswer)(PiTui)
  })
}
