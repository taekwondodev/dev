export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export const redactSecrets = (text: string): string =>
  text
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
