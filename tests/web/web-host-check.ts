import { installProfileFixture } from '../profile-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { Duration, Effect, Exit, Schema, Scope } from 'effect'
import { makeWebReader } from '../../src/web-reader.ts'
import { ReadUrlResultSchema } from '../../src/web-extension.ts'
import { CHROME_EXECUTABLES, findChrome } from '../../src/web-profile.ts'
import { assertCopyReleased, chromeRunningOn, makeChromeSource } from './chrome-fixture.ts'
import {
  loadInstalledPi,
  makeClaims,
  makeOfflineModel,
  openHostRuntime,
  replay,
  toolCall,
  type ScriptedContent,
} from '../workspace/workspace-check-support.ts'
import { openLifecycle } from '../workspace/workspace-test-lifecycle.ts'

const { pi, packageInfo, importFromPi } = await loadInstalledPi()
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-web-host-')))
const lead = join(fixture, 'lead')
const sessionDir = join(fixture, 'sessions-link')
const agentDir = join(fixture, 'agent')
const dataHome = join(fixture, 'data')
for (const path of [
  lead,
  join(fixture, 'sessions'),
  agentDir,
  join(fixture, 'home', '.agents', 'skills'),
])
  mkdirSync(path, { recursive: true })
symlinkSync(join(fixture, 'sessions'), sessionDir)
mkdirSync(dataHome, { mode: 0o700 })
process.env.HOME = join(fixture, 'home')
installProfileFixture(join(fixture, 'profiles'))
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_TELEMETRY_DISABLED = '1'
const git = (args: readonly string[], cwd = lead) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
git(['init', '--quiet', '-b', 'main'])
git(['config', 'user.email', 'web-host@example.invalid'])
git(['config', 'user.name', 'web host check'])
writeFileSync(join(lead, 'AGENTS.md'), 'web host check\n')
git(['add', 'AGENTS.md'])
git(['commit', '--quiet', '-m', 'web host fixture'])
const repositoryRoot = (cwd: string) =>
  Effect.sync(() => {
    try {
      return git(['rev-parse', '--show-toplevel'], cwd)
    } catch {
      return undefined
    }
  })

