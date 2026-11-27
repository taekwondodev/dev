import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { readDispatch, resolveDispatch } from '../../src/work-dispatch.ts'
import type { DispatchInput, DispatchProfile } from '../../src/work-domain.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const profilesRoot = mkdtempSync(join(tmpdir(), 'dev-dispatch-'))
process.env.DEV_PROFILES = profilesRoot
const personalSettings = join(profilesRoot, 'crew-dispatch.json')
const shippedSettings = fileURLToPath(
  new URL('../../config/default-crew-dispatch.json', import.meta.url)
)
process.on('exit', () => rmSync(profilesRoot, { recursive: true, force: true }))

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
  assert.match(await refusal(configured, { model: ' ' }), /\["model"\]/)
  assert.match(await refusal(configured, { effort: 'bogus' }), /\["effort"\]/)
})
await claim('a rule named default fails parsing with that reason', async () => {
  assert.match(
    await refusal({ rules: { default: cheap }, default: cheap }, {}),
    /Cannot read model settings[\s\S]*do not put it in "rules"/
  )
})
await claim('a rule key with whitespace fails parsing naming the key', async () => {
  assert.match(
    await refusal({ rules: { 'code review': cheap }, default: cheap }, {}),
    /Cannot read model settings[\s\S]*"code review" must be a nonempty skill name without whitespace/
  )
})
await claim('an array of rules fails parsing at the rules key', async () => {
  assert.match(
    await refusal({ rules: [{ when: 'x', use: cheap }], default: cheap }, {}),
    /Cannot read model settings[\s\S]*\bat \["rules"\]$/
  )
})
await claim('an unknown field inside a rule fails parsing at that field', async () => {
  assert.match(
    await refusal(
      { rules: { implement: { ...strong, when: 'Implementation' } }, default: cheap },
      {}
    ),
    /Cannot read model settings[\s\S]*\["rules"\]\["implement"\]\["when"\]/
  )
})
await claim(
  'a blank default model and a foreign harness fail naming the field, and invalid JSON fails reading the configuration',
  async () => {
    assert.match(
      await refusal({ rules: {}, default: { harness: 'pi', model: ' ' } }, {}),
      /\["default"\]\["model"\]/
    )
    assert.match(
      await refusal({ rules: {}, default: { harness: 'claude' } }, {}),
      /\["default"\]\["harness"\]/
    )
    const malformed = await refusal('{not json', {})
    assert.match(malformed, /Cannot read model settings/)
    assert.doesNotMatch(malformed, /\bat \[/, 'a JSON failure names no field')
  }
)

const withPersonal = async (settings: string | undefined, body: () => Promise<void>) => {
  if (settings !== undefined) writeFileSync(personalSettings, settings)
  try {
    await body()
  } finally {
    rmSync(personalSettings, { force: true })
  }
}
const readSettings = () =>
  Effect.runPromise(readDispatch.pipe(Effect.provide(NodeFileSystem.layer)))
const readRefusal = () =>
  Effect.runPromise(
    readDispatch.pipe(
      Effect.flip,
      Effect.map(error => error.message),
      Effect.provide(NodeFileSystem.layer)
    )
  )

await claim('without personal settings the shipped default applies and names no model', () =>
  withPersonal(undefined, async () => {
    assert.deepEqual(await readSettings(), {
      path: shippedSettings,
      configured: true,
      rules: {},
      default: { harness: 'pi' },
    })
  })
)
await claim('personal settings in the profiles directory replace the default', () =>
  withPersonal(JSON.stringify(configured), async () => {
    assert.deepEqual(await readSettings(), {
      path: personalSettings,
      configured: true,
      ...configured,
    })
  })
)
await claim('invalid personal settings fail naming that file instead of using the default', () =>
  withPersonal('{not json', async () => {
    const message = await readRefusal()
    assert.ok(message.startsWith(`Cannot read model settings at ${personalSettings}:`), message)
  })
)

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
