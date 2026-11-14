import type * as PiTui from '../node_modules/@earendil-works/pi-tui/dist/index.js'

type ProgramStatus = PiTui.ProgramStatus
type StatusTerminal = Pick<PiTui.Terminal, 'setProgramStatus'>

export type RestingState =
  | { readonly state: 'done' }
  | { readonly state: 'working' }
  | { readonly state: 'blocked'; readonly message: string }

export interface LeadProgramStatus {
  readonly attach: <T extends StatusTerminal>(terminal: T) => T
  readonly observe: (resting: () => RestingState) => void
  readonly changed: () => void
}

const DONE: RestingState = { state: 'done' }

const sameRest = (left: RestingState, right: RestingState): boolean =>
  left.state === right.state &&
  (left.state !== 'blocked' || (right.state === 'blocked' && left.message === right.message))

export const makeLeadProgramStatus = (): LeadProgramStatus => {
  let resting = (): RestingState => DONE
  let report: ((status: ProgramStatus) => void) | undefined
  let requested: ProgramStatus | undefined
  let shown: RestingState = DONE
  let reconsidering = false

  const show = (status: ProgramStatus): void => {
    if (shown.state === 'done') report?.(status)
    else if (shown.state === 'working') report?.({ ...status, state: 'working' })
    else report?.({ ...status, state: 'blocked', message: shown.message })
  }

  const reconsider = (): void => {
    reconsidering = false
    if (requested?.state !== 'done') return
    const next = resting()
    if (sameRest(next, shown)) return
    shown = next
    show(requested)
  }

  return {
    attach: terminal => {
      report = terminal.setProgramStatus.bind(terminal)
      terminal.setProgramStatus = status => {
        requested = status
        shown = status.state === 'done' ? resting() : DONE
        show(status)
      }
      return terminal
    },
    observe: next => {
      resting = next
    },
    changed: () => {
      if (reconsidering) return
      reconsidering = true
      setImmediate(reconsider)
    },
  }
}
