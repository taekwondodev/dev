import { homedir } from 'node:os'
import { sep } from 'node:path'

const control = (character: string): boolean =>
  character < ' ' || (character >= '\u007F' && character <= '\u009F')

export const printable = (text: string): boolean => ![...text].some(control)

export const dropControls = (text: string): string =>
  [...text].filter(character => !control(character)).join('')

export const withoutControls = (text: string): string =>
  [...text].map(character => (control(character) ? '?' : character)).join('')

export const displayPath = (path: string): string => {
  const home = homedir()
  return withoutControls(
    path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
  )
}

export const ago = (now: number, at: number): string => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}
