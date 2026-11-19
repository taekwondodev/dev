import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'
import type * as JsonSchema from 'effect/JsonSchema'
import * as Schema from 'effect/Schema'
import { DocumentLink, RetrievalMethod, type DocumentSlice } from './web-documents.ts'
import { READ_URL_TOOL } from './integrated-tools.ts'
import type { ReadOutcome, WebReader } from './web-reader.ts'

const InputSchema = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  continuation: Schema.optionalKey(Schema.String),
  maxChars: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
type ReadUrlInput = typeof InputSchema.Type

const inputDescriptions: { readonly [Field in keyof ReadUrlInput]-?: string } = {
  url: 'Absolute http(s) URL. Omit with continuation.',
  continuation: 'Token from a prior result. Read more of the same saved text without refetching.',
  maxChars: 'Chars per part (default 16000; 1000–120000).',
}

const describe = (
  schema: JsonSchema.JsonSchema,
  descriptions: Readonly<Record<string, string>>
): JsonSchema.JsonSchema => {
  const properties = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))
  )(schema.properties)
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([field, property]) => [
        field,
        Object.hasOwn(descriptions, field)
          ? { description: descriptions[field], ...property }
          : property,
      ])
    ),
  }
}

export const readUrlParameters = describe(
  Schema.toJsonSchemaDocument(InputSchema, { onExcessProperty: 'error' }).schema,
  inputDescriptions
)

export const ReadUrlResultSchema = Schema.Struct({
  outcome: Schema.Literals(['document', 'partial', 'failed']),
  requestedUrl: Schema.optionalKey(Schema.String),
  finalUrl: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(RetrievalMethod),
  status: Schema.optionalKey(Schema.Int),
  text: Schema.String,
  offset: Schema.Int,
  end: Schema.Int,
  totalChars: Schema.Int,
  complete: Schema.Boolean,
  continuation: Schema.optionalKey(Schema.String),
  links: Schema.Array(DocumentLink),
  suggestions: Schema.Array(DocumentLink),
  limitations: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.String),
})
export type ReadUrlResult = typeof ReadUrlResultSchema.Type

const resultDescriptions: { readonly [Field in keyof ReadUrlResult]-?: string } = {
  outcome:
    'document: final part, no text cut; partial: more text via continuation or the page hit a size limit; failed: no text read.',
  requestedUrl: 'URL requested.',
  finalUrl: 'URL after redirects.',
  title: 'Page title, if provided.',
  method: 'markdown or text from the site, html extracted locally, or browser (Chrome).',
  status: 'HTTP status of the final response.',
  text: 'Readable page text, often Markdown.',
  offset: 'Starting character offset in the saved text.',
  end: 'End offset (exclusive).',
  totalChars: 'Total characters in the saved page text.',
  complete: 'True for the last part if nothing was cut.',
  continuation: 'Pass as continuation for the next part of the saved text.',
  links: 'Page links with absolute URLs.',
  suggestions: 'Other pages to try, such as llms.txt; not the requested page.',
  limitations: 'Size limits, HTTP errors, blocked requests or notes about Chrome.',
  error: 'Why the read failed.',
}

export const readUrlOutputSchema = describe(
  Schema.toJsonSchemaDocument(ReadUrlResultSchema).schema,
  resultDescriptions
)

const RETURNED_LINKS = 200
const LINKS_IN_TEXT = 40

export const toResult = (outcome: ReadOutcome): ReadUrlResult => {
  if (outcome.kind === 'failed')
    return {
      outcome: 'failed',
      text: '',
      offset: 0,
      end: 0,
      totalChars: 0,
      complete: false,
      links: [],
      suggestions: [],
      limitations: outcome.limitations,
      error: outcome.error,
    }
  const { slice } = outcome
  const { document } = slice
  const complete = slice.complete && !document.bodyTruncated
  return {
    outcome: complete ? 'document' : 'partial',
    requestedUrl: document.requestedUrl,
    finalUrl: document.finalUrl,
    ...(document.title === undefined ? {} : { title: document.title }),
    method: document.method,
    ...(document.status === undefined ? {} : { status: document.status }),
    text: slice.text,
    offset: slice.offset,
    end: slice.end,
    totalChars: document.text.length,
    complete,
    ...(slice.continuation === undefined ? {} : { continuation: slice.continuation }),
    links: document.links.slice(0, RETURNED_LINKS),
    suggestions: document.suggestions,
    limitations: document.limitations,
  }
}

const rangeNote = (result: ReadUrlResult): string => {
  if (result.continuation !== undefined) return `; pass continuation: "${result.continuation}"`
  return result.complete ? ' (complete)' : ' (size limit; no more text)'
}

