import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import { native } from '../src/native.ts'
import { observeFamily, processTable, type ObservedProcess } from '../src/process-family.ts'
import { makeClaims } from './workspace/workspace-check-support.ts'

const read = (): Promise<ObservedProcess[]> => Effect.runPromise(processTable)
const report = () => Effect.void
const find = (table: readonly ObservedProcess[], pid: number | undefined) =>
  table.find(item => item.pid === pid)
const stateOf = (pid: number): string =>
  execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()

const { claim, passed } = makeClaims()
const children: ChildProcess[] = []
const start = async (command: string, args: string[], detached: boolean): Promise<ChildProcess> => {
  const child = spawn(command, args, { detached, stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  await once(child, 'spawn')
  return child
}

try {
  await claim('the current process appears with its parent and a stable birth', async () => {
    const first = find(await read(), process.pid)
    assert.ok(first !== undefined)
    assert.equal(first.parent, process.ppid)
    assert.match(first.birth, /^[1-9][0-9]*\.[0-9]{6}$/)
    await sleep(20)
    assert.equal(find(await read(), process.pid)?.birth, first.birth)
  })

  await claim('a detached child appears as its own group led by itself, owned by us', async () => {
    const child = await start('/bin/sleep', ['30'], true)
    const entry = find(await read(), child.pid)
    assert.ok(entry !== undefined)
    assert.equal(entry.parent, process.pid)
    assert.equal(entry.group, child.pid)
    await sleep(20)
    assert.equal(find(await read(), child.pid)?.birth, entry.birth)
    child.kill('SIGKILL')
    await once(child, 'exit')
  })

  await claim('a zombie is excluded while its parent stays listed', async () => {
    const parent = await start(
      '/usr/bin/perl',
      ['-e', String.raw`$| = 1; $p = fork; exit 0 unless $p; print "$p\n"; sleep 30`],
      true
    )
    const [chunk] = await once(parent.stdout!, 'data')
    const zombie = Number(String(chunk).trim())
    for (let attempt = 0; attempt < 100 && !stateOf(zombie).startsWith('Z'); attempt += 1)
      await sleep(20)
    assert.ok(stateOf(zombie).startsWith('Z'))
    const table = await read()
    assert.equal(find(table, zombie), undefined)
    assert.equal(find(table, parent.pid)?.pid, parent.pid)
    parent.kill('SIGKILL')
    await once(parent, 'exit')
  })

  await claim('a shell family is observed alive and then observed gone', async () => {
    const child = await start('/bin/sh', ['-c', 'sleep 30 & wait'], true)
    await sleep(100)
    const root = find(await read(), child.pid)
    assert.ok(root !== undefined)
    const alive = await Effect.runPromise(
      observeFamily(
        { pid: child.pid, root, known: [root], reported: undefined },
        { rootExited: false, report }
      )
    )
    assert.ok(alive.known.length >= 2)
    process.kill(-root.pid, 'SIGKILL')
    await once(child, 'exit')
    let gone = alive
    for (let attempt = 0; attempt < 100 && gone.known.length > 0; attempt += 1) {
      await sleep(20)
      gone = await Effect.runPromise(observeFamily(gone, { rootExited: true, report }))
    }
    assert.deepEqual(gone.known, [])
  })

  await claim(
    'a failed native read is reported and the next read observes processes again',
    async () => {
      const addon = native()
      const original = Object.getOwnPropertyDescriptor(addon, 'processTable')!
      Object.defineProperty(addon, 'processTable', {
        ...original,
        value: () => {
          throw new Error('fixture process table failure')
        },
      })
      try {
        const result = await Effect.runPromise(Effect.result(processTable))
        assert.ok(Result.isFailure(result))
        assert.equal(result.failure._tag, 'ProcessObservationLost')
        assert.match(result.failure.message, /fixture process table failure/)
      } finally {
        Object.defineProperty(addon, 'processTable', original)
      }
      assert.equal(find(await read(), process.pid)?.pid, process.pid)
    }
  )

  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  for (const child of children) child.kill('SIGKILL')
}
