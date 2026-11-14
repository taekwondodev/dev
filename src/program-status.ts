import type * as PiTui from '../node_modules/@earendil-works/pi-tui/dist/index.js'

type ProgramStatus = PiTui.ProgramStatus
type StatusTerminal = Pick<PiTui.Terminal, 'setProgramStatus'>

export interface LeadProgramStatus {
  readonly attach: <T extends StatusTerminal>(terminal: T) => T
  readonly observe: (willReactivate: () => boolean) => void
  readonly changed: () => void
}

const nothingPending = (): boolean => false

export const makeLeadProgramStatus = (): LeadProgramStatus => {
  let willReactivate = nothingPending
  let report: ((status: ProgramStatus) => void) | undefined
  let requested: ProgramStatus | undefined
  let withheld = false
  let reconsidering = false

  const show = (status: ProgramStatus): void => {
    report?.(withheld ? { ...status, state: 'working' } : status)
  }

  const reconsider = (): void => {
    reconsidering = false
    if (requested?.state !== 'done') return
    const next = willReactivate()
    if (next === withheld) return
    withheld = next
    show(requested)
  }

  return {
    attach: terminal => {
      report = terminal.setProgramStatus.bind(terminal)
      terminal.setProgramStatus = status => {
        requested = status
        withheld = status.state === 'done' && willReactivate()
        show(status)
      }
      return terminal
    },
    observe: next => {
      willReactivate = next
    },
    changed: () => {
      if (reconsidering) return
      reconsidering = true
      setImmediate(reconsider)
    },
  }
}
