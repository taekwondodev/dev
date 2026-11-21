import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
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

const PI_EXAMPLE = '"max_output_tokens": 10000'

const withLimitExample = (description: string): string =>
  description.replace(PI_EXAMPLE, `"max_output_tokens": ${CODEMODE_OUTPUT_TOKENS}`)

export const showingOutputLimit =
  (codemode: Pi.ExtensionFactory): Pi.ExtensionFactory =>
  pi =>
    codemode({
      ...pi,
      registerTool: tool =>
        pi.registerTool({
          ...tool,
          prepareLoadout: loadout => {
            const changes = tool.prepareLoadout?.(loadout)
            const described = changes?.descriptions?.[CODEMODE_TOOL]
            return changes === undefined || described === undefined
              ? changes
              : {
                  ...changes,
                  descriptions: {
                    ...changes.descriptions,
                    [CODEMODE_TOOL]: withLimitExample(described),
                  },
                }
          },
        }),
    })

const CUT_HEADER =
  /^Warning: truncated output \(original token count: (\d+)\)\nTotal output lines: (\d+)\n\n/
const OMISSION = /…(\d+) tokens truncated…/g
const CHARS_PER_TOKEN = 4

const lineBreaks = (text: string): number => text.split('\n').length - 1

const keptByPi = (kept: string, half: number): boolean =>
  kept.length === half || kept.length === half - 1

export const withRecoveryHint = (text: string, path: string): string => {
  const cut = CUT_HEADER.exec(text)
  if (cut === null) return text
  const [header, tokens, total] = cut
  const noteAt = text.lastIndexOf(`\n\n[Full output: ${path} (read with offset/limit)]`)
  if (noteAt < header.length) return text
  const shown = text.slice(header.length, noteAt)
  const kept = [...shown.matchAll(OMISSION)]
    .map(marker => ({
      head: shown.slice(0, marker.index),
      tail: shown.slice(marker.index + marker[0].length),
      half: ((Number(tokens) - Number(marker[1])) * CHARS_PER_TOKEN) / 2,
    }))
    .find(({ head, tail, half }) => keptByPi(head, half) && keptByPi(tail, half))
  if (kept === undefined) return text
  const first = lineBreaks(kept.head) + 1
  const last = Number(total) - lineBreaks(kept.tail)
  const [where, them] =
    first === last ? [`line ${first}`, 'that line'] : [`lines ${first}-${last}`, 'those lines']
  const hint = `The missing text is in ${where} of ${total}. The full output is saved in ${path}; to see ${them} without running the script again, read that file with offset ${first} and limit ${last - first + 1}.`
  return `${header.slice(0, -1)}${hint}\n\n${text.slice(header.length)}`
}

const savedOutputPath = (details: unknown): string | undefined =>
  Predicate.isObject(details) && typeof details.fullOutputPath === 'string'
    ? details.fullOutputPath
    : undefined

export const loadCodemodeOutputLimit = Effect.fnUntraced(function* (packageRoot: string) {
  const { parseCodemodeSource } = yield* Effect.tryPromise({
    try: () =>
      importPiModule<typeof CodemodeSource>(join(packageRoot, '../pi-codemode/dist/source.js')),
    catch: cause => new PiError({ message: 'Cannot load Pi codemode source parsing', cause }),
  })
  if (typeof parseCodemodeSource !== 'function')
    return yield* new PiError({
      message: 'Installed Pi does not provide codemode source parsing',
    })
  const factory: Pi.ExtensionFactory = pi => {
    pi.on('tool_call', event => {
      if (event.toolName !== CODEMODE_TOOL) return undefined
      const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
      const { code } = event.input
      if (isIntegratedCodemode(tool) && typeof code === 'string')
        event.input.code = withOutputLimit(parseCodemodeSource, code)
      return undefined
    })
    pi.on('tool_result', event => {
      if (event.toolName !== CODEMODE_TOOL) return undefined
      const path = savedOutputPath(event.details)
      if (path === undefined) return undefined
      const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
      if (!isIntegratedCodemode(tool)) return undefined
      let changed = false
      const content = event.content.map(item => {
        if (item.type !== 'text') return item
        const text = withRecoveryHint(item.text, path)
        changed ||= text !== item.text
        return { ...item, text }
      })
      if (!changed) return undefined
      return event.structuredContent === undefined
        ? { content }
        : { content, structuredContent: event.structuredContent }
    })
  }
  return factory
})
