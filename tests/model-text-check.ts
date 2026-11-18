import assert from 'node:assert/strict'
import { childBrief, createReviewGitTool } from '../src/pi-child.ts'
import {
  READ_URL_DESCRIPTION,
  readUrlOutputSchema,
  readUrlParameters,
} from '../src/web-extension.ts'
import {
  COORDINATOR_PROMPT_SNIPPET,
  COORDINATOR_TOOL_DESCRIPTION,
  coordinatorWorkParameters,
  LEAF_OUTCOME_GUIDANCE,
} from '../src/work-child-coordination.ts'
import { workResultOutputSchema } from '../src/work-domain.ts'
import {
  LEAD_OUTCOME_GUIDANCE,
  LEAD_TOOL_DESCRIPTION,
  leadWorkParameters,
  QUIET_GUIDANCE,
} from '../src/work-extension.ts'
import { WORKSPACE_TOOL_DESCRIPTION, workspaceToolParameters } from '../src/workspace-tool.ts'
import { makeClaims } from './workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const INTERNAL =
  /\b(lead|leaf|leaves|child|children|coordinat\w*|attempts?|outcomes?|reservations?|reserve[sd]?|admission|admit\w*|grants?|attachments?|handoffs?|binding|bound|parked|sweeps?|gates?|authority|controller|owners?|owned|producer|dispatch rules?|integration target|residue|dev-cycle|ADR)\b/i

const descriptions = (schema: unknown): string[] => {
  if (Array.isArray(schema)) return schema.flatMap(descriptions)
  if (typeof schema !== 'object' || schema === null) return []
  return Object.entries(schema).flatMap(([key, value]) =>
    key === 'description' && typeof value === 'string' ? [value] : descriptions(value)
  )
}

const gitInspect = createReviewGitTool(process.cwd())

const surfaces: Record<string, readonly string[]> = {
  'work tool': [LEAD_TOOL_DESCRIPTION, ...descriptions(leadWorkParameters)],
  'delegated work tool': [
    COORDINATOR_TOOL_DESCRIPTION,
    COORDINATOR_PROMPT_SNIPPET,
    ...descriptions(coordinatorWorkParameters),
  ],
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
  git_inspect: [
    gitInspect.description,
    gitInspect.promptSnippet ?? '',
    ...descriptions(gitInspect.parameters),
  ],
}

await claim('every surface an agent always reads is collected', () => {
  for (const [surface, texts] of Object.entries(surfaces))
    assert.ok(texts.join('').length > 0, `${surface} has no text`)
})

await claim('tool declarations and result guidance use no dev-internal terms', () => {
  const found = Object.entries(surfaces).flatMap(([surface, texts]) =>
    texts.flatMap(text => {
      const match = INTERNAL.exec(text)
      return match === null ? [] : [`${surface}: "${match[0]}" in ${JSON.stringify(text)}`]
    })
  )
  assert.deepEqual(found, [])
})

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
