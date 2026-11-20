import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewGitTool } from '../../src/pi-child.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-git-inspect-')))
const git = (...args: readonly string[]): string =>
  execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.invalid', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()
const lines = (label: string, count: number): string =>
  `${Array.from({ length: count }, (_, index) => `${label} line ${index} ${'x'.repeat(60)}`).join('\n')}\n`
const commit = (subject: string, files: Readonly<Record<string, string | Buffer>>): string => {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  git('add', '--all')
  git('commit', '--quiet', '-m', subject)
  return git('rev-parse', 'HEAD')
}

const tool = createReviewGitTool(root)
const inspect = async (
  input: Readonly<Record<string, unknown>>
): Promise<{ readonly text: string; readonly echoed: number }> => {
  const write = process.stdout.write.bind(process.stdout)
  let echoed = 0
  process.stdout.write = chunk => {
    echoed += Buffer.byteLength(chunk)
    return true
  }
  try {
    const result = await tool.execute('check', input, undefined, undefined, undefined as never)
    return {
      text: result.content.map(block => (block.type === 'text' ? block.text : '')).join(''),
      echoed,
    }
  } finally {
    process.stdout.write = write
  }
}

try {
  git('init', '--quiet', '--initial-branch=main')
  const first = commit('first', {
    'small.txt': 'one\n',
    'wide-a.txt': 'seed\n',
    'wide-b.txt': 'seed\n',
    'moved-from.txt': 'kept\n',
  })
  renameSync(join(root, 'moved-from.txt'), join(root, 'moved to é.txt'))
  const second = commit('widen', {
    'image.bin': Buffer.from([0, 1, 2, 0, 255]),
    'small.txt': 'one\ntwo\n',
    'wide-a.txt': lines('a', 600),
    'wide-b.txt': lines('b', 600),
  })
  commit('tall', {
    'tall.txt': lines('t', 1200),
    'table.tsv': Array.from({ length: 6000 }, (_, index) => `${index}\t${index}\trow`).join('\n'),
  })

  await claim(
    'show and log return only the requested path, and log starts at the ref',
    async () => {
      const shown = await inspect({ operation: 'show', ref: second, path: 'small.txt' })
      assert.match(shown.text, /^\+two$/m)
      assert.doesNotMatch(shown.text, /wide-a\.txt/)
      const history = await inspect({ operation: 'log', path: 'tall.txt' })
      assert.deepEqual(
        history.text.split('\n').map(line => line.replace(/^\S+ (?:\([^)]*\) )?/, '')),
        ['tall']
      )
      const earlier = await inspect({ operation: 'log', ref: first })
      assert.deepEqual(
        earlier.text.split('\n').map(line => line.replace(/^\S+ (?:\([^)]*\) )?/, '')),
        ['first']
      )
      const status = await inspect({ operation: 'status', ref: 'not a ref' })
      assert.match(status.text, /^## main/, 'status takes no ref and ignores one')
    }
  )

  await claim(
    'a diff or commit over 64 KB across several files returns the changed files with line counts instead of a cut patch, and each file is then readable by path',
    async () => {
      const diff = await inspect({ operation: 'diff', ref: first })
      for (const row of [
        '1\t0\tsmall.txt',
        '1200\t0\ttall.txt',
        '600\t1\twide-a.txt',
        '0\t1\tmoved-from.txt',
        '1\t0\tmoved to é.txt',
        '-\t-\timage.bin',
      ])
        assert.ok(diff.text.split('\n').includes(row), `${row} in ${diff.text}`)
      assert.match(diff.text, /64 KB/)
      assert.match(diff.text, /\bpath\b/)
      assert.doesNotMatch(diff.text, /a line 0|truncated/)
      assert.ok(Buffer.byteLength(diff.text) < 1024, `${Buffer.byteLength(diff.text)} bytes`)
      const moved = await inspect({ operation: 'diff', ref: first, path: 'moved to é.txt' })
      assert.match(moved.text, /^\+kept$/m, 'a listed path reads back as written')
      assert.ok(diff.echoed > 64 * 1024, 'the whole patch still reaches the run output')

      const commitFiles = await inspect({ operation: 'show', ref: second })
      assert.match(commitFiles.text, /widen/)
      for (const row of ['1\t0\tsmall.txt', '600\t1\twide-a.txt', '600\t1\twide-b.txt'])
        assert.ok(commitFiles.text.split('\n').includes(row), `${row} in ${commitFiles.text}`)
      assert.doesNotMatch(commitFiles.text, /b line 0|truncated/)
    }
  )

  await claim('one file over 64 KB is still cut and says so', async () => {
    const tall = await inspect({ operation: 'diff', ref: second, path: 'tall.txt' })
    assert.match(tall.text, /^\+t line 0 /m)
    assert.match(tall.text, /\n\n\[git output truncated at 65536 bytes\]$/)
    const table = await inspect({ operation: 'show', ref: 'HEAD:table.tsv' })
    assert.match(
      table.text,
      /^0\t0\trow\n/,
      'a file read at a commit is not a list of changed files'
    )
    assert.match(table.text, /\n\n\[git output truncated at 65536 bytes\]$/)

    git('switch', '--quiet', '-c', 'twice', first)
    commit('once', { 'same.txt': lines('s', 600) })
    commit('again', { 'same.txt': lines('u', 600) })
    const range = await inspect({ operation: 'show', ref: `${first}..twice` })
    assert.match(range.text, /^diff --git a\/same\.txt /m, 'two commits on one file are one file')
    assert.match(range.text, /\n\n\[git output truncated at 65536 bytes\]$/)
  })

  await claim(
    'a list of changed files over 64 KB ends on a whole row and says it was cut',
    async () => {
      git('switch', '--quiet', '-c', 'many', first)
      mkdirSync(join(root, 'many'))
      const many = commit(
        'many',
        Object.fromEntries(
          Array.from({ length: 4000 }, (_, index) => [
            `many/f${String(index).padStart(4, '0')}.txt`,
            `${'y'.repeat(20)}\n`,
          ])
        )
      )
      const listed = await inspect({ operation: 'show', ref: many })
      const [rows, marker] = listed.text.split('\n\n')
      assert.equal(marker, '[git output truncated at 65536 bytes]')
      const shown = rows?.split('\n') ?? []
      assert.match(shown[0] ?? '', /^The patch is larger than 64 KB\. /)
      assert.match(shown[1] ?? '', / many$/)
      assert.ok(shown.length > 3000, `${shown.length} lines`)
      for (const row of shown.slice(2)) assert.match(row, /^1\t0\tmany\/f\d{4}\.txt$/)
      assert.ok(Buffer.byteLength(rows ?? '') <= 65_536)
    }
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
