import { isAbsolute, relative } from 'node:path'

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid child ${label}`)
  return value
}

function text(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid child ${label}`)
  return value
}

function nonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid child ${label}`)
  return value
}

function array(value, label, parse) {
  if (!Array.isArray(value)) throw new Error(`Invalid child ${label}`)
  return value.map(item => parse(item, label))
}

function parseResources(value, cwd) {
  const source = object(value, 'resources')
  if (source.cwd !== cwd || !['read-only', 'write'].includes(source.access))
    throw new Error('Invalid child resource scope')
  return {
    packageVersion: text(source.packageVersion, 'packageVersion'),
    cwd,
    access: source.access,
    specialization: text(source.specialization, 'specialization'),
    resources: array(source.resources, 'resource paths', item => {
      object(item, 'resource path')
      return {
        path: text(item.path, 'resource path'),
        source: text(item.source, 'resource source'),
        precedence: nonnegative(item.precedence, 'resource precedence'),
      }
    }),
    skills: array(source.skills, 'skills', item => {
      object(item, 'skill')
      return { name: text(item.name, 'skill name'), path: text(item.path, 'skill path') }
    }),
    tools: array(source.tools, 'tools', text),
  }
}

export function parseChildMessage(value, { cwd, sessionDir }) {
  const raw = object(value, 'message')
  if (!['ready', 'progress', 'result'].includes(raw.type))
    throw new Error('Invalid child message type')
  const keys = ['type', 'model', 'effort', 'sessionFile', 'resources', 'context', 'usage']
  if (raw.type === 'result') keys.push('text', 'error', 'quotaExhausted')
  if (Object.keys(raw).some(key => !keys.includes(key)))
    throw new Error('Unexpected child message field')
  const parsed = { type: raw.type }
  for (const key of ['model', 'effort']) {
    if (raw[key] !== undefined) parsed[key] = text(raw[key], key)
  }
  if (raw.sessionFile !== undefined) {
    text(raw.sessionFile, 'sessionFile')
    const path = relative(sessionDir, raw.sessionFile)
    if (!isAbsolute(raw.sessionFile) || !path || path.startsWith('..') || isAbsolute(path))
      throw new Error('Child session file is outside its conversation directory')
    parsed.sessionFile = raw.sessionFile
  }
  if (raw.resources !== undefined) parsed.resources = parseResources(raw.resources, cwd)
  if (raw.context !== undefined) {
    const usage = object(raw.context, 'context')
    parsed.context = {
      tokens: usage.tokens === null ? null : nonnegative(usage.tokens, 'context tokens'),
      contextWindow: nonnegative(usage.contextWindow, 'context window'),
      percent: usage.percent === null ? null : nonnegative(usage.percent, 'context percent'),
    }
  }
  if (raw.usage !== undefined) {
    const usage = object(raw.usage, 'usage')
    parsed.usage = Object.fromEntries(
      [
        'input',
        'output',
        'cacheRead',
        'cacheWrite',
        'total',
        'cost',
        'userMessages',
        'assistantMessages',
        'toolCalls',
        'toolResults',
      ].map(key => [key, nonnegative(usage[key], `usage ${key}`)])
    )
  }
  if (
    raw.type === 'ready' &&
    ['model', 'effort', 'sessionFile', 'resources'].some(key => parsed[key] === undefined)
  )
    throw new Error('Incomplete child ready message')
  if (raw.type === 'result') {
    if (typeof raw.text !== 'string') throw new Error('Invalid child result text')
    parsed.text = raw.text
    if (raw.error !== undefined) parsed.error = text(raw.error, 'error')
    if (!parsed.text.trim() && !parsed.error)
      throw new Error('Child result needs text or an explicit failure')
    if (raw.quotaExhausted !== undefined) {
      if (typeof raw.quotaExhausted !== 'boolean')
        throw new Error('Invalid child quota observation')
      parsed.quotaExhausted = raw.quotaExhausted
    }
  }
  return parsed
}
