import assert from 'node:assert/strict'
import { childBrief, createReviewGitTool } from '../src/pi-child.ts'
import {
  READ_URL_DESCRIPTION,
  readUrlOutputSchema,
  readUrlParameters,
} from '../src/web-extension.ts'
import * as Effect from 'effect/Effect'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createCoordinatorWorkTool, LEAF_OUTCOME_GUIDANCE } from '../src/work-child-coordination.ts'
import {
  asAttemptId,
  ATTEMPT_RECORD_KEYS,
  WorkKindSchema,
  workResultOutputSchema,
  WorkStatusSchema,
} from '../src/work-domain.ts'
import { outwardRecord } from '../src/work-actions.ts'
import { TRUNCATED_RESULT, workResultText } from '../src/work-model-text.ts'
import { pendingOperationText, SWEEP_MOMENT_TEXT, verdictLabel } from '../src/workspace-command.ts'
import { CLEAR, RETAINED } from '../src/workspace-completion.ts'
import {
  EvidenceVerdictSchema,
  FinishedRuleSchema,
  RetainedReasonSchema,
  SweepOutcomeSchema,
  WorkspaceAccessSchema,
  WorkspaceEffectSchema,
  type WorkspaceId,
  WorkspaceReleaseResultSchema,
  WorkspaceRoleSchema,
  WorkspaceOriginSchema,
  WorkspaceViewSchema,
} from '../src/workspace-domain.ts'
import { assessWorkspace } from '../src/workspace-inspect.ts'
import { checkoutUseStage } from '../src/workspace-labels.ts'
import { OperationPhase, type OperationRecord, UseSchema } from '../src/workspace-records.ts'
import {
  LEAD_OUTCOME_GUIDANCE,
  LEAD_TOOL_DESCRIPTION,
  leadWorkParameters,
  QUIET_GUIDANCE,
} from '../src/work-extension.ts'
import { WORKSPACE_TOOL_DESCRIPTION, workspaceToolParameters } from '../src/workspace-tool.ts'
import { makeClaims } from './workspace/workspace-check-support.ts'
import { INTERNAL, keyWords } from '../scripts/model-text-terms.ts'

const { claim, passed } = makeClaims()

const descriptions = (schema: unknown): string[] => {
  if (Array.isArray(schema)) return schema.flatMap(descriptions)
  if (typeof schema !== 'object' || schema === null) return []
  return Object.entries(schema).flatMap(([key, value]) =>
    key === 'description' && typeof value === 'string' ? [value] : descriptions(value)
  )
}

const toolTexts = (
  tool: Pick<
    ToolDefinition,
    'description' | 'promptSnippet' | 'promptGuidelines' | 'parameters'
  > & { readonly outputSchema?: unknown }
): string[] => [
  tool.description,
  ...(tool.promptSnippet === undefined ? [] : [tool.promptSnippet]),
  ...(tool.promptGuidelines ?? []),
  ...descriptions(tool.parameters),
  ...descriptions(tool.outputSchema),
]

const coordinatorTool = createCoordinatorWorkTool({
  request: () => Effect.die('unused'),
  pending: Effect.die('unused'),
  acknowledge: () => Effect.die('unused'),
  wake: Effect.die('unused'),
})

const assess = (reserved: boolean, fields: Partial<Parameters<typeof assessWorkspace>[0]>) =>
  assessWorkspace({
    identityReason: undefined,
    missing: false,
    pending: undefined,
    unresolved: false,
    unknown: [],
    live: false,
    abandoned: () => [],
    reserved,
    ...fields,
  })

const checkoutStates = [false, true].flatMap(reserved =>
  [
    { missing: true },
    { unresolved: true },
    { unknown: ['use-2'] },
    { abandoned: () => ['use-1'] },
    { live: true },
    {},
  ].map(fields => {
    const assessed = assess(reserved, fields)
    return `${assessed.reason} ${assessed.nextAction}`
  })
)

const run = {
  id: asAttemptId('00000000-0000-0000-0000-000000000001'),
  taskId: 'review',
  workflowTaskId: 'workflow-task',
  workspaceId: 'workspace',
  cwd: '/repo',
  kind: 'agent',
  status: 'completed',
  exitCode: 0,
  completedAt: 10,
  access: 'write',
  coordinate: true,
  lockWarning: 'Dev could not release a lock on the checkout.',
} as const

