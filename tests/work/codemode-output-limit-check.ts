import assert from 'node:assert/strict'
import {
  CODEMODE_OUTPUT_TOKENS,
  type ParseCodemodeSource,
  withOutputLimit,
} from '../../src/codemode-output-limit.ts'
import { loadInstalledPi, makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()
const { importFromPi } = await loadInstalledPi()
const { parseCodemodeSource } = await importFromPi<{ parseCodemodeSource: ParseCodemodeSource }>(
  '../pi-codemode/dist/source.js'
)
const limited = (source: string) => withOutputLimit(parseCodemodeSource, source)

const BODY = 'const page = await tools.read({ path: "a.md" })\nreturn page'

const rejected = (source: string): boolean => {
  try {
    parseCodemodeSource(source)
    return false
  } catch {
    return true
  }
}

await claim(
  'a script without an options line gets one with the limit, before its unchanged code',
  () => {
    const rewritten = limited(BODY)
    assert.equal(rewritten, `// @options: {"max_output_tokens":${CODEMODE_OUTPUT_TOKENS}}\n${BODY}`)
    assert.deepEqual(parseCodemodeSource(rewritten), {
      code: `\n${BODY}`,
      options: { maxOutputTokens: 25_000 },
    })
  }
)

await claim('a script that declares only a timeout keeps it and gets the limit added', () => {
  for (const line of [
    '// @options: {"timeout_ms": 60000}',
    '  // @options:{"timeout_ms":60000}\r',
  ]) {
    const rewritten = limited(`${line}\n${BODY}`)
    assert.equal(rewritten, `// @options: {"timeout_ms":60000,"max_output_tokens":25000}\n${BODY}`)
    assert.deepEqual(parseCodemodeSource(rewritten), {
      code: `\n${BODY}`,
      options: { maxOutputTokens: 25_000, timeoutMs: 60_000 },
    })
  }
  const empty = `// @options: {}\n${BODY}`
  assert.equal(limited(empty), `// @options: {"max_output_tokens":25000}\n${BODY}`)
})

await claim(
  'a script that declares its own max_output_tokens, lower or higher, is left untouched',
  () => {
    for (const limit of [0, 2000, 80_000]) {
      const source = `// @options: {"max_output_tokens": ${limit}, "timeout_ms": 5000}\n${BODY}`
      assert.equal(limited(source), source)
    }
  }
)

await claim(
  'every source Pi rejects is returned byte for byte, so Pi rejects it with its own error',
  () => {
    const sources = [
      `// @options: {"timeout_ms": 60000\n${BODY}`,
      `// @options: [1]\n${BODY}`,
      `// @options: null\n${BODY}`,
      `// @options:\n${BODY}`,
      `// @options: {"budget": 1}\n${BODY}`,
      `// @options: {"timeout_ms": 0}\n${BODY}`,
      `// @options: {"timeout_ms": 2147483648}\n${BODY}`,
      `// @options: {"max_output_tokens": "lots"}\n${BODY}`,
      '// @options: {"timeout_ms": 60000}\n  ',
      '// @options: {"timeout_ms": 60000}',
      `${BODY}\n// @options: {"timeout_ms": 60000}`,
      '   \n',
      '',
    ]
    for (const source of sources) {
      assert.ok(rejected(source), `Pi accepts ${JSON.stringify(source)}`)
      assert.equal(limited(source), source)
    }
  }
)

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
