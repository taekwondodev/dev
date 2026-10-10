export const READ_URL_TOOL = 'read_url'
export const CODEMODE_TOOL = 'codemode'
export const WEB_EXTENSION = 'dev:web'
export const CODEMODE_EXTENSION = 'dev:codemode'

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
