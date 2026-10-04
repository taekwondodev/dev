import { Effect, Schema } from 'effect'
import { errorText } from '../src/error-text.ts'
import { run } from './checkout.ts'
import { withoutFinalPeriod } from './report.ts'

const severities = ['critical', 'high', 'moderate', 'low', 'info'] as const
type Severity = (typeof severities)[number]

const AuditReport = Schema.fromJsonString(
  Schema.Struct({
    vulnerabilities: Schema.Record(
      Schema.String,
      Schema.Struct({ severity: Schema.Literals(severities) })
    ),
  })
)

const AuditFailure = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ error: Schema.Struct({ summary: Schema.NonEmptyString }) }),
    Schema.Struct({ message: Schema.String }),
  ])
)

export type AuditSummary =
  | {
      readonly kind: 'report'
      readonly bySeverity: readonly {
        readonly severity: Severity
        readonly packages: readonly string[]
      }[]
    }
  | { readonly kind: 'unavailable'; readonly reason: string }

export const auditRow = (audit: AuditSummary): string => {
  if (audit.kind === 'unavailable') return `unavailable: ${audit.reason}`
  if (audit.bySeverity.length === 0) return 'no known vulnerabilities'
  return audit.bySeverity
    .map(({ severity, packages }) => `${packages.length} ${severity}: ${packages.join(', ')}`)
    .join('; ')
}

const oneLine = (text: string): string => withoutFinalPeriod(text.replace(/\s*\n\s*/g, ' '))

export const auditAt = (directory: string, scope: 'production' | 'all') =>
  run('npm', ['audit', '--json', ...(scope === 'production' ? ['--omit=dev'] : [])], {
    cwd: directory,
    exitCodes: [0, 1],
  }).pipe(
    Effect.flatMap(({ stdout }) =>
      Schema.decodeEffect(AuditReport)(stdout).pipe(
        Effect.map((report): AuditSummary => ({
          kind: 'report',
          bySeverity: severities.flatMap(severity => {
            const packages = Object.entries(report.vulnerabilities)
              .filter(([, vulnerability]) => vulnerability.severity === severity)
              .map(([name]) => name)
            return packages.length > 0 ? [{ severity, packages }] : []
          }),
        })),
        Effect.catch(decodeError =>
          Schema.decodeEffect(AuditFailure)(stdout).pipe(
            Effect.map(npmError =>
              'error' in npmError ? npmError.error.summary : npmError.message
            ),
            Effect.orElseSucceed(() => errorText(decodeError)),
            Effect.map((reason): AuditSummary => ({ kind: 'unavailable', reason: oneLine(reason) }))
          )
        )
      )
    ),
    Effect.catch(error =>
      Effect.succeed<AuditSummary>({ kind: 'unavailable', reason: oneLine(errorText(error)) })
    )
  )
