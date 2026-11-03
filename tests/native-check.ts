import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { makeClaims } from './workspace/workspace-check-support.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-native-check-')))
const { claim, passed } = makeClaims()
const workers: Worker[] = []

const copySources = (checkout: string): string => {
  mkdirSync(join(checkout, 'src/native'), { recursive: true })
  for (const file of ['native.ts', 'error-text.ts', 'native/dev-native.c'])
    copyFileSync(new URL(`../src/${file}`, import.meta.url), join(checkout, 'src', file))
  return pathToFileURL(join(checkout, 'src/native.ts')).href
}

try {
  await claim('same-process workers publish independent native builds', async () => {
    const entry = copySources(join(root, 'race'))
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const worker = new Worker(
          `
        const { parentPort, workerData } = require('node:worker_threads')
        const fs = require('node:fs')
        const { syncBuiltinESMExports } = require('node:module')
        const rendezvous = new Int32Array(workerData.barrier)
        const rename = fs.renameSync
        fs.renameSync = (from, to) => {
          Atomics.add(rendezvous, 0, 1)
          Atomics.notify(rendezvous, 0)
          while (Atomics.load(rendezvous, 0) < 2) {
            if (Atomics.wait(rendezvous, 0, 1, 10000) === 'timed-out')
              throw new Error('The second compiler never reached publication')
          }
          return rename(from, to)
        }
        syncBuiltinESMExports()
        import(workerData.entry).then(({ ensureNative }) => {
          parentPort.postMessage(ensureNative())
        })
      `,
          { eval: true, workerData: { barrier, entry } }
        )
        workers.push(worker)
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.once('exit', code => {
          if (code !== 0) reject(new Error(`Native build worker exited ${code}`))
        })
      })
    const [artifact, other] = await Promise.all([run(), run()])
    assert.ok(artifact)
    assert.equal(artifact, other)
    assert.deepEqual(readdirSync(join(root, 'race/.dev/native')), [basename(artifact)])
  })

  await claim(
    'a missing compiler names the Xcode Command Line Tools and its spawn cause, and the process keeps that failure',
    () => {
      const checkout = join(root, 'no-compiler')
      const entry = copySources(checkout)
      const script = `
        const { native } = await import(${JSON.stringify(entry)})
        const attempt = () => { try { native(); return 'loaded' } catch (failure) { return failure.message } }
        const first = attempt()
        process.env.PATH = ${JSON.stringify(process.env.PATH ?? '')}
        console.log(JSON.stringify({ first, second: attempt() }))
      `
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { PATH: join(checkout, 'no-bin') },
        encoding: 'utf8',
      })
      const { first, second } = JSON.parse(output) as {
        first: string
        second: string
      }
      assert.match(first, /xcode-select --install: .*ENOENT/)
      assert.doesNotMatch(first, /undefined/)
      assert.equal(second, first)
      assert.equal(existsSync(join(checkout, '.dev/native')), true)
      assert.deepEqual(readdirSync(join(checkout, '.dev/native')), [])
    }
  )
  await claim(
    'an exclusive rename publishes with a single link and never replaces an existing destination',
    async () => {
      const { native } = await import('../src/native.ts')
      const directory = join(root, 'rename')
      mkdirSync(directory)
      const [candidate, published, loser] = ['candidate', 'published', 'loser'].map(name =>
        join(directory, name)
      )
      writeFileSync(candidate, 'first')
      writeFileSync(loser, 'second')
      assert.equal(native().renameExclusive(candidate, published), true)
      assert.equal(existsSync(candidate), false)
      assert.equal(lstatSync(published).nlink, 1)
      assert.equal(native().renameExclusive(loser, published), false)
      assert.equal(readFileSync(published, 'utf8'), 'first')
      assert.equal(readFileSync(loser, 'utf8'), 'second')
      assert.throws(
        () => native().renameExclusive(candidate, join(directory, 'absent')),
        /ENOENT|No such file/
      )
    }
  )
  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  await Promise.all(workers.map(worker => worker.terminate()))
  rmSync(root, { recursive: true, force: true })
}
