import { execFile, fork, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { WorkStore, compactText } from './work-store.mjs'
import { quotaExhausted, readDispatch, resolveDispatch } from './work-dispatch.mjs'
import { parseChildMessage } from './work-protocol.mjs'

const exec = promisify(execFile)
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))

async function git(cwd, args) {
  const { stdout } = await exec(
    'git',
    [
      '--no-pager',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      cwd,
      ...args,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15000,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
    }
  )
  return stdout.trim()
}

async function artifactState(cwd) {
  try {
    const [head, diff, status] = await Promise.all([
      git(cwd, ['rev-parse', 'HEAD']),
      git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']),
      git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']),
    ])
    return {
      head,
      trackedDigest: createHash('sha256').update(diff).digest('hex'),
      untracked: status.split('\n').some(line => line.startsWith('??')),
    }
  } catch {
    return { unavailable: true }
  }
}

function changedArtifact(before, after) {
  if (
    !before ||
    !after ||
    before.unavailable ||
    after.unavailable ||
    before.untracked ||
    after.untracked
  )
    return 'unknown'
  return before.head !== after.head || before.trackedDigest !== after.trackedDigest
}

async function processTable() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    return !match || match[4].startsWith('Z')
      ? []
      : [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            birth: match[5],
          },
        ]
  })
}

function ownedProcesses(table, pid, known = []) {
  const selected = new Map(
    known
      .filter(item => table.some(live => live.pid === item.pid && live.birth === item.birth))
      .map(item => [item.pid, item])
  )
  for (const item of table) {
    if (item.pid === pid || item.group === pid) selected.set(item.pid, item)
  }
  let added = true
  while (added) {
    added = false
    for (const item of table) {
      if (!selected.has(item.pid) && selected.has(item.parent)) {
        selected.set(item.pid, item)
        added = true
      }
    }
  }
  return table.filter(item => selected.get(item.pid)?.birth === item.birth)
}