const opensWith = ({ text, complete }: DocumentSlice, title: string): boolean => {
  const newline = text.indexOf('\n')
  if (newline === -1 && !complete) return false
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  return firstLine.replace(/^#+\s+/, '').trim() === title.trim()
}

const URL_CLOSERS: Readonly<Record<string, string>> = { '(': ')', '<': '>', '"': '"', "'": "'" }

const startsUrl = (text: string, start: number): boolean =>
  start === 0 || /[\s(<"'[`>]/.test(text[start - 1] ?? '')

const endsUrl = (text: string, start: number, end: number, atDocumentEnd: boolean): boolean => {
  const next = text[end]
  if (next === undefined) return atDocumentEnd
  const closer = URL_CLOSERS[text[start - 1] ?? '']
  if (closer !== undefined) return next === closer || (closer === ')' && /\s/.test(next))
  if (/[\s)>\]"<`]/.test(next)) return true
  if (!/[.,;:!?]/.test(next)) return false
  const afterPunctuation = text[end + 1]
  return afterPunctuation === undefined ? atDocumentEnd : /\s/.test(afterPunctuation)
}

const showsUrl = ({ text, complete }: DocumentSlice, url: string): boolean => {
  for (let at = text.indexOf(url); at !== -1; at = text.indexOf(url, at + 1))
    if (startsUrl(text, at) && endsUrl(text, at, at + url.length, complete)) return true
  return false
}

const header = (slice: DocumentSlice, result: ReadUrlResult): string => {
  const { document } = slice
  const { title } = document
  const lines = [
    ...(title === undefined || opensWith(slice, title) ? [] : [`# ${title}`]),
    `Source: ${document.finalUrl}${document.finalUrl === document.requestedUrl ? '' : ` (requested ${document.requestedUrl})`} · ${document.method}`,
    `Characters ${slice.offset}-${slice.end} of ${document.text.length}${rangeNote(result)}`,
  ]
  if (document.limitations.length > 0)
    lines.push(...document.limitations.map(limitation => `Limitation: ${limitation}`))
  return lines.join('\n')
}

const linksTextOmits = (slice: DocumentSlice): readonly DocumentLink[] =>
  slice.document.links.slice(0, LINKS_IN_TEXT).filter(link => !showsUrl(slice, link.url))

export const toText = (outcome: ReadOutcome, result: ReadUrlResult): string => {
  if (outcome.kind === 'failed')
    return `read_url failed: ${result.error ?? 'unknown failure'}${
      result.limitations.length > 0 ? `\n${result.limitations.join('\n')}` : ''
    }`
  const { slice } = outcome
  const parts = [header(slice, result), '', slice.text]
  if (slice.offset === 0) {
    const links = linksTextOmits(slice)
    if (links.length > 0)
      parts.push(
        '',
        `Links (${links.length} of ${slice.document.links.length}):`,
        ...links.map(link => (link.text === '' ? `- ${link.url}` : `- ${link.text}: ${link.url}`))
      )
    if (result.suggestions.length > 0)
      parts.push(
        '',
        'Suggestions:',
        ...result.suggestions.map(link => `- ${link.text}: ${link.url}`)
      )
  }
  return parts.join('\n')
}

const decodeInput = Schema.decodeUnknownEffect(InputSchema)

export const READ_URL_DESCRIPTION =
  'Read a public documentation page and return text with sources. Prefer Markdown from the site, or extract HTML locally. If needed, use Chrome with a separate copy of your signed-in Chrome profile. Pass continuation to read more saved text in this conversation without refetching. Indexes such as llms.txt are suggestions, not substitutes. Public http(s) only; private addresses, URLs with credentials and unsafe redirects are blocked. In codemode, tools.read_url(...) returns the structured result.'

const makeReadUrlTool = (reader: WebReader): ToolDefinition => ({
  name: READ_URL_TOOL,
  label: 'Read URL',
  description: READ_URL_DESCRIPTION,
  parameters: readUrlParameters,
  outputSchema: readUrlOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  async execute(_toolCallId, input, signal) {
    const outcome = await Effect.runPromise(
      decodeInput(input, { onExcessProperty: 'error' }).pipe(
        Effect.flatMap(decoded => reader.read(decoded, signal)),
        Effect.catch(error =>
          Effect.succeed<ReadOutcome>({ kind: 'failed', error: error.message, limitations: [] })
        )
      )
    )
    const result = toResult(outcome)
    return {
      content: [{ type: 'text', text: toText(outcome, result) }],
      details: result,
      structuredContent: result,
      ...(outcome.kind === 'failed' ? { isError: true } : {}),
    }
  },
})

export const createWebExtension = (
  reader: WebReader
): { readonly factory: (api: ExtensionAPI) => void } => ({
  factory(api) {
    api.registerTool(makeReadUrlTool(reader))
    api.on('session_shutdown', event =>
      Effect.runPromise(
        reader.endSession(`The conversation ended (${event.reason}). Read the URL again.`)
      )
    )
  },
})
