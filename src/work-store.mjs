import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const RETENTION_COUNT = 64
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const LOG_FILES = { stdout: 'stdout.log', stderr: 'stderr.log', result: 'result.txt' }

export function compactText(text, limit = 6000) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[truncated; full output is retained]`
}

export class WorkStore {
  constructor(dataHome) {
    this.root = join(resolve(dataHome), 'work', 'attempts')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  directory(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid work attempt identifier')
    return join(this.root, id)
  }

  create(fields) {
    const id = randomUUID()
    mkdirSync(this.directory(id), { mode: 0o700 })
    const record = {
      ...fields,
      owner: { ...fields.owner, attemptId: id },
      version: 1,
      id,
      startedAt: Date.now(),
      status: 'waiting',
    }
    this.save(record)
    return record
  }

  save(record) {
    const path = join(this.directory(record.id), 'record.json')
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    this.prune()
  }

  read(id) {
    const record = JSON.parse(readFileSync(join(this.directory(id), 'record.json'), 'utf8'))
    if (
      record.version !== 1 ||
      record.id !== id ||
      !['process', 'agent'].includes(record.kind) ||
      !['running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown'].includes(
        record.status
      ) ||
      typeof record.owner?.sessionId !== 'string' ||
      typeof record.owner?.taskId !== 'string' ||
      record.owner?.attemptId !== id ||
      typeof record.owner?.generation !== 'string' ||
      (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid < 1)) ||
      !Number.isFinite(record.startedAt) ||
      (record.completedAt !== undefined && !Number.isFinite(record.completedAt))
    )
      throw new Error(`Unsupported or invalid work record: ${id}`)
    return record
  }

  scan() {
    const records = []
    const unavailable = []
    for (const item of readdirSync(this.root, { withFileTypes: true })) {
      if (!item.isDirectory() || !UUID.test(item.name)) continue
      try {
        records.push(this.read(item.name))
      } catch (error) {
        unavailable.push({ id: item.name, error: error.message })
      }
    }
    return { records, unavailable }
  }

  prune() {
    const completed = this.scan()
      .records.filter(record => record.completedAt !== undefined)
      .toSorted((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id))
    const cutoff = Date.now() - RETENTION_MS
    for (const [index, record] of completed.entries()) {
      if (index >= RETENTION_COUNT || record.completedAt < cutoff) {
        rmSync(this.directory(record.id), { recursive: true, force: true })
      }
    }
  }

  list() {
    this.prune()
    const { records, unavailable } = this.scan()
    return { records: records.toSorted((a, b) => b.startedAt - a.startedAt), unavailable }
  }

  logPath(id, stream) {
    if (!Object.hasOwn(LOG_FILES, stream)) throw new Error('Choose stdout, stderr or result')
    return join(this.directory(id), LOG_FILES[stream])
  }

  saveResult(id, text) {
    writeFileSync(this.logPath(id, 'result'), text, { mode: 0o600 })
  }

  readLog(id, stream = 'stdout', offset, limit = 12000) {
    this.prune()
    const path = this.logPath(id, stream)
    if (!existsSync(path)) return { available: false, path, reason: 'Log unavailable or expired' }
    const { size } = statSync(path)
    const start = offset ?? Math.max(0, size - limit)
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64000
    ) {
      throw new Error('Log offset must be nonnegative and limit must be between 1 and 64000 bytes')
    }
    const buffer = Buffer.alloc(Math.min(limit, Math.max(0, size - start)))
    const descriptor = openSync(path, 'r')
    let bytes
    try {
      bytes = readSync(descriptor, buffer, 0, buffer.length, start)
    } finally {
      closeSync(descriptor)
    }
    return {
      available: true,
      path,
      offset: start,
      nextOffset: start + bytes,
      size,
      truncated: start > 0 || start + bytes < size,
      text: buffer.subarray(0, bytes).toString('utf8'),
    }
  }
}
