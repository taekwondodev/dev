export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
