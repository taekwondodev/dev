export const lastLines = (output: string, count: number): string =>
  output.trimEnd().split('\n').slice(-count).join('\n')

export const fence = (language: string, body: string): string => {
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), match => match[0].length))
  const marks = '`'.repeat(Math.max(3, longest + 1))
  return `${marks}${language}\n${body.trimEnd()}\n${marks}`
}

export const counted = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

export const withoutFinalPeriod = (text: string): string => text.trim().replace(/\.+$/, '')

export const listed = (names: readonly string[]): string =>
  names.map(name => `\`${name}\``).join(', ')

export const cell = (text: string): string => text.replaceAll('|', String.raw`\|`)

export const collapsed = (summary: string, body: string): string =>
  `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
