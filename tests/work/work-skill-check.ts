import assert from 'node:assert/strict'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeClaims, toolCall } from '../workspace/workspace-check-support.ts'
import { assertStatus, openWorkFixture, script } from './work-check-support.ts'

const count = (text: string, part: string): number => text.split(part).length - 1

const fixture = await openWorkFixture('work-skill')
const { claim, passed } = makeClaims()
try {
  const alpha = fixture.writeSkill('alpha', 'ALPHA-BODY follow the alpha procedure.')
  const beta = fixture.writeSkill('beta', 'BETA-BODY a second skill.')
  fixture.writeSkill('hidden', 'HIDDEN-BODY explicit only.', ['disable-model-invocation: true'])
  fixture.writeSkill('collide', 'COLLIDE-BODY shadowed by a command.')
  const marker = join(fixture.root, 'command-ran')
  writeFileSync(
    join(fixture.agentDir, 'extensions', 'marker.ts'),
    [
      "import { writeFileSync } from 'node:fs'",
      'export default function (pi) {',
      `  const ran = async () => writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      "  pi.registerCommand('marker', { description: 'marker', handler: ran })",
      "  pi.registerCommand('skill:collide', { description: 'collision', handler: ran })",
      '  pi.registerTool({',
      "    name: 'marker_tool',",
      "    label: 'marker',",
      "    description: 'marker',",
      "    parameters: { type: 'object', properties: {} },",
      "    execute: async () => ({ content: [{ type: 'text', text: 'marker' }], details: undefined }),",
      '  })',
      '}',
      '',
    ].join('\n')
  )
  writeFileSync(
    join(fixture.agentDir, 'extensions', 'provider.ts'),
    [
      "import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'",
      'export default function (pi) {',
      "  const model = { provider: 'ext-fixture', api: 'ext-fixture-api', model: 'ext-model' }",
      '  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,',
      '    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }',
      '  pi.registerTool({',
      "    name: 'provider_tool', label: 'provider', description: 'provider',",
      "    parameters: { type: 'object', properties: {} },",
      "    execute: async () => ({ content: [{ type: 'text', text: 'provider' }], details: undefined }),",
      '  })',
      "  let widened = 'not-run'",
      "  pi.on('session_start', () => {",
      "    pi.setActiveTools([...pi.getActiveTools(), 'provider_tool', 'bash', 'write'])",
      "    widened = pi.getActiveTools().sort().join(',')",
      '  })',
      "  pi.registerProvider('ext-fixture', {",
      "    name: 'Extension fixture', api: model.api, baseUrl: 'http://127.0.0.1:9', apiKey: 'offline',",
      "    authHeader: false, models: [{ id: model.model, name: 'Extension model', reasoning: false,",
      "      input: ['text'], contextWindow: 200000, maxTokens: 1000,",
      '      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],',
      '    streamSimple: () => {',
      '      const stream = createAssistantMessageEventStream()',
      "      const text = 'EXTENSION-MODEL session-tools=' + pi.getAllTools().map(tool => tool.name).sort().join(',') + ' after-widening=' + widened",
      "      const message = { role: 'assistant', content: [{ type: 'text', text }], ...model,",
      "        stopReason: 'stop', timestamp: Date.now(), usage }",
      "      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end() })",
      '      return stream',
      '    },',
      '  })',
      '}',
      '',
    ].join('\n')
  )
  writeFileSync(join(fixture.agentDir, 'prompts', 'tpl.md'), 'TEMPLATE-BODY $ARGUMENTS\n')

  const general = fixture.openOwner('general')
  try {
    await Promise.all([
      claim(
        'a leading skill invocation is expanded once into the first user message with its arguments, and the attempt records only the invoked skill',
        async () => {
          const { view, text } = await general.run({
            taskId: 'native',
            prompt: '/skill:alpha   Do the ALPHA-ASSIGNMENT now.',
          })
          assertStatus(view, 'completed')
          assert.equal(count(text, '<skill name="alpha"'), 1)
          assert.equal(count(text, 'ALPHA-BODY'), 1)
          assert.equal(count(text, 'Do the ALPHA-ASSIGNMENT now.'), 1)
          assert.equal(count(text, '/skill:alpha'), 0)
          assert.match(text, /SYSTEM-SKILL-BLOCKS 0/)
          assert.deepEqual(view.resources?.invokedSkill, { name: 'alpha', path: alpha })
        }
      ),
      claim('a plain prompt reaches the model unchanged and records no skill', async () => {
        const { view, text } = await general.run({
          taskId: 'plain',
          prompt: 'Plain PLAIN-ASSIGNMENT without a skill.',
        })
        assertStatus(view, 'completed')
        assert.match(text, /^MODEL-SAW\nPlain PLAIN-ASSIGNMENT without a skill\.\n/)
        assert.equal(count(text, '<skill name='), 0)
        assert.equal(view.resources?.invokedSkill, undefined)
      }),
      claim('a hidden skill is explicitly invocable', async () => {
        const { view, text } = await general.run({ taskId: 'hidden', prompt: '/skill:hidden go' })
        assertStatus(view, 'completed')
        assert.equal(count(text, 'HIDDEN-BODY'), 1)
      }),
      claim(
        'a child reads a second skill file, and the invocation record does not claim that read',
        async () => {
          const { view, text } = await general.run({
            taskId: 'second',
            prompt: `/skill:alpha read another skill\n${script([[toolCall('read-beta', 'read', { path: beta })]])}`,
          })
          assertStatus(view, 'completed')
          assert.match(text, /TOOL-RESULTS\n[\s\S]*BETA-BODY/)
          assert.deepEqual(view.resources?.invokedSkill, { name: 'alpha', path: alpha })
        }
      ),
      claim(
        'another command, a prompt template and a colliding extension command execute nothing',
        async () => {
          const [command, template, collision] = await Promise.all([
            general.run({ taskId: 'command', access: 'write', prompt: '/marker PLAIN-COMMAND' }),
            general.run({ taskId: 'template', access: 'write', prompt: '/tpl TEMPLATE-ARGUMENT' }),
            general.run({ taskId: 'collision', access: 'write', prompt: '/skill:collide run' }),
          ])
          assertStatus(command.view, 'completed')
          assert.ok(
            command.view.resources?.tools.includes('marker_tool'),
            'the fixture extension was loaded in the writing child'
          )
          assert.match(command.text, /^MODEL-SAW\n\/marker PLAIN-COMMAND\n/)
          assertStatus(template.view, 'completed')
          assert.match(template.text, /^MODEL-SAW\n\/tpl TEMPLATE-ARGUMENT\n/)
          assert.equal(count(template.text, 'TEMPLATE-BODY'), 0)
          assert.equal(collision.view.status, 'failed')
          assert.match(collision.view.error ?? '', /extension command named "skill:collide"/)
          assert.ok(!fixture.modelCalls().includes(collision.view.id))
          assert.ok(!existsSync(marker), 'an extension command ran')
        }
      ),
      claim(
        'a read-only child completes a turn on a model registered by a global extension provider, and that extension cannot add a tool to the allowlist',
        async () => {
          const { view, text } = await general.run({
            taskId: 'extension-model',
            model: 'ext-fixture/ext-model',
            prompt: 'Review with the extension model.',
          })
          assertStatus(view, 'completed')
          assert.equal(view.model, 'ext-fixture/ext-model')
          assert.equal(
            text,
            'EXTENSION-MODEL session-tools=find,git_inspect,grep,ls,read after-widening=find,git_inspect,grep,ls,read'
          )
          assert.deepEqual(view.resources?.tools.toSorted(), [
            'find',
            'git_inspect',
            'grep',
            'ls',
            'read',
          ])
        }
      ),
      claim('the general catalog does not contain an Apple skill', async () => {
        const { view } = await general.run({
          taskId: 'general-apple',
          prompt: '/skill:swiftui-pro x',
        })
        assert.equal(view.status, 'failed')
        assert.match(view.error ?? '', /Skill "swiftui-pro" is not in this child's catalog/)
        assert.ok(!fixture.modelCalls().includes(view.id))
      }),
    ])
    await claim(
      'an unknown skill and a skill unreadable when the catalog loads fail the attempt before any model request',
      async () => {
        const unknown = await general.run({ taskId: 'unknown', prompt: '/skill:missing do it' })
        assert.equal(unknown.view.status, 'failed')
        assert.match(unknown.view.error ?? '', /Skill "missing" is not in this child's catalog/)
        const locked = fixture.writeSkill('locked', 'LOCKED-BODY')
        chmodSync(locked, 0o000)
        try {
          const unreadable = await general.run({ taskId: 'unreadable', prompt: '/skill:locked do' })
          assert.equal(unreadable.view.status, 'failed')
          assert.match(unreadable.view.error ?? '', /Skill "locked" is not in this child's catalog/)
          assert.equal(count(unreadable.text, 'LOCKED-BODY'), 0)
          const calls = fixture.modelCalls()
          assert.ok(!calls.includes(unknown.view.id), 'the unknown skill reached the model')
          assert.ok(!calls.includes(unreadable.view.id), 'the unreadable skill reached the model')
        } finally {
          chmodSync(locked, 0o600)
        }
      }
    )
  } finally {
    await general.close()
  }

  const apple = fixture.openOwner('apple')
  try {
    await claim('the apple catalog adds the Apple skills to the shared ones', async () => {
      const [swift, shared] = await Promise.all([
        apple.run({ taskId: 'apple-swift', prompt: '/skill:swiftui-pro x' }),
        apple.run({ taskId: 'apple-shared', prompt: '/skill:alpha x' }),
      ])
      assertStatus(swift.view, 'completed')
      assert.equal(count(swift.text, '<skill name="swiftui-pro"'), 1)
      assertStatus(shared.view, 'completed')
      assert.equal(count(shared.text, 'ALPHA-BODY'), 1)
    })
  } finally {
    await apple.close()
  }

  console.log(
    JSON.stringify(
      {
        result: 'passed',
        checks: passed,
        limitation: 'Offline scripted model in real child processes; no live credentials or model',
      },
      null,
      2
    )
  )
} finally {
  await fixture.close()
}
