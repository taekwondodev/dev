const SEPARATOR = /\s*(?:;|&&|\|\||\n)\s*/
const SLEEP = /^sleep(?:\s+\S+)+$/
const FILLER = /^(?:echo|printf)(?:\s.*)?$|^(?:true|:)$/

export const waitOnlyCommand = (command: string): boolean => {
  const segments = command
    .trim()
    .split(SEPARATOR)
    .filter(segment => segment !== '')
  return (
    segments.some(segment => SLEEP.test(segment)) &&
    segments.every(segment => SLEEP.test(segment) || FILLER.test(segment))
  )
}

export const waitRefusal = (running: string): string =>
  `Refused: this command only waits while background work is running (${running}). Outcomes are delivered when your turn ends, so sleeping delays them. Do independent work if any remains; otherwise end your turn now and let outcomes resume you. Use work list or inspect only for diagnosis or a requested progress check.`
