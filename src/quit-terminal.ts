import type * as PiTui from '../node_modules/@earendil-works/pi-tui/dist/index.js'

export type QuitTerminal = Pick<
  typeof PiTui,
  'getCapabilities' | 'getCellDimensions' | 'allocateImageId'
>

const PUBLISHED = Symbol.for('dev:quit-terminal')

interface Holder {
  [PUBLISHED]?: QuitTerminal
}

export const publishQuitTerminal = (terminal: QuitTerminal): void => {
  ;(globalThis as Holder)[PUBLISHED] = terminal
}

export const quitTerminal = (): QuitTerminal | undefined => (globalThis as Holder)[PUBLISHED]