const requests: string[] = []
const server = createServer((request, response) => {
  requests.push(request.url ?? '')
  const reply = (type: string, body: string) => {
    response.writeHead(200, { 'content-type': type })
    response.end(body)
  }
  switch (request.url) {
    case '/guide.md':
      return reply(
        'text/markdown; charset=utf-8',
        '# Host Fixture\n\nRead through the host.\n\n- [next](/next.md)\n'
      )
    case '/app.html':
      return reply(
        'text/html',
        '<!doctype html><html><head><title>App</title></head><body><div id="root">loading</div><script src="/app.js"></script></body></html>'
      )
    case '/app.js':
      return reply(
        'text/javascript',
        'document.getElementById("root").innerHTML = "<h1>Rendered Heading</h1><p>" + "Rendered through the host. ".repeat(12) + "</p>"'
      )
    default:
      response.writeHead(404)
      return response.end('not found')
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
const url = `http://docs.fixture.invalid:${address.port}/guide.md`
const appUrl = `http://docs.fixture.invalid:${address.port}/app.html`

const chrome = findChrome(CHROME_EXECUTABLES)
const source = makeChromeSource(fixture, { host: 'docs.fixture.invalid', port: address.port })
source.writeCookies('host-fixture-token')
const profile =
  chrome === undefined
    ? { dataHome, chromeExecutables: [join(fixture, 'no-chrome')] }
    : { dataHome, sourceUserData: source.userData, chromeExecutables: CHROME_EXECUTABLES }
const copyDir = join(dataHome, 'browser', 'user-data')
const readerScope = Scope.makeUnsafe()
const webReader = await Effect.runPromise(
  Scope.provide(readerScope)(
    makeWebReader({
      profile,
      resolveAddress: () => Effect.succeed('127.0.0.1'),
      chromeArguments: ['--host-resolver-rules=MAP *.fixture.invalid 127.0.0.1'],
      browserIdle: Duration.minutes(3),
    }).pipe(Effect.provide(NodeServices.layer))
  )
)

interface RecordedResult {
  readonly toolCallId: string
  readonly toolName: string
  readonly parentToolCallId: string | undefined
  readonly structuredContent: unknown
  readonly isError: boolean
  readonly text: string
}
const recorded: RecordedResult[] = []
const recorder: Pi.ExtensionFactory = api => {
  api.on('tool_result', event => {
    recorded.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      parentToolCallId: event.parentToolCallId,
      structuredContent: event.structuredContent,
      isError: event.isError,
      text: event.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'),
    })
  })
}
const rogue: Pi.ExtensionFactory = api => {
  api.registerTool({
    name: 'rogue',
    label: 'Rogue',
    description: 'An unreviewed tool that writes into the project.',
    parameters: { type: 'object', properties: {} } as never,
    async execute() {
      writeFileSync(join(lead, 'rogue.txt'), 'should never happen')
      return { content: [{ type: 'text', text: 'wrote' }], details: undefined }
    },
  })
}

const scripted = (steps: readonly ScriptedContent[]) => {
  let calls = 0
  return {
    calls: () => calls,
    next: (): ScriptedContent => steps[calls++] ?? [{ type: 'text', text: 'done' }],
  }
}
const codemodeScript = `
const read = await tools.read({ path: 'AGENTS.md' })
const page = await tools.read_url({ url: ${JSON.stringify(url)} })
let rogueOutcome = 'not attempted'
try { await tools.rogue({}); rogueOutcome = 'ran' } catch (error) { rogueOutcome = String(error) }
return { read, page, rogueOutcome }
`
const script = scripted([
  [toolCall('direct-read', 'read', { path: 'AGENTS.md' })],
  [toolCall('direct', 'read_url', { url })],
  [toolCall('scripted', 'codemode', { code: codemodeScript })],
  [toolCall('rogue-direct', 'rogue', {})],
  [{ type: 'text', text: 'done' }],
  [toolCall('rendered', 'read_url', { url: appUrl })],
  [{ type: 'text', text: 'done' }],
  [toolCall('rendered-again', 'read_url', { url: appUrl })],
])
const offline = await makeOfflineModel({
  pi,
  importFromPi,
  fixture,
  id: 'web-host',
  stream: replay(script.next),
})
const { claim, passed } = makeClaims()
const lifecycle = await openLifecycle({ root: join(fixture, 'authority') })
const squatterFile = join(dataHome, 'squatter.jsonl')
writeFileSync(squatterFile, '{}\n', { mode: 0o600 })
const squatter = await lifecycle.attach({
  conversation: { sessionId: 'web-host-squatter', sessionFile: squatterFile, dataHome },
  cwd: lead,
})
assert.equal((await squatter.authorize({ kind: 'write' })).kind, 'ready')
const manager = pi.SessionManager.create(lead, sessionDir)
const sessionFile = manager.getSessionFile()
if (sessionFile === undefined) throw new Error('Pi did not name the session file')
const attached = await lifecycle.attach({
  conversation: { sessionId: manager.getSessionId(), sessionFile, dataHome },
  cwd: lead,
})
const opened = await openHostRuntime({
  coordination: { installationPath: fixture, namespacePath: join(fixture, 'authority') },
  pi,
  packageRoot: packageInfo.root,
  sessionDir,
  agentDir,
  cwd: lead,
  repositoryRoot,
  attachment: attached.effect,
  manager,
  offline,
  lifecycle: lifecycle.effect,
  dataHome,
  webReader,
  extensions: dev => [
    ...dev,
    { name: 'test:recorder', factory: recorder },
    { name: 'test:rogue', factory: rogue },
  ],
})
const find = (toolCallId: string) => {
  const found = recorded.find(item => item.toolCallId === toolCallId)
  if (found === undefined) {
    const entries = opened.runtime.session.sessionManager.getEntries().flatMap(entry =>
      entry.type === 'message' && entry.message.role === 'toolResult'
        ? [
            {
              id: entry.message.toolCallId,
              isError: entry.message.isError,
              text: entry.message.content
                .flatMap(part => (part.type === 'text' ? [part.text] : []))
                .join('\n')
                .slice(0, 400),
            },
          ]
        : []
    )
    throw new Error(
      `no tool result recorded for ${toolCallId}; recorded ${JSON.stringify(recorded.map(item => [item.toolCallId, item.toolName]))}; session ${JSON.stringify(entries)}`
    )
  }
  return found
}
const sessionResult = (toolCallId: string) => {
  const found = opened.runtime.session.sessionManager
    .getEntries()
    .flatMap(entry =>
      entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []
    )
    .find(message => message.toolCallId === toolCallId)
  if (found === undefined) throw new Error(`no session tool result for ${toolCallId}`)
  return {
    isError: found.isError,
    text: found.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'),
  }
}
const asResult = Schema.decodeUnknownSync(ReadUrlResultSchema)
const parseScriptOutput = (text: string): Record<string, unknown> => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
}
let closed = false

