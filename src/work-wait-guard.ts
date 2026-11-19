const SEPARATOR = /\s*(?:;|&&|\|\||\n)\s*/
const SLEEP = /^sleep(?:\s+\S+)+$/
const FILLER = /^(?:echo|printf)(?:\s.*)?$|^(?:true|:)$/
const DURATION = /^(\d+(?:\.\d+)?)([smhd]?)$/

export const LONG_SLEEP_SECONDS = 30

const segmentsOf = (command: string): string[] =>
  command
    .trim()
    .split(SEPARATOR)
    .filter(segment => segment !== '')

const unitSeconds = (unit: string | undefined): number => {
  switch (unit) {
    case 'm':
      return 60
    case 'h':
      return 3_600
    case 'd':
      return 86_400
    default:
      return 1
  }
}

const sleepSeconds = (segment: string): number | undefined => {
  const [head, ...args] = segment.split(/\s+/)
  if (head !== 'sleep' || args.length === 0) return undefined
  let total = 0
  for (const arg of args) {
    const match = DURATION.exec(arg)
    if (match === null) return undefined
    total += Number(match[1]) * unitSeconds(match[2])
  }
  return total
}

export const waitOnlyCommand = (command: string): boolean => {
  const segments = segmentsOf(command)
  return (
    segments.some(segment => SLEEP.test(segment)) &&
    segments.every(segment => SLEEP.test(segment) || FILLER.test(segment))
  )
}

export const leadingLongSleep = (command: string): boolean => {
  const [first] = segmentsOf(command)
  if (first === undefined) return false
  const seconds = sleepSeconds(first)
  return seconds !== undefined && seconds >= LONG_SLEEP_SECONDS
}

export const waitRefusal = (running: string): string =>
  `Refused: this command only waits while background work is pending (${running}). Do independent work or end your turn to receive results. Use work list or inspect only to diagnose problems or check progress on request.`

export const sleepRefusal = (): string =>
  `Refused: this command starts with a sleep of ${LONG_SLEEP_SECONDS} seconds or more. Run the wait with work (action: "process"), e.g. \`until <check>; do sleep 30; done\`. Do independent work or end your turn; dev sends the result when ready.`