function signalProcesses(items, signal) {
  for (const item of items.toReversed()) {
    try {
      process.kill(item.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value
}

export class WorkController {
  constructor({
    dataHome,
    cwd,
    sessionId,
    specialization,
    onChange = () => {},
    onOutcome = () => {},
  }) {
    this.dataHome = resolve(dataHome)
    this.cwd = realpathSync(cwd)
    this.sessionId = requiredString(sessionId, 'Session identity')
    this.specialization = specialization
    this.generation = randomUUID()
    this.store = new WorkStore(this.dataHome)
    this.active = new Map()
    this.latest = new Map()
    this.onChange = onChange
    this.onOutcome = onOutcome
    this.closed = false
    this.exhausted = false
  }

  dispatch() {
    return readDispatch(this.dataHome)
  }

  async writerLease(cwd, id) {
    const [root, common, primary, gitDir] = await Promise.all([
      git(cwd, ['rev-parse', '--show-toplevel']),
      git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(this.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(cwd, ['rev-parse', '--absolute-git-dir']),
    ])
    const leadRoot = await git(this.cwd, ['rev-parse', '--show-toplevel'])
    if (
      realpathSync(root) === realpathSync(leadRoot) ||
      realpathSync(common) !== realpathSync(primary) ||
      realpathSync(gitDir) === realpathSync(common)
    ) {
      throw new Error(
        'A writer needs a separate linked worktree of the lead repository, never its primary checkout'
      )
    }
    const directory = join(this.dataHome, 'work', 'writers')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(
      directory,
      `${createHash('sha256').update(realpathSync(root)).digest('hex')}.lock`
    )
    let descriptor
    try {
      descriptor = openSync(path, 'wx', 0o600)
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(
          `Worktree already reserved. Inspect its prior work before removing the lease: ${path}`,
          { cause: error }
        )
      throw error
    }
    try {
      writeFileSync(
        descriptor,
        JSON.stringify({ id, controllerPid: process.pid, cwd: root, sessionId: this.sessionId })
      )
    } finally {
      closeSync(descriptor)
    }
    return path
  }

  assertStart(taskId, kind) {
    if (process.platform === 'win32')
      throw new Error('Background work currently requires POSIX process observation and signals')
    if (this.closed) throw new Error('This work owner has shut down')
    if (kind === 'agent' && this.exhausted)
      throw new Error('Subscription exhausted; no new agents may start in this session')
    requiredString(taskId, 'taskId')
    if ([...this.active.values()].some(job => job.record.owner.taskId === taskId))
      throw new Error('This task already has an active attempt')
  }

  async startProcess(input) {
    requiredString(input.command, 'command')
    return this.start('process', input)
  }

  async startAgent(input) {
    requiredString(input.prompt, 'prompt')
    if (!['read-only', 'write'].includes(input.access))
      throw new Error('Delegate access must be read-only or write')
    if (
      input.skills !== undefined &&
      (!Array.isArray(input.skills) ||
        input.skills.some(skill => typeof skill !== 'string' || !skill.trim()))
    ) {
      throw new Error('skills must contain skill names')
    }
    const selection = resolveDispatch(this.dataHome, input)
    return this.start('agent', { ...input, selection })
  }

  async start(kind, input) {
    this.assertStart(input.taskId, kind)
    const { generation } = this
    const cwd = realpathSync(resolve(this.cwd, input.cwd ?? this.cwd))
    const artifactAtStart = await artifactState(cwd)
    this.assertStart(input.taskId, kind)
    if (generation !== this.generation) throw new Error('Work was interrupted during preparation')
    const record = this.store.create({
      kind,
      cwd,
      controllerPid: process.pid,
      owner: { sessionId: this.sessionId, taskId: input.taskId, generation },
      ...(kind === 'agent' ? { access: input.access, selection: input.selection } : {}),
      artifactAtStart,
    })
    const job = { record, known: [], exited: false, result: undefined, lease: undefined }
    job.settled = new Promise(resolveSettled => {
      job.resolveSettled = resolveSettled
    })
    this.active.set(record.id, job)
    this.latest.set(input.taskId, record.id)
    let stdout
    let stderr
    try {
      if (kind === 'agent' && input.access === 'write')
        job.lease = await this.writerLease(cwd, record.id)
      if (this.closed || generation !== this.generation || (kind === 'agent' && this.exhausted))
        throw new Error('Work owner invalidated before launch')
      stdout = openSync(this.store.logPath(record.id, 'stdout'), 'wx', 0o600)
      stderr = openSync(this.store.logPath(record.id, 'stderr'), 'wx', 0o600)
      const options = {
        cwd,
        detached: true,
        env: { ...process.env, DEV_DATA_HOME: this.dataHome, PI_CODING_AGENT_DIR: this.dataHome },
      }
      job.child =
        kind === 'agent'
          ? fork(new URL('./pi-child.mjs', import.meta.url), [], {
              ...options,
              execArgv: [],
              stdio: ['ignore', stdout, stderr, 'ipc'],
            })
          : spawn('/bin/bash', ['-c', input.command], {
              ...options,
              stdio: ['ignore', stdout, stderr],
            })
      record.pid = job.child.pid
      if (record.pid) record.status = 'running'
      job.child.on('error', error => {
        record.error = error.message
        if (!job.child.pid) {
          job.exited = true
          this.finish(job, null, null).catch(observationError =>
            this.failObservation(job, observationError)
          )
        }
      })
      job.child.once('exit', (code, signal) => {
        job.exited = true
        job.exitCode = code
        job.signal = signal
        this.waitForOwnedExit(job).catch(error => this.failObservation(job, error))
      })
      if (kind === 'agent') {
        job.child.on('message', raw => {
          if (job.finished || job.result) return
          let message
          try {
            message = parseChildMessage(raw, {
              cwd: record.cwd,
              sessionDir: join(this.dataHome, 'child-sessions'),
            })
          } catch (error) {
            record.protocolError = error.message
            record.error = `Rejected child message: ${error.message}`
            this.cancel(record.id, 'invalid child message').catch(cancelError =>
              this.failObservation(job, cancelError)
            )
            return
          }
          try {
            this.childMessage(job, message)
          } catch (error) {
            this.failObservation(job, error)
          }
        })
        job.child.send(
          {
            type: 'start',
            request: {
              dataHome: this.dataHome,
              cwd,
              specialization: this.specialization,
              sessionDir: join(this.dataHome, 'child-sessions'),
              access: input.access,
              prompt: input.prompt,
              skills: input.skills,
              owner: record.owner,
              model: input.selection.model,
              effort: input.selection.effort,
            },
          },
          error => {
            if (error) record.error = error.message
          }
        )
      }
      this.store.save(record)
      this.onChange()
      return { ...record }
    } catch (error) {
      record.error = error.message
      if (job.child?.pid && !job.exited) {
        await this.cancel(record.id, 'launch failed')
      } else {
        job.exited = true
        await this.finish(job, null, null)
      }
      throw error
    } finally {
      if (stdout !== undefined) closeSync(stdout)
      if (stderr !== undefined) closeSync(stderr)
    }
  }

  childMessage(job, message) {
    const { record } = job
    if (message.type === 'ready' || message.type === 'progress') {
      for (const key of ['model', 'effort', 'sessionFile', 'resources', 'context', 'usage']) {
        if (message[key] !== undefined) record[key] = message[key]
      }
      this.store.save(record)
      this.onChange()
    } else if (message.type === 'result') {
      job.result = message
      this.store.saveResult(record.id, message.text)
      for (const key of ['model', 'effort', 'sessionFile', 'context', 'usage', 'error']) {
        if (message[key] !== undefined) record[key] = message[key]
      }
      if (message.quotaExhausted || quotaExhausted(message.error)) {
        this.exhaust(job.record.id).catch(error => this.failObservation(job, error))
      }
      this.store.save(record)
      this.onChange()
    }
  }

  async waitForOwnedExit(job) {
    if (job.observing) return
    job.observing = true
    try {
      while (!job.finished) {
        job.known = ownedProcesses(await processTable(), job.record.pid, job.known)
        if (job.known.length === 0) {
          await this.finish(job, job.exitCode, job.signal)
          return
        }
        job.record.status = 'waiting'
        this.store.save(job.record)
        this.onChange()
        await pause(500)
      }
    } finally {
      job.observing = false
    }
  }

  failObservation(job, error) {
    job.record.status = 'unknown'
    job.record.observationError = `Process observation unavailable: ${error.message}`
    try {
      this.store.save(job.record)
    } catch (persistenceError) {
      job.record.persistenceError = persistenceError.message
    }
    job.resolveSettled({ ...job.record })
    this.onChange()
  }

  async finish(job, code, signal) {
    if (job.finished) return
    job.finished = true
    const { record } = job
    delete record.observationError
    record.exitCode = code
    record.signal = signal
    record.completedAt = Date.now()
    record.status = 'failed'
    if (code === 0 && !record.error && (record.kind === 'process' || job.result))
      record.status = 'completed'
    if (record.cancelRequestedAt && !record.protocolError) record.status = 'cancelled'
    if (record.kind === 'agent' && !job.result && !record.cancelRequestedAt && !record.error)
      record.error = 'Child exited without a final result'
    record.artifactAtCompletion = await artifactState(record.cwd)
    record.changedDuringRun = changedArtifact(record.artifactAtStart, record.artifactAtCompletion)
    if (job.lease) {
      try {
        unlinkSync(job.lease)
      } catch (error) {
        if (error.code !== 'ENOENT')
          record.cleanupError = `Writer lease retained: ${job.lease}: ${error.message}`
      }
    }
    this.active.delete(record.id)
    this.store.save(record)
    job.resolveSettled({ ...record })
    this.onChange()
    if (this.canDeliver(record)) {
      try {
        await this.onOutcome({ ...record })
      } catch (error) {
        record.deliveryError = error.message
        this.store.save(record)
        this.onChange()
      }
    }
  }

  canDeliver(record) {
    return (
      !this.closed &&
      record.owner.generation === this.generation &&
      this.latest.get(record.owner.taskId) === record.id
    )
  }

  async cancel(id, reason = 'cancelled') {
    const job = this.active.get(id)
    if (!job)
      throw new Error('Attempt is not owned by this live session; inspect retained facts instead')
    if (job.finished) return job.settled
    if (job.cancelling) return job.cancelling
    job.cancelling = this.cancelJob(job, reason)
      .catch(error => {
        this.failObservation(job, error)
        return { ...job.record }
      })
      .finally(() => {
        job.cancelling = undefined
      })
    return job.cancelling
  }

  async cancelJob(job, reason) {
    job.record.cancelRequestedAt = Date.now()
    job.record.cancelReason = reason
    try {
      this.store.save(job.record)
    } catch (error) {
      job.record.persistenceError = error.message
    }
    if (!job.child) return job.settled
    if (job.child.connected) job.child.send({ type: 'cancel' }, () => {})
    try {
      job.known = ownedProcesses(await processTable(), job.record.pid, job.known)
    } catch (error) {
      if (!job.exited) job.child.kill('SIGTERM')
      throw error
    }
    signalProcesses(job.known, 'SIGTERM')
    if (job.exited) this.waitForOwnedExit(job).catch(error => this.failObservation(job, error))
    for (let step = 0; step < 20 && !job.finished; step += 1) await pause(100)
    if (!job.finished) {
      const remaining = ownedProcesses(await processTable(), job.record.pid, job.known)
      signalProcesses(remaining, 'SIGKILL')
      for (let step = 0; step < 20 && !job.finished; step += 1) await pause(100)
    }
    if (!job.finished)
      this.failObservation(
        job,
        new Error('Cancellation requested but termination is not confirmed')
      )
    if (job.finished) await job.settled
    return { ...job.record }
  }

  async interrupt(reason = 'interrupted') {
    this.generation = randomUUID()
    await Promise.all(
      [...this.active.keys()].map(id =>
        this.cancel(id, reason).catch(error => {
          const job = this.active.get(id)
          if (job) this.failObservation(job, error)
        })
      )
    )
  }

  async close(reason = 'session ended') {
    this.closed = true
    await this.interrupt(reason)
  }

  async exhaust(exceptId) {
    this.exhausted = true
    await Promise.all(
      [...this.active.values()]
        .filter(job => job.record.kind === 'agent' && job.record.id !== exceptId)
        .map(job => this.cancel(job.record.id, 'subscription exhausted'))
    )
  }

  list() {
    const { records, unavailable } = this.store.list()
    return {
      records: records
        .filter(record => record.owner.sessionId === this.sessionId)
        .map(record => {
          if (this.active.has(record.id))
            return Object.assign(record, this.active.get(record.id).record)
          if (record.completedAt !== undefined) return record
          let processObservation = 'PID unavailable; launch and exit outcome unknown'
          if (record.pid !== undefined) {
            try {
              process.kill(record.pid, 0)
              processObservation = 'PID present; identity and outcome unverified'
            } catch (error) {
              processObservation =
                error.code === 'ESRCH'
                  ? 'PID absent; exit outcome unknown'
                  : 'Process observation unavailable'
            }
          }
          return Object.assign(record, {
            status: 'unknown',
            processObservation,
            recovery: 'Retained facts only; no restart authorized',
          })
        }),
      unavailable,
      agentsBlocked: this.exhausted,
    }
  }

  async describe(record) {
    const current = await artifactState(record.cwd)
    const staleArtifact = changedArtifact(record.artifactAtCompletion, current)
    const streams = record.kind === 'agent' ? ['result', 'stderr'] : ['stdout', 'stderr']
    return {
      ...record,
      staleArtifact,
      evidence:
        'Process outcome, not artifact verification. Reconcile changed or unknown artifacts before accepting the result.',
      logs: streams.map(stream => {
        const log = this.store.readLog(record.id, stream, undefined, 6000)
        return Object.assign(log, { stream, text: log.text ? compactText(log.text) : log.text })
      }),
    }
  }
}
