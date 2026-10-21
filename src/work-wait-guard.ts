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
  `Refused: this command only waits while background work is running (${running}). Outcomes are delivered when your turn ends, so sleeping delays them. Do independent work if any remains; otherwise end your turn now and let outcomes resume you. Use work list or inspect only for diagnosis or a requested progress check.`

export const sleepRefusal = (): string =>
  `Refused: this command starts with a sleep of ${LONG_SLEEP_SECONDS} seconds or more. Dev does not resume you from a shell sleep; it only blocks your turn. Move the wait itself into work process, for example \`until <check>; do sleep 30; done\`, so that outcome delivery resumes you when the check passes. Then do independent work if any remains; otherwise end your turn now.`