try {
  await opened.runtime.session.prompt(
    'Read the fixture documentation directly and through codemode.'
  )
  await opened.runtime.session.waitForIdle()
  await claim(
    'the direct read_url call is admitted by the host and returns the fixture document with structured content',
    () => {
      const direct = find('direct')
      assert.equal(direct.isError, false, direct.text)
      const result = asResult(direct.structuredContent)
      assert.equal(result.outcome, 'document')
      assert.equal(result.requestedUrl, url)
      assert.equal(result.method, 'markdown')
      assert.match(result.text, /^# Host Fixture/)
      assert.deepEqual(result.links, [{ text: 'next', url: url.replace('/guide.md', '/next.md') }])
    }
  )
  await claim(
    'a workspace notice on a shared-checkout read keeps the structured result that codemode scripts consume',
    () => {
      const read = find('direct-read')
      assert.match(
        read.text,
        /\[dev workspace\]/,
        'the squatter writer produced a reader warning notice'
      )
      assert.notEqual(
        read.structuredContent,
        undefined,
        'structured content survived the appended notice'
      )
    }
  )
  await claim(
    'the codemode script receives identical document data for the same fixture URL, a structured read result after the notice, and cannot run an unreviewed nested tool',
    () => {
      const outer = find('scripted')
      assert.equal(outer.isError, false, outer.text)
      const output = parseScriptOutput(outer.text)
      assert.equal(
        output.read,
        'web host check\n',
        'the script received the structured file text, not the text with the appended notice'
      )
      const direct = asResult(find('direct').structuredContent)
      const viaScript = asResult(output.page)
      const { continuation: _d, ...directRest } = direct
      const { continuation: _s, ...scriptRest } = viaScript
      assert.deepEqual(scriptRest, directRest)
      assert.match(String(output.rogueOutcome), /no verified workspace effect/)
      const nested = recorded.filter(item => item.parentToolCallId === 'scripted')
      assert.deepEqual(
        nested.map(item => item.toolName),
        ['read', 'read_url'],
        'the blocked nested call produced no tool result'
      )
      assert.equal(nested[1]?.isError, false)
      assert.deepEqual(
        requests,
        ['/guide.md', '/guide.md'],
        'each read fetched the fixture once; nothing else was fetched'
      )
      assert.ok(
        !git(['status', '--porcelain']).includes('rogue.txt'),
        'the unreviewed tool never wrote'
      )
    }
  )
  await claim('the unreviewed tool is refused directly as well, without ending the turn', () => {
    const direct = sessionResult('rogue-direct')
    assert.equal(direct.isError, true)
    assert.match(direct.text, /no verified workspace effect/)
    assert.ok(script.calls() >= 5, 'the model was asked again after the refusal')
  })
  if (chrome !== undefined) {
    await claim(
      'a page rendered by Chrome through the host survives as a tool result, and a session reload closes the browser and releases the profile copy before it returns',
      async () => {
        await opened.runtime.session.prompt('Render the fixture app page.')
        await opened.runtime.session.waitForIdle()
        const rendered = asResult(find('rendered').structuredContent)
        assert.equal(rendered.method, 'browser', rendered.limitations.join('\n'))
        assert.match(rendered.text, /Rendered Heading/)
        assert.ok(chromeRunningOn(copyDir) > 0, 'Chrome was live on the dev copy')
        await opened.runtime.session.reload()
        await assertCopyReleased(profile, 'after the reload')
      }
    )
    await claim(
      'after the reload the reader relaunches Chrome for the next render, and disposing the runtime closes it and releases the copy before dispose returns',
      async () => {
        await opened.runtime.session.prompt('Render the fixture app page again.')
        await opened.runtime.session.waitForIdle()
        const again = asResult(find('rendered-again').structuredContent)
        assert.match(again.text, /Rendered Heading/)
        assert.ok(chromeRunningOn(copyDir) > 0, 'Chrome was relaunched on the dev copy')
        closed = true
        await opened.close()
        await assertCopyReleased(profile, 'after dispose')
      }
    )
  }
} finally {
  if (!closed) await opened.close()
  await Effect.runPromise(Scope.close(readerScope, Exit.void))
  await squatter.close()
  await lifecycle.close()
  server.close()
  rmSync(fixture, { recursive: true, force: true })
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
