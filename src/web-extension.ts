import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Effect, type JsonSchema, Schema } from 'effect'
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
  url: 'Absolute http(s) URL of the page to read. Omit when passing continuation.',
  continuation:
    'Token from an earlier incomplete result; returns the next part of that same snapshot without fetching again.',
  maxChars: 'Characters of text per result (default 16000, 1000-120000).',
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

const readUrlParameters = describe(
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
    'document: the requested page, complete in this result; partial: more text follows via continuation or the snapshot is cut; failed: nothing was read.',
  requestedUrl: 'URL as requested.',
  finalUrl: 'URL that answered after validated redirects.',
  title: 'Document title when the page declares one.',
  method:
    'markdown (origin served Markdown), text, html (local extraction) or browser (rendered in Chrome).',
  status: 'HTTP status of the final response.',
  text: 'Readable text of this part, Markdown-flavoured.',
  offset: 'Character offset of this part within the whole document text.',
  end: 'Character offset just past this part.',
  totalChars: 'Characters in the whole document text held in this session.',
  complete: 'True when this part ends the document and nothing was cut.',
  continuation: 'Pass as continuation to read the next part of this same snapshot.',
  links: 'Links found in the document with absolute URLs.',
  suggestions:
    'Related documents such as llms.txt indexes; never substituted for the requested page.',
  limitations:
    'Explicit limits of this result: truncation, status, blocked subrequests, rendering notes.',
  error: 'Why the read failed.',
}

const readUrlOutputSchema = describe(
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
  if (result.continuation !== undefined)
    return `; continue with continuation "${result.continuation}"`
  return result.complete ? ' (complete)' : ' (snapshot cut by the byte limit)'
}

const header = (slice: DocumentSlice, result: ReadUrlResult): string => {
  const { document } = slice
  const lines = [
    `# ${document.title ?? document.finalUrl}`,
    `Source: ${document.finalUrl}${document.finalUrl === document.requestedUrl ? '' : ` (requested ${document.requestedUrl})`} · ${document.method}${document.status === undefined ? '' : ` · HTTP ${document.status}`}`,
    `Characters ${slice.offset}-${slice.end} of ${document.text.length}${rangeNote(result)}`,
  ]
  if (document.limitations.length > 0)
    lines.push(...document.limitations.map(limitation => `Limitation: ${limitation}`))
  return lines.join('\n')
}

export const toText = (outcome: ReadOutcome, result: ReadUrlResult): string => {
  if (outcome.kind === 'failed')
    return `read_url failed: ${result.error ?? 'unknown failure'}${
      result.limitations.length > 0 ? `\n${result.limitations.join('\n')}` : ''
    }`
  const { slice } = outcome
  const parts = [header(slice, result), '', slice.text]
  if (slice.offset === 0) {
    if (result.links.length > 0)
      parts.push(
        '',
        `Links (${Math.min(result.links.length, LINKS_IN_TEXT)} of ${slice.document.links.length}):`,
        ...result.links
          .slice(0, LINKS_IN_TEXT)
          .map(link => `- ${link.text || link.url}: ${link.url}`)
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

const makeReadUrlTool = (reader: WebReader): ToolDefinition => ({
  name: READ_URL_TOOL,
  label: 'Read URL',
  description:
    'Read a public documentation page by URL and return its readable text with sources. Dev negotiates Markdown with the origin, otherwise extracts the HTML locally, and renders in the installed Chrome (with a dev-owned copy of your authenticated profile) only when static content is unusable. Results are bounded: an incomplete result carries a continuation token that returns the next part of the same snapshot; snapshots live only in this session. Indexes such as llms.txt appear as suggestions, never as substitutes. Only public http(s) destinations are read; private addresses, credential-bearing URLs and unsafe redirects are refused before connecting. In codemode, tools.read_url(...) resolves to the structured result.',
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
        reader.endSession(
          `This document snapshot belonged to a session that ended (${event.reason}); read the URL again.`
        )
      )
    )
  },
})
