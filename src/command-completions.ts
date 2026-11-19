import type { AutocompleteItem } from '@earendil-works/pi-tui'

export interface CommandVerb {
  readonly verb: string
  readonly arguments?: string
  readonly description: string
}

export const verbCompletions =
  (verbs: readonly CommandVerb[]) =>
  (prefix: string): AutocompleteItem[] | null => {
    if (/\s/.test(prefix)) return null
    const items = verbs
      .filter(({ verb }) => verb.startsWith(prefix))
      .map(({ verb, arguments: args, description }) => ({
        value: args === undefined ? verb : `${verb} `,
        label: args === undefined ? verb : `${verb} ${args}`,
        description,
      }))
    return items.length === 0 ? null : items
  }
