import assert from 'node:assert/strict'
import { NodeFileSystem } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'
import { readDispatch, resolveDispatch } from '../../src/work-dispatch.ts'
import type { DispatchInput, DispatchProfile } from '../../src/work-domain.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const contents = (value: unknown) =>
  FileSystem.layerNoop({
    readFileString: () => Effect.succeed(typeof value === 'string' ? value : JSON.stringify(value)),
  })
const resolve = (config: unknown, input: DispatchInput): Promise<DispatchProfile> =>
  Effect.runPromise(resolveDispatch(input).pipe(Effect.provide(contents(config))))
const refusal = (config: unknown, input: DispatchInput): Promise<string> =>
  Effect.runPromise(
    resolveDispatch(input).pipe(
      Effect.flip,
      Effect.map(error => error.message),
      Effect.provide(contents(config))
    )
  )

const strong = { harness: 'pi', model: 'provider/strong', effort: 'high' }
const cheap = { harness: 'pi', model: 'provider/cheap' }
const configured = { rules: { implement: strong }, default: cheap }

await claim('a skill with a configured rule selects that rule', async () => {
  assert.deepEqual(await resolve(configured, { skill: 'implement' }), strong)
})
await claim('a skill without a rule and a missing skill both select the default', async () => {
  assert.deepEqual(await resolve(configured, { skill: 'code-review' }), cheap)
  assert.deepEqual(await resolve(configured, {}), cheap)
})
await claim('explicit model and effort override the selected profile', async () => {
  assert.deepEqual(
    await resolve(configured, {
      skill: 'implement',
      model: 'provider/other',
      effort: 'low',
    }),
    { harness: 'pi', model: 'provider/other', effort: 'low' }
  )
})
await claim('a blank explicit model or an unknown effort fails naming the field', async () => {
  assert.match(await refusal(configured, { model: ' ' }), /whitespace[\s\S]*\["model"\]/)
  assert.match(await refusal(configured, { effort: 'bogus' }), /"off"[\s\S]*\["effort"\]/)
})
await claim('a rule named default fails parsing with that reason', async () => {
  assert.match(
    await refusal({ rules: { default: cheap }, default: cheap }, {}),
    /Cannot read dispatch configuration[\s\S]*cannot be named "default"/
  )
})
await claim('a rule key with whitespace fails parsing naming the key', async () => {
  assert.match(
    await refusal({ rules: { 'code review': cheap }, default: cheap }, {}),
    /Cannot read dispatch configuration[\s\S]*"code review" must be a nonempty skill name without whitespace/
  )
})
await claim('an array of rules fails parsing at the rules key', async () => {
  assert.match(
    await refusal({ rules: [{ when: 'x', use: cheap }], default: cheap }, {}),
    /Cannot read dispatch configuration[\s\S]*Expected object[\s\S]*\["rules"\]/
  )
})
await claim('an unknown field inside a rule fails parsing at that field', async () => {
  assert.match(
    await refusal(
      { rules: { implement: { ...strong, when: 'Implementation' } }, default: cheap },
      {}
    ),
    /Cannot read dispatch configuration[\s\S]*excess property[\s\S]*\["rules"\]\["implement"\]\["when"\]/
  )
})
await claim(
  'a blank default model, a foreign harness and invalid JSON fail with their reason',
  async () => {
    assert.match(
      await refusal({ rules: {}, default: { harness: 'pi', model: ' ' } }, {}),
      /whitespace[\s\S]*\["default"\]\["model"\]/
    )
    assert.match(
      await refusal({ rules: {}, default: { harness: 'claude' } }, {}),
      /Expected "pi"[\s\S]*\["default"\]\["harness"\]/
    )
    assert.match(await refusal('{not json', {}), /valid JSON/)
  }
)
await claim('the shipped configuration has no rules and a pi default with a model', async () => {
  const shipped = await Effect.runPromise(readDispatch.pipe(Effect.provide(NodeFileSystem.layer)))
  assert.deepEqual(shipped.rules, {})
  assert.equal(shipped.default.harness, 'pi')
  assert.equal(typeof shipped.default.model, 'string')
})

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
