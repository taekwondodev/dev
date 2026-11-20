const TERMS = String.raw`lead|leaf|leaves|child|children|coordinat(?!e\b)\w*|attempts?|outcomes?|reservations?|(?:un)?reserve[sd]?|admission|admit\w*|grants?|attachments?|handoffs?|bindings?|bound|parked|sweep\w*|swept|gates?|authorit(?:y|ies)|controllers?|workers?|owners?|owned|producer|dispatch rules?|integration targets?|write acquisitions?|acquisitions?|residue|dev-cycle|ADR`

const SUBCOMMAND = String.raw`(?:\[list\]|list|inspect|check|release|resume|set-target|record-publication|artifacts)`
const BEFORE_ARGUMENTS = String.raw`(?:$|\n| [<[|…]| {2}| pre-existing\b)`
const AFTER_DEV = String.raw`(?<=(?-i:\bdev (?:\[options\] |--cwd \S+ )?))`
const WORKSPACE_AS_NAME = [
  String.raw`(?<=\/)workspace`,
  '(?<=`)workspace(?=`)',
  String.raw`${AFTER_DEV}workspace(?=[\]\x60]| \[| ${SUBCOMMAND}\b)`,
  String.raw`workspace(?= ${SUBCOMMAND}${BEFORE_ARGUMENTS}| commands?\b)`,
].join('|')

export const INTERNAL = new RegExp(
  String.raw`\b(${TERMS}|workspaces|(?!${WORKSPACE_AS_NAME})workspace)\b`,
  'i'
)

export const keyWords = (key: string): string =>
  key.replace(/^workspace(?=[A-Z])/, '').replace(/([a-z])([A-Z])/g, '$1 $2')
