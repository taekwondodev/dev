import type * as PiTui from '../node_modules/@earendil-works/pi-tui/dist/index.js'

export type TerminalImages = Pick<
  typeof PiTui,
  'getCapabilities' | 'getCellDimensions' | 'allocateImageId'
>

const LOADED = Symbol.for('dev:pi-tui')

interface Holder {
  [LOADED]?: TerminalImages
}

export const publishPiTui = (tui: TerminalImages): void => {
  ;(globalThis as Holder)[LOADED] = tui
}

export const loadedPiTui = (): TerminalImages | undefined => (globalThis as Holder)[LOADED]
