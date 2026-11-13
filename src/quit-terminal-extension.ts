import * as PiTui from '@earendil-works/pi-tui'
import { publishQuitTerminal } from './quit-terminal.ts'

publishQuitTerminal(PiTui)

export default function quitTerminalExtension(): void {}
