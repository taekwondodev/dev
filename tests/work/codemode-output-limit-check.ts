import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEMODE_OUTPUT_TOKENS,
  type ParseCodemodeSource,
  withOutputLimit,
  withRecoveryHint,
} from '../../src/codemode-output-limit.ts'
import { loadInstalledPi, makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()
const { pi, importFromPi } = await loadInstalledPi()
const { parseCodemodeSource } = await importFromPi<{
  parseCodemodeSource: ParseCodemodeSource
}>('../pi-codemode/dist/source.js')
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

const { sliceHead, sliceTail } = await importFromPi<{
  sliceHead: (text: string, units: number) => string
  sliceTail: (text: string, units: number) => string
}>('dist/core/tools/truncate.js')
const directory = mkdtempSync(join(tmpdir(), 'codemode-hint-'))
const readTool = pi.createReadTool(directory)
let saved = 0

const piCut = (full: string, tokens: number, path: string) => {
  const budget = tokens * 4
  const head = sliceHead(full, budget / 2)
  const tail = sliceTail(full, budget / 2)
  return {
    head,
    tail,
    text: `Warning: truncated output (original token count: ${Math.ceil(full.length / 4)})\nTotal output lines: ${full.split('\n').length}\n\n${head}…${Math.ceil((full.length - budget) / 4)} tokens truncated…${tail}\n\n[Full output: ${path} (read with offset/limit)]`,
  }
}
const HINT =
  /^The missing text is in (?:line (\d+)|lines (\d+)-(\d+)) of (\d+)\. The full output is saved in (\S+); to see (?:that line|those lines) without running the script again, read that file with offset (\d+) and limit (\d+)\.$/m

const recover = async (full: string, tokens: number) => {
  const path = join(directory, `saved-${saved++}.txt`)
  writeFileSync(path, full)
  const cut = piCut(full, tokens, path)
  const result = withRecoveryHint(cut.text, path)
  const match = HINT.exec(result)
  if (match === null) {
    assert.equal(result, cut.text)
    return undefined
  }
  const first = Number(match[1] ?? match[2])
  const last = Number(match[1] ?? match[3])
  assert.equal(Number(match[4]), full.split('\n').length)
  assert.equal(match[5], path)
  assert.equal(Number(match[6]), first)
  assert.equal(Number(match[7]), last - first + 1)
  assert.equal(result.replace(`${match[0]}\n\n`, ''), cut.text.replace('\n\n', '\n'))
  const lineAt = (position: number) => full.slice(0, position).split('\n').length
  const lastMissing = lineAt(full.length - cut.tail.length - 1)
  assert.equal(first, lineAt(cut.head.length))
  assert.ok(last === lastMissing || last === lastMissing + 1, `${last} is not ${lastMissing}`)
  const read = await readTool.execute('hint', {
    path,
    offset: first,
    limit: last - first + 1,
  })
  const text = read.content.flatMap(item => (item.type === 'text' ? [item.text] : [])).join('')
  const shown = text.replace(/\n\n\[(?:Showing lines|\d+ more lines)[^\]]*\]$/, '')
  return { first, last, text, shown }
}

const numbered = (count: number, width: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1} ${'x'.repeat(width)}`).join('\n')

await claim(
  "a cut result names the lines holding the text Pi's real truncation left out, at most one line past it, and Pi's read tool with the named offset and limit returns them",
  async () => {
    const cases: readonly (readonly [string, number, readonly [number, number]])[] = [
      ['abc\nDEFG\nijkl', 2, [2, 3]],
      ['abc\nDEFG\n\nijkl', 2, [2, 4]],
      ['ab…cd', 1, [1, 1]],
      ['abc\n\nijkl', 2, [2, 3]],
      ['\n\nabc\ndef', 1, [3, 4]],
      ['\nabc\ndef', 0, [1, 3]],
      [`a${'😀'.repeat(40)}\nmiddle\n${'😀'.repeat(40)}bcd`, 20, [1, 3]],
      [numbered(300, 30), 100, [6, 295]],
      [numbered(300, 30), 1000, [52, 250]],
      [`…3 tokens truncated… printed\n${numbered(40, 10)}`, 30, [3, 38]],
      ['one single long line '.repeat(200), 100, [1, 1]],
    ]
    for (const [full, tokens, range] of cases) {
      const recovered = await recover(full, tokens)
      assert.ok(recovered !== undefined, `no line for ${JSON.stringify(full.slice(0, 60))}`)
      assert.deepEqual([recovered.first, recovered.last], range)
      assert.equal(
        recovered.shown,
        full
          .split('\n')
          .slice(recovered.first - 1, recovered.last)
          .join('\n')
      )
    }
    const paged = await recover(numbered(6000, 40), 25_000)
    assert.ok(paged !== undefined)
    const next = Number(/Use offset=(\d+) to continue/.exec(paged.text)?.[1])
    assert.ok(next > paged.first && next <= paged.last, paged.text.slice(-200))
  }
)

await claim(
  "a result that is not Pi's cut with that saved file, or whose cut marker runs into the same text printed by the script, is returned unchanged",
  async () => {
    const full = Array.from({ length: 50 }, (_, index) => `row ${index}`).join('\n')
    const path = join(directory, 'unchanged.txt')
    const { text } = piCut(full, 30, path)
    assert.match(withRecoveryHint(text, path), HINT)
    for (const [candidate, savedPath] of [
      [text, join(directory, 'other.txt')],
      [text.replace('Warning: truncated', 'Note: truncated'), path],
      [text.slice(0, text.lastIndexOf('\n\n[Full output')), path],
      [`Script completed\n${text}`, path],
      [text.replace(/…\d+ tokens truncated…/, 'foo'), path],
      [text.replace(/…\d+ tokens truncated…/, '…999 tokens truncated…'), path],
      [text.replace(/original token count: \d+/, 'original token count: 1'), path],
    ] as const)
      assert.equal(withRecoveryHint(candidate, savedPath), candidate)
    assert.equal(await recover(`a…1 tokens truncated…${'b'.repeat(12)}\nrow\nrow`, 10), undefined)
  }
)

rmSync(directory, { recursive: true, force: true })
console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