const recordKeys = (value: unknown, keys: string[] = []): string[] => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    for (const [key, item] of Object.entries(value)) {
      keys.push(key)
      recordKeys(item, keys)
    }
  return keys
}

const OPERATION_ID = '00000000-0000-4000-8000-000000000001' as WorkspaceId
const OPERATION_KINDS: Record<OperationRecord['kind'], true> = {
  allocation: true,
  handoff: true,
  release: true,
}

const storedValues: readonly string[] = [
  ...FinishedRuleSchema.literals.map(rule =>
    verdictLabel({ kind: 'finished', role: 'branch', rule, reason: 'reason' })
  ),
  ...RetainedReasonSchema.literals.map(retained =>
    verdictLabel({ kind: 'retained', role: 'branch', retained, reason: 'reason' })
  ),
  ...Object.keys(OPERATION_KINDS).flatMap(kind =>
    OperationPhase.literals.map(stage => pendingOperationText({ id: OPERATION_ID, kind, stage }))
  ),
  ...UseSchema.fields.stage.literals.map(checkoutUseStage),
  ...Object.values(SWEEP_MOMENT_TEXT),
  ...WorkspaceViewSchema.fields.outcome.literals,
  ...WorkspaceReleaseResultSchema.members.flatMap(member => member.fields.outcome.literals),
  ...SweepOutcomeSchema.literals,
  ...WorkspaceRoleSchema.literals,
  ...WorkspaceOriginSchema.literals,
  ...WorkspaceAccessSchema.literals,
  ...WorkspaceEffectSchema.literals,
  ...EvidenceVerdictSchema.literals,
  ...WorkStatusSchema.literals,
  ...WorkKindSchema.literals,
]

const surfaces: Record<string, readonly string[]> = {
  'work tool': [LEAD_TOOL_DESCRIPTION, ...descriptions(leadWorkParameters)],
  'delegated work tool': toolTexts(coordinatorTool),
  'work results': descriptions(workResultOutputSchema),
  'result guidance': [LEAD_OUTCOME_GUIDANCE, LEAF_OUTCOME_GUIDANCE, QUIET_GUIDANCE],
  'delegated agent prompt': [
    childBrief({ access: 'read-only', coordinate: false }),
    childBrief({ access: 'write', coordinate: true }),
  ],
  'workspace tool': [WORKSPACE_TOOL_DESCRIPTION, ...descriptions(workspaceToolParameters)],
  read_url: [
    READ_URL_DESCRIPTION,
    ...descriptions(readUrlParameters),
    ...descriptions(readUrlOutputSchema),
  ],
  git_inspect: toolTexts(createReviewGitTool(process.cwd())),
  'rendered results': [
    workResultText({ kind: 'run', run }),
    TRUNCATED_RESULT,
    CLEAR,
    ...Object.values(RETAINED).flatMap(retained => retained.actions),
    ...checkoutStates,
  ],
  'stored values interpolated into sentences': storedValues,
  'inspected run record keys': recordKeys(
    outwardRecord(
      Object.fromEntries(
        ATTEMPT_RECORD_KEYS.map(key => [
          key,
          key === 'owner'
            ? { sessionId: 's', taskId: 't', attemptId: 'a', generation: 'g', parent: 'p' }
            : true,
        ])
      )
    )
  ).map(keyWords),
}

await claim(
  'tool declarations, result guidance, stored values that sentences interpolate and sampled results use no dev-internal terms',
  () => {
    assert.notEqual(
      coordinatorTool.promptSnippet,
      undefined,
      'the delegated work tool has a snippet'
    )
    for (const [surface, texts] of Object.entries(surfaces))
      assert.ok(
        texts.length > 0 && texts.every(text => text.length > 0),
        `${surface} has an empty text`
      )
    const found = Object.entries(surfaces).flatMap(([surface, texts]) =>
      texts.flatMap(text => {
        const match = INTERNAL.exec(text)
        return match === null ? [] : [`${surface}: "${match[0]}" in ${JSON.stringify(text)}`]
      })
    )
    assert.deepEqual(found, [])
  }
)

await claim('an earlier operation is named by the stage label an agent reads', () => {
  assert.match(
    assess(true, { pending: { id: 'operation-1', stage: 'intent' } }).reason,
    /^Earlier operation operation-1: planned; checking does not redo it\./
  )
})

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
