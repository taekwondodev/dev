import { randomUUID } from 'node:crypto'
import * as Schema from 'effect/Schema'

export const RetrievalMethod = Schema.Literals(['markdown', 'text', 'html', 'browser'])
export type RetrievalMethod = typeof RetrievalMethod.Type

export const DocumentLink = Schema.Struct({
  text: Schema.String,
  url: Schema.String,
})
export type DocumentLink = typeof DocumentLink.Type

export interface PageLink extends DocumentLink {
  readonly shown: readonly [start: number, end: number] | undefined
}

export interface WebDocument {
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly title: string | undefined
  readonly text: string
  readonly links: readonly PageLink[]
  readonly method: RetrievalMethod
  readonly contentType: string | undefined
  readonly status: number | undefined
  readonly bodyTruncated: boolean
  readonly suggestions: readonly DocumentLink[]
  readonly limitations: readonly string[]
}

export interface DocumentSlice {
  readonly documentId: string
  readonly document: WebDocument
  readonly offset: number
  readonly text: string
  readonly end: number
  readonly complete: boolean
  readonly continuation: string | undefined
}

export interface SnapshotLimits {
  readonly maxDocuments: number
  readonly maxTotalChars: number
}

const defaultSnapshotLimits: SnapshotLimits = {
  maxDocuments: 64,
  maxTotalChars: 24 * 1024 * 1024,
}

export const DEFAULT_SLICE_CHARS = 16_000
export const MAX_SLICE_CHARS = 120_000
export const MIN_SLICE_CHARS = 1_000

const CONTINUATION = /^([0-9a-f-]{36})@(\d+)$/

const parseContinuation = (
  value: string
): { readonly documentId: string; readonly offset: number } | undefined => {
  const match = value.match(CONTINUATION)
  if (!match) return undefined
  return { documentId: match[1] ?? '', offset: Number(match[2]) }
}

const HIGH_SURROGATE = /[\uD800-\uDBFF]/

const cutAt = (text: string, offset: number, maxChars: number): number => {
  if (text.length - offset <= maxChars) return text.length
  const hardEnd = offset + maxChars
  const earliest = offset + Math.floor(maxChars / 2) + 1
  const newline = text.slice(earliest, hardEnd + 1).lastIndexOf('\n')
  if (newline !== -1) return earliest + newline + 1
  return HIGH_SURROGATE.test(text.charAt(hardEnd - 1)) ? hardEnd - 1 : hardEnd
}

export const sliceDocument = (
  documentId: string,
  document: WebDocument,
  offset: number,
  maxChars: number
): DocumentSlice => {
  const start = Math.min(Math.max(0, offset), document.text.length)
  const end = cutAt(document.text, start, maxChars)
  const complete = end >= document.text.length
  return {
    documentId,
    document,
    offset: start,
    text: document.text.slice(start, end),
    end,
    complete,
    continuation: complete ? undefined : `${documentId}@${end}`,
  }
}

export const showsLink = (
  { offset, end, document }: DocumentSlice,
  { shown }: PageLink
): boolean => {
  if (shown === undefined || shown[0] < offset) return false
  const endsText = end === document.text.length && !document.bodyTruncated
  return shown[1] <= (endsText ? end + 1 : end)
}

export type ContinuationLookup =
  | {
      readonly kind: 'available'
      readonly documentId: string
      readonly document: WebDocument
      readonly offset: number
    }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface DocumentSnapshots {
  remember(document: WebDocument): string
  lookup(continuation: string): ContinuationLookup
  clear(reason: string): void
}

export const makeDocumentSnapshots = (
  limits: SnapshotLimits = defaultSnapshotLimits
): DocumentSnapshots => {
  const documents = new Map<string, WebDocument>()
  let totalChars = 0
  let clearedReason: string | undefined
  const evict = (id: string, document: WebDocument) => {
    documents.delete(id)
    totalChars -= document.text.length
  }
  return {
    remember(document) {
      clearedReason = undefined
      const id = randomUUID()
      documents.set(id, document)
      totalChars += document.text.length
      for (const [oldId, old] of documents) {
        if (documents.size <= limits.maxDocuments && totalChars <= limits.maxTotalChars) break
        if (oldId === id) break
        evict(oldId, old)
      }
      return id
    },
    lookup(continuation) {
      const parsed = parseContinuation(continuation)
      if (parsed === undefined)
        return {
          kind: 'unavailable',
          reason: 'Invalid continuation token. Read the URL again.',
        }
      const document = documents.get(parsed.documentId)
      if (document === undefined)
        return {
          kind: 'unavailable',
          reason: clearedReason ?? 'No saved text for this token. Read the URL again.',
        }
      documents.delete(parsed.documentId)
      documents.set(parsed.documentId, document)
      return {
        kind: 'available',
        documentId: parsed.documentId,
        document,
        offset: parsed.offset,
      }
    },
    clear(reason) {
      documents.clear()
      totalChars = 0
      clearedReason = reason
    },
  }
}
