export type Replacement =
  | { readonly kind: 'reword'; readonly wording: string }
  | { readonly kind: 'leave-out' }

export interface TermGroup {
  readonly pattern: string
  readonly replacement: Replacement
}

const SUBCOMMAND = String.raw`(?:\[list\]|list|inspect|check|release|resume|set-target|record-publication|artifacts)`
const BEFORE_ARGUMENTS = String.raw`(?:$|\n| [<[|…]| {2}| pre-existing\b)`
const AFTER_DEV = String.raw`(?<=(?-i:\bdev (?:\[options\] |--cwd \S+ )?))`
const WORKSPACE_AS_NAME = [
  String.raw`(?<=\/)workspace`,
  '(?<=`)workspace(?=`)',
  String.raw`${AFTER_DEV}workspace(?=[\]\x60]| \[| ${SUBCOMMAND}\b)`,
  String.raw`workspace(?= ${SUBCOMMAND}${BEFORE_ARGUMENTS}| commands?\b)`,
].join('|')

const reword = (pattern: string, wording: string): TermGroup => ({
  pattern,
  replacement: { kind: 'reword', wording },
})

export const TERM_GROUPS: readonly TermGroup[] = [
  reword('lead', 'this conversation'),
  reword(
    String.raw`leaf|leaves|child|children|coordinat(?!e\b)\w*`,
    'delegated agent; one that may or may not delegate further'
  ),
  reword('attempts?', 'run'),
  reword('outcomes?', 'result'),
  reword(
    String.raw`workspace reservations?|reservations?|(?:un)?reserve[sd]?`,
    'checkout kept for a task'
  ),
  reword(
    String.raw`admission|admit\w*|grants?|write acquisitions?|acquisitions?`,
    'permission to write'
  ),
  reword(
    'attachments?|workspace handoffs?|handoffs?|bindings?|bound|parked',
    'the checkout this conversation uses; switching checkouts'
  ),
  reword(String.raw`sweep\w*|swept`, 'automatic cleanup'),
  reword('gates?', 'lock'),
  reword(
    String.raw`workspace authorit(?:y|ies)|authorit(?:y|ies)|controllers?|workers?|owners?|owned|producer`,
    'dev'
  ),
  reword('dispatch rules?', 'configured model and effort'),
  reword('integration targets?', 'destination branch'),
  reword('residue', 'unfinished work'),
  { pattern: 'dev-cycle|ADR', replacement: { kind: 'leave-out' } },
  reword(
    `workspaces|(?!${WORKSPACE_AS_NAME})workspace`,
    'checkout; `workspace` only names the tool and the command'
  ),
]

export const INTERNAL = new RegExp(
  String.raw`\b(?:${TERM_GROUPS.map(({ pattern }) => `(${pattern})`).join('|')})\b`,
  'i'
)

export interface InternalTerm {
  readonly term: string
  readonly replacement: Replacement
}

export const internalTerm = (text: string): InternalTerm | undefined => {
  const match = INTERNAL.exec(text)
  if (match === null) return undefined
  const group = TERM_GROUPS[match.slice(1).findIndex(captured => captured !== undefined)]
  if (group === undefined) throw new Error(`No term group captured "${match[0]}"`)
  return { term: match[0], replacement: group.replacement }
}

export const keyWords = (key: string): string =>
  key.replace(/^workspace(?=[A-Z])/, '').replace(/([a-z])([A-Z])/g, '$1 $2')
