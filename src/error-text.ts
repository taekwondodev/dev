export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export const redactSecrets = (text: string): string =>
  text
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/(authorization\s*:\s*(?:bearer|basic|token)\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[redacted]')
    .replace(
      /\b(?:(?:sk|key|token)-[A-Za-z0-9_-]{12,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g,
      '[redacted]'
    )
