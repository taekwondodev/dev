import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEMODE_OUTPUT_TOKENS,
  type ParseCodemodeSource,
  SAVED_OUTPUT_MAX_BYTES,
  readSavedOutput,
  withOutputLimit,
  withRecoveryHint,
} from '../../src/codemode-output-limit.ts'
import { loadInstalledPi, makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()
const { pi, importFromPi } = await loadInstalledPi()
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

const { sliceHead, sliceTail } = await importFromPi<{
  sliceHead: (text: string, units: number) => string
  sliceTail: (text: string, units: number) => string
}>('dist/core/tools/truncate.js')
const READ = { maxLines: pi.DEFAULT_MAX_LINES, maxBytes: pi.DEFAULT_MAX_BYTES }
const directory = mkdtempSync(join(tmpdir(), 'codemode-hint-'))
const readTool = pi.createReadTool(directory)
let saved = 0

const piCut = (full: string, tokens: number, path: string) => {
  const budget = tokens * 4
  const head = sliceHead(full, Math.floor(budget / 2))
  const tail = sliceTail(full, budget - Math.floor(budget / 2))
  const removed = full.length - Math.floor(budget / 2) - (budget - Math.floor(budget / 2))
  return {
    head,
    tail,
    text: `Warning: truncated output (original token count: ${Math.ceil(full.length / 4)})\nTotal output lines: ${full.split('\n').length}\n\n${head}…${Math.ceil(removed / 4)} tokens truncated…${tail}\n\n[Full output: ${path} (read with offset/limit)]`,
  }
}
const HINT =
  /^(?:Line (\d+) of (\d+) is|Lines (\d+)-(\d+) of (\d+) are) missing or partly missing from this output\. The full output is saved in (\S+); to see (?:it|them) without running the script again, read that file with offset (\d+) and limit (\d+)\.(.*)$/m

const readBack = async (path: string, offset: number, last: number) => {
  const returned: string[] = []
  const unreadable: number[] = []
  let next = offset
  while (next <= last) {
    const result = await readTool.execute('hint', { path, offset: next, limit: last - next + 1 })
    const text = result.content.flatMap(item => (item.type === 'text' ? [item.text] : [])).join('')
    if (/^\[Line \d+ is .* exceeds/.test(text)) {
      unreadable.push(next)
      next++
      continue
    }
    const shown = text.replace(/\n\n\[(?:Showing lines|\d+ more lines)[^\]]*\]$/, '')
    returned.push(...shown.split('\n'))
    next = Number(/Use offset=(\d+) to continue/.exec(text)?.[1] ?? last + 1)
  }
  return { returned, unreadable }
}

const recover = async (full: string, tokens: number) => {
  const path = join(directory, `saved-${saved++}.txt`)
  writeFileSync(path, full)
  const cut = piCut(full, tokens, path)
  const result = withRecoveryHint(cut.text, full, path, READ)
  const match = HINT.exec(result)
  assert.ok(match !== null, result.slice(0, 400))
  const first = Number(match[1] ?? match[3])
  const last = Number(match[1] ?? match[4])
  assert.equal(Number(match[2] ?? match[5]), full.split('\n').length)
  assert.equal(match[6], path)
  assert.equal(Number(match[7]), first)
  assert.equal(Number(match[8]), last - first + 1)
  assert.equal(result.replace(`${match[0]}\n\n`, ''), cut.text.replace('\n\n', '\n'))
  const lines = full.split('\n')
  const starts = lines.map(
    (_, index) => lines.slice(0, index).join('\n').length + (index > 0 ? 1 : 0)
  )
  const missingFrom = cut.head.length
  const missingTo = full.length - cut.tail.length
  const touches = (index: number) =>
    starts[index] < missingTo && starts[index] + lines[index].length + 1 > missingFrom
  const content = (index: number) =>
    starts[index] < missingTo && starts[index] + lines[index].length > missingFrom
  lines.forEach((_, index) => {
    if (index + 1 < first || index + 1 > last)
      assert.ok(!content(index), `line ${index + 1} is cut but not named`)
  })
  assert.ok(
    touches(first - 1) && touches(last - 1),
    `lines ${first}-${last} are wider than the cut`
  )
  return { path, first, last, rest: match[9] ?? '', ...(await readBack(path, first, last)) }
}

const numbered = (count: number, width: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1} ${'x'.repeat(width)}`).join('\n')

await claim(
  "a cut result names exactly the lines Pi's real truncation left out, and Pi's read tool with the named offset and limit returns them",
  async () => {
    const cases: readonly (readonly [string, number])[] = [
      ['abc\nDEFG\nijkl', 2],
      ['abc\nDEFG\n\nijkl', 2],
      ['ab…cd', 1],
      ['ab…1 tokens truncated…cd\nef…9 tokens truncated…gh\nij', 3],
      ['abc\n\nijkl', 2],
      ['\n\nabc\ndef', 1],
      [`a${'😀'.repeat(40)}\nmiddle\n${'😀'.repeat(40)}bcd`, 20],
      ['…5 tokens truncated…'.repeat(3), 10],
      [numbered(300, 30), 100],
      [numbered(300, 30), 1000],
      ['one single long line '.repeat(200), 100],
    ]
    const paired = piCut(`a${'😀'.repeat(40)}\nmiddle\n${'😀'.repeat(40)}bcd`, 20, 'unused')
    assert.deepEqual([paired.head.length, paired.tail.length], [39, 39])
    for (const [full, tokens] of cases) {
      const recovered = await recover(full, tokens)
      assert.equal(recovered.rest, '', recovered.rest)
      assert.deepEqual(recovered.unreadable, [])
      assert.deepEqual(
        recovered.returned,
        full.split('\n').slice(recovered.first - 1, recovered.last)
      )
    }
  }
)

await claim(
  'a cut too large for one read says how to page through it, and names the lines read cannot return',
  async () => {
    const lines = Array.from({ length: 6000 }, (_, index) => `line ${index + 1} ${'x'.repeat(40)}`)
    const paged = await recover(lines.join('\n'), 25_000)
    assert.match(
      paged.rest,
      new RegExp(
        `^ One read returns at most ${READ.maxLines} lines or 50KB, so continue from the offset it reports until you reach line ${paged.last}\\.$`
      )
    )
    assert.deepEqual(paged.returned, lines.slice(paged.first - 1, paged.last))
    const huge = 'y'.repeat(READ.maxBytes + 10)
    const withLong = [
      ...lines.slice(0, 50),
      huge,
      ...lines.slice(50, 100),
      huge,
      ...lines.slice(100, 150),
    ]
    const long = await recover(withLong.join('\n'), 2000)
    assert.match(
      long.rest,
      / Lines 51, 102 are longer than 50KB and read cannot return them; when a read stops at one, continue from the offset just after it\.$/
    )
    assert.deepEqual(long.unreadable, [51, 102])
    const single = await recover(['a', huge, 'mid', 'end'].join('\n'), 2)
    assert.deepEqual([single.first, single.last], [2, 3])
    assert.match(
      single.rest,
      / Line 2 is longer than 50KB and read cannot return it; continue from offset 3\.$/
    )
    assert.deepEqual([single.unreadable, single.returned], [[2], ['mid']])
    const uncut = await recover(['', huge, 'end'].join('\n'), 0)
    assert.deepEqual([uncut.first, uncut.last], [1, 3])
    assert.match(
      uncut.rest,
      / Line 2 is longer than 50KB and read cannot return it; continue from offset 3\.$/
    )
    assert.deepEqual([uncut.unreadable, uncut.returned], [[2], ['', 'end']])
  }
)

await claim(
  'a saved output of 16 MiB of empty lines still gets its lines named, and one a byte larger is not read',
  async () => {
    const path = join(directory, 'largest.txt')
    const full = '\n'.repeat(SAVED_OUTPUT_MAX_BYTES)
    writeFileSync(path, full)
    const kept = CODEMODE_OUTPUT_TOKENS * 2
    const head = sliceHead(full, kept)
    const tail = sliceTail(full, kept)
    const text = `Warning: truncated output (original token count: ${full.length / 4})\nTotal output lines: ${full.length + 1}\n\n${head}…${(full.length - kept * 2) / 4} tokens truncated…${tail}\n\n[Full output: ${path} (read with offset/limit)]`
    assert.equal(await readSavedOutput(path), full)
    const first = kept + 1
    const last = full.length - kept
    assert.equal(
      withRecoveryHint(text, full, path, READ).split('\n', 3)[2],
      `Lines ${first}-${last} of ${full.length + 1} are missing or partly missing from this output. The full output is saved in ${path}; to see them without running the script again, read that file with offset ${first} and limit ${last - first + 1}. One read returns at most ${READ.maxLines} lines or 50KB, so continue from the offset it reports until you reach line ${last}.`
    )
    appendFileSync(path, '\n')
    assert.equal(await readSavedOutput(path), undefined)
    rmSync(path)
    await assert.rejects(readSavedOutput(path))
  }
)

await claim(
  "a result that is not Pi's cut of that saved file, or misses nothing, is returned unchanged",
  () => {
    const full = Array.from({ length: 50 }, (_, index) => `row ${index}`).join('\n')
    const path = join(directory, 'unchanged.txt')
    const { text } = piCut(full, 30, path)
    for (const [candidate, savedText, savedPath] of [
      [text, full, join(directory, 'other.txt')],
      [text.replace('Warning: truncated', 'Note: truncated'), full, path],
      [text.slice(0, text.lastIndexOf('\n\n[Full output')), full, path],
      [`Script completed\n${text}`, full, path],
      [text.replace(/…\d+ tokens truncated…/, 'foo'), full, path],
      [text.replace(/…\d+ tokens truncated…/, '…999 tokens truncated…'), full, path],
      [text.replace(/original token count: \d+/, 'original token count: 1'), full, path],
      [text.replace(/Total output lines: \d+/, 'Total output lines: 7'), full, path],
      [text.replace('row 1\n', 'row X\n'), full, path],
      [text, full.replace('row 49', 'row 4X'), path],
      [piCut(full, full.length, path).text, full, path],
    ] as const)
      assert.equal(withRecoveryHint(candidate, savedText, savedPath, READ), candidate)
  }
)

rmSync(directory, { recursive: true, force: true })
console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
