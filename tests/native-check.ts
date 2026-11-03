import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { makeClaims } from './workspace/workspace-check-support.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-native-check-')))
const { claim, passed } = makeClaims()
const workers: Worker[] = []

try {
  await claim(
    'same-process workers publish independent native builds even with equal timestamps',
    async () => {
      mkdirSync(join(root, 'src/native'), { recursive: true })
      for (const file of ['native.ts', 'error-text.ts', 'native/dev-native.c'])
        copyFileSync(new URL(`../src/${file}`, import.meta.url), join(root, 'src', file))
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const entry = pathToFileURL(join(root, 'src/native.ts')).href
      const run = (): Promise<string> =>
        new Promise((resolve, reject) => {
          const worker = new Worker(
            `
        const { parentPort, workerData } = require('node:worker_threads')
        const fs = require('node:fs')
        const { syncBuiltinESMExports } = require('node:module')
        const rendezvous = new Int32Array(workerData.barrier)
        Date.now = () => 1
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
      assert.deepEqual(readdirSync(join(root, '.dev/native')), [basename(artifact)])
    }
  )
  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  await Promise.all(workers.map(worker => worker.terminate()))
  rmSync(root, { recursive: true, force: true })
}
