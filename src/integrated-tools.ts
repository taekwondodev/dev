export const READ_URL_TOOL = 'read_url'
export const CODEMODE_TOOL = 'codemode'
export const WEB_EXTENSION = 'dev:web'
export const CODEMODE_EXTENSION = 'dev:codemode'
export const ORB_EXTENSION = 'dev:orb'
export const ORB_READ_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'find', 'ls'])
export const ORB_WRITE_TOOLS: ReadonlySet<string> = new Set(['bash', 'write', 'edit'])

export interface ToolOrigin {
  readonly name: string
  readonly sourceInfo: { readonly path: string; readonly source: string }
}

const inlineFrom = (extension: string, tool: ToolOrigin | undefined, name: string): boolean =>
  tool !== undefined &&
  tool.name === name &&
  tool.sourceInfo.source === 'inline' &&
  tool.sourceInfo.path === `<inline:${extension}>`

export const isIntegratedReader = (tool: ToolOrigin | undefined): boolean =>
  inlineFrom(WEB_EXTENSION, tool, READ_URL_TOOL)

export const isIntegratedCodemode = (tool: ToolOrigin | undefined): boolean =>
  inlineFrom(CODEMODE_EXTENSION, tool, CODEMODE_TOOL)

export const orbToolAccess = (tool: ToolOrigin | undefined): 'read' | 'write' | undefined => {
  if (tool === undefined || !inlineFrom(ORB_EXTENSION, tool, tool.name)) return undefined
  if (ORB_READ_TOOLS.has(tool.name)) return 'read'
  if (ORB_WRITE_TOOLS.has(tool.name)) return 'write'
  return undefined
}
