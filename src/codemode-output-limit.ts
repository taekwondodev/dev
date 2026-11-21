import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type * as CodemodeSource from '../node_modules/@earendil-works/pi-codemode/dist/source.js'
import { CODEMODE_TOOL, isIntegratedCodemode } from './integrated-tools.ts'
import { PiError, importPiModule } from './pi-runtime.ts'

export const CODEMODE_OUTPUT_TOKENS = 25_000

export type ParseCodemodeSource = typeof CodemodeSource.parseCodemodeSource

export const withOutputLimit = (parse: ParseCodemodeSource, source: string): string => {
  let parsed: CodemodeSource.ParsedCodemodeSource
  try {
    parsed = parse(source)
  } catch {
    return source
  }
  const { maxOutputTokens, timeoutMs } = parsed.options
  if (maxOutputTokens !== undefined) return source
  const options = JSON.stringify({
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
    max_output_tokens: CODEMODE_OUTPUT_TOKENS,
  })
  const line = `// @options: ${options}`
  return parsed.code === source ? `${line}\n${source}` : `${line}${parsed.code}`
}

export const loadCodemodeOutputLimit = Effect.fnUntraced(function* (packageRoot: string) {
  const { parseCodemodeSource } = yield* Effect.tryPromise({
    try: () =>
      importPiModule<typeof CodemodeSource>(join(packageRoot, '../pi-codemode/dist/source.js')),
    catch: cause => new PiError({ message: 'Cannot load Pi codemode source parsing', cause }),
  })
  if (typeof parseCodemodeSource !== 'function')
    return yield* new PiError({ message: 'Installed Pi does not provide codemode source parsing' })
  const factory: Pi.ExtensionFactory = pi => {
    pi.on('tool_call', event => {
      if (event.toolName !== CODEMODE_TOOL) return undefined
      const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
      const { code } = event.input
      if (isIntegratedCodemode(tool) && typeof code === 'string')
        event.input.code = withOutputLimit(parseCodemodeSource, code)
      return undefined
    })
  }
  return factory
})
