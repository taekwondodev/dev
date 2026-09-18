import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadPi } from './pi-runtime.mjs'
import { gitRoot } from './preferences.mjs'
import { composeResources, getSpecialization } from './specializations.mjs'

const ACCESS_MODES = new Set(['read-only', 'write'])
const REVIEW_OPERATIONS = new Set(['status', 'diff', 'staged-diff', 'log', 'show', 'files'])
const MAX_GIT_OUTPUT = 64 * 1024
const PROGRESS_INTERVAL_MS = 1000
const SAFE_GIT_OPTIONS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.allow=never',
]

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
}

function fail(message) {
  throw new Error(message)
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function requireAbsolutePath(value, label) {
  const path = requireString(value, label)
  if (!isAbsolute(path) || path.includes('\0')) fail(`${label} must be an absolute path`)
  return path
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory())
    fail(`${label} must be an existing directory: ${path}`)
}

function validateOwner(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) fail('owner must be an object')
  requireString(owner.sessionId, 'owner.sessionId')
  requireString(owner.taskId, 'owner.taskId')
  requireString(owner.attemptId, 'owner.attemptId')
  requireString(owner.generation, 'owner.generation')
}

function validateRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('request must be an object')
  const request = {
    dataHome: requireAbsolutePath(raw.dataHome, 'request.dataHome'),
    cwd: requireAbsolutePath(raw.cwd, 'request.cwd'),
    specialization: requireString(raw.specialization, 'request.specialization'),
    sessionDir: requireAbsolutePath(raw.sessionDir, 'request.sessionDir'),
    access: requireString(raw.access, 'request.access'),
    prompt: requireString(raw.prompt, 'request.prompt'),
    owner: raw.owner,
  }
  requireDirectory(request.cwd, 'request.cwd')
  if (!ACCESS_MODES.has(request.access)) fail('request.access must be "read-only" or "write"')
  validateOwner(request.owner)
  if (raw.model !== undefined) request.model = requireString(raw.model, 'request.model')
  if (raw.effort !== undefined) request.effort = requireString(raw.effort, 'request.effort')
  if (raw.skills !== undefined) {
    if (
      !Array.isArray(raw.skills) ||
      raw.skills.some(skill => typeof skill !== 'string' || skill.length === 0)
    )
      fail('request.skills must be an array of non-empty strings')
    if (new Set(raw.skills).size !== raw.skills.length)
      fail('request.skills must not contain duplicates')
    request.skills = [...raw.skills]
  }
  mkdirSync(request.dataHome, { recursive: true, mode: 0o700 })
  mkdirSync(request.sessionDir, { recursive: true, mode: 0o700 })
  return request
}

function modelReference(model) {
  return `${model.provider}/${model.id}`
}

function resolveExplicitModel(modelReferenceText, modelRuntime) {
  const available = [...modelRuntime.getModels()]
  if (
    !modelReferenceText.includes('/') ||
    modelReferenceText.startsWith('/') ||
    modelReferenceText.endsWith('/')
  )
    fail(`Invalid model "${modelReferenceText}". Use the exact provider/model-id form.`)
  const matches = available.filter(model => modelReference(model) === modelReferenceText)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) fail(`Model "${modelReferenceText}" is ambiguous across supported models`)
  fail(`Unsupported model "${modelReferenceText}". Use an exact supported provider/model-id.`)
}

function resolveTaskSkills(api, request, resources) {
  const loaded = api.loadSkills({
    cwd: request.cwd,
    agentDir: request.dataHome,
    skillPaths: resources.skillPaths,
    includeDefaults: false,
  })
  if (loaded.diagnostics.some(diagnostic => diagnostic.type === 'error')) {
    fail(
      `Cannot load child skills: ${loaded.diagnostics
        .filter(diagnostic => diagnostic.type === 'error')
        .map(diagnostic => diagnostic.message)
        .join('; ')}`
    )
  }
  if (request.skills === undefined) return { selected: [], filter: undefined }
  const byName = new Map(loaded.skills.map(skill => [skill.name, skill]))
  const selected = request.skills.map(name => {
    const skill = byName.get(name)
    if (!skill) fail(`Requested child skill "${name}" was not found in composed resources`)
    return skill
  })
  return {
    selected,
    filter: base => ({
      ...base,
      skills: base.skills.filter(skill => request.skills.includes(skill.name)),
    }),
  }
}

function taskSkillGuidance(skills) {
  if (skills.length === 0) return ''
  return [
    'Task-specific skills were explicitly selected from the composed resources.',
    ...skills.map(skill => {
      const content = readFileSync(skill.filePath, 'utf8').trim()
      return `<skill name="${skill.name}" location="${skill.filePath}">\n${content}\n</skill>`
    }),
  ].join('\n\n')
}

function childBrief(request, resources, selectedSkills) {
  const access =
    request.access === 'read-only'
      ? 'Review access is read-only. Use read, grep, find, ls, and the safe git_inspect tool only.'
      : 'Work access is enabled for this child. Make only changes required by the assignment.'
  const skillLine =
    selectedSkills.length > 0
      ? `Explicit task skills: ${selectedSkills.map(skill => `${skill.name} (${skill.filePath})`).join(', ')}`
      : 'No task-specific skill names were supplied.'
  return [
    'You are an independent Pi child process for one delegated attempt.',
    access,
    'Do not delegate work, start a background fleet, or treat noninteractive UI absence as approval.',
    `Specialization resources: ${resources.provenance.map(item => `${item.source}: ${item.path}`).join('; ')}`,
    skillLine,
  ].join('\n')
}

function truncateGitOutput(text, rawTruncated = false) {
  const bytes = Buffer.from(text, 'utf8')
  if (!rawTruncated && bytes.length <= MAX_GIT_OUTPUT) return text
  return `${bytes.subarray(0, MAX_GIT_OUTPUT).toString('utf8')}\n\n[git output truncated at ${MAX_GIT_OUTPUT} bytes]`
}

function gitEnvironment() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function captureGitChunk(capture, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const remaining = MAX_GIT_OUTPUT - capture.bytes
  if (remaining <= 0) {
    capture.truncated = true
    return
  }
  const kept = bytes.subarray(0, remaining)
  capture.chunks.push(Buffer.from(kept))
  capture.bytes += kept.length
  if (kept.length < bytes.length) capture.truncated = true
}

function capturedGitText(capture) {
  return Buffer.concat(capture.chunks).toString('utf8')
}

function runGit(cwd, args, signal) {
  return new Promise(resolve => {
    const stdoutCapture = { chunks: [], bytes: 0, truncated: false }
    const stderrCapture = { chunks: [], bytes: 0, truncated: false }
    let spawnError
    let child
    try {
      child = spawn('git', [...SAFE_GIT_OPTIONS, '-C', cwd, ...args], {
        env: gitEnvironment(),
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ error, stdout: '', stderr: '', truncated: false })
      return
    }
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk)
      captureGitChunk(stdoutCapture, chunk)
    })
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk)
      captureGitChunk(stderrCapture, chunk)
    })
    child.once('error', error => {
      spawnError = error
    })
    child.once('close', (code, signalName) => {
      const error =
        spawnError ??
        (code === 0
          ? undefined
          : new Error(
              signalName ? `Git terminated by ${signalName}` : `Git exited with status ${code}`
            ))
      resolve({
        error,
        stdout: capturedGitText(stdoutCapture),
        stderr: capturedGitText(stderrCapture),
        truncated: stdoutCapture.truncated || stderrCapture.truncated,
      })
    })
  })
}

function validateRelativePath(path) {
  if (path === undefined) return undefined
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path))
    fail('git_inspect path must be a non-empty relative path')
  if (path.split(/[\\/]/).includes('..')) fail('git_inspect path may not contain parent traversal')
  return path
}

function validateGitRef(ref) {
  if (
    typeof ref !== 'string' ||
    ref.length === 0 ||
    ref.startsWith('-') ||
    ref.includes('\0') ||
    /[\s\\]/.test(ref) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/@~^:-]*$/.test(ref)
  )
    fail('git_inspect ref is not a safe Git reference')
  return ref
}

function gitArguments(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    fail('git_inspect parameters must be an object')
  if (!REVIEW_OPERATIONS.has(params.operation)) fail('git_inspect operation is not allowed')
  const path = validateRelativePath(params.path)
  switch (params.operation) {
    case 'status':
      return ['status', '--short', '--branch']
    case 'diff':
      return [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        ...(params.ref === undefined ? [] : [validateGitRef(params.ref)]),
        '--',
        ...(path ? [path] : []),
      ]
    case 'staged-diff':
      return ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ...(path ? [path] : [])]
    case 'log': {
      const limit = params.limit === undefined ? 20 : params.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        fail('git_inspect limit must be an integer from 1 to 50')
      return ['log', '--oneline', '--decorate', `--max-count=${limit}`]
    }
    case 'show':
      return ['show', '--no-ext-diff', '--no-textconv', '--oneline', validateGitRef(params.ref)]
    case 'files':
      return ['ls-files', '--', ...(path ? [path] : [])]
    default:
      throw new Error('unreachable git_inspect operation')
  }
}

function createReviewGitTool(cwd) {
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: {
        type: 'string',
        enum: [...REVIEW_OPERATIONS],
        description: 'Read-only Git operation to perform',
      },
      path: {
        type: 'string',
        description: 'Optional repository-relative path without parent traversal',
      },
      ref: {
        type: 'string',
        description: 'Git ref for show or optional diff base, such as HEAD or a commit hash',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum number of log entries',
      },
    },
    required: ['operation'],
  }
  return {
    name: 'git_inspect',
    label: 'git_inspect',
    description:
      "Inspect Git status, diffs, history, refs, or tracked files without changing the repository. Full raw output is retained in this attempt's stdout/stderr logs.",
    promptSnippet: 'Inspect Git state without mutation',
    parameters,
    async execute(_toolCallId, params, signal) {
      const args = gitArguments(params)
      const result = await runGit(cwd, args, signal)
      const output =
        [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim() ||
        '(no Git output)'
      return {
        content: [{ type: 'text', text: truncateGitOutput(output, result.truncated) }],
        ...(result.error ? { isError: true } : {}),
      }
    },
  }
}

function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0
  return ['input', 'output', 'cacheRead', 'cacheWrite'].reduce(
    (total, key) => total + (Number.isFinite(usage[key]) ? usage[key] : 0),
    0
  )
}

function hasAssistantUsage(session, stats) {
  return (
    Number.isFinite(stats.tokens?.total) &&
    stats.tokens.total > 0 &&
    session.messages.some(message => message.role === 'assistant' && usageTotal(message.usage) > 0)
  )
}

function telemetry(session) {
  const stats = session.getSessionStats()
  const contextUsage = session.getContextUsage()
  if (!hasAssistantUsage(session, stats)) return contextUsage ? { context: contextUsage } : {}
  return {
    usage: {
      ...stats.tokens,
      cost: stats.cost,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      toolResults: stats.toolResults,
    },
    ...(contextUsage ? { context: contextUsage } : {}),
  }
}

function finalAssistantOutcome(session) {
  const assistant = session.messages.toReversed().find(message => message.role === 'assistant')
  if (!assistant) {
    return {
      text: '',
      error:
        'Native Pi run produced no assistant response; inspect the canonical session for preserved tool results.',
    }
  }
  if (assistant.stopReason === 'error') {
    return {
      text: '',
      error: errorMessage(assistant.errorMessage ?? 'Native Pi provider returned an error.'),
    }
  }
  if (assistant.stopReason === 'aborted') {
    return { text: '', error: 'Native Pi run aborted.' }
  }
  const text = assistant.content
    .filter(content => content.type === 'text')
    .map(content => content.text)
    .join('')
    .trim()
  if (!text) {
    return {
      text: '',
      error:
        'Native Pi run produced no non-empty assistant response; inspect the canonical session for preserved tool results.',
    }
  }
  return { text }
}

function makeContext(request, packageInfo, resources, selectedSkills, session) {
  return {
    packageVersion: packageInfo.version,
    cwd: request.cwd,
    access: request.access,
    specialization: request.specialization,
    resources: resources.provenance,
    skills: selectedSkills.map(skill => ({ name: skill.name, path: skill.filePath })),
    tools: session.getActiveToolNames(),
  }
}

function serialEmitter(emit) {
  let pending = Promise.resolve()
  return message => {
    const next = pending.then(() => emit(message))
    pending = next.catch(() => {})
    return next
  }
}

export async function runPiChild(rawRequest, emit, { signal } = {}) {
  const send = serialEmitter(emit)
  let request
  let session
  let runtime
  let unsubscribe
  let packageInfo
  let resources
  let selectedSkills = []
  let result
  let exitCode = 1
  let lastProgress = 0
  let removeAbortListener
  let sessionAbortPromise

  const abortSession = async () => {
    if (!session) return
    sessionAbortPromise ??= session.abort()
    await sessionAbortPromise
  }

  try {
    request = validateRequest(rawRequest)
    if (request.access === 'read-only') process.env.PI_OFFLINE = '1'
    const { api, packageInfo: loadedPackageInfo } = await loadPi()
    packageInfo = loadedPackageInfo
    const specialization = getSpecialization(request.specialization)
    resources = composeResources({
      cwd: request.cwd,
      gitRoot: gitRoot(request.cwd),
      specialization,
    })
    const skillSelection = resolveTaskSkills(api, request, resources)
    selectedSkills = skillSelection.selected
    const taskSkills = taskSkillGuidance(selectedSkills)
    const projectTrusted =
      request.access === 'write' &&
      (!api.hasTrustRequiringProjectResources(request.cwd) ||
        new api.ProjectTrustStore(request.dataHome).get(request.cwd) === true)
    const settingsManager = api.SettingsManager.create(request.cwd, request.dataHome, {
      projectTrusted,
    })
    settingsManager.applyOverrides({
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    })
    const services = await api.createAgentSessionServices({
      cwd: request.cwd,
      agentDir: request.dataHome,
      settingsManager,
      resourceLoaderOptions: {
        additionalSkillPaths: resources.skillPaths,
        appendSystemPrompt: [
          resources.guidance,
          childBrief(request, resources, selectedSkills),
          taskSkills,
        ].filter(Boolean),
        ...(skillSelection.filter ? { skillsOverride: skillSelection.filter } : {}),
        noExtensions: request.access === 'read-only',
      },
    })
    const startupErrors = services.diagnostics.filter(diagnostic => diagnostic.type === 'error')
    if (startupErrors.length > 0)
      fail(startupErrors.map(diagnostic => diagnostic.message).join('; '))
    const explicitModel = request.model
      ? resolveExplicitModel(request.model, services.modelRuntime)
      : undefined
    const sessionManager = api.SessionManager.create(request.cwd, request.sessionDir)
    const customTools =
      request.access === 'read-only' ? [createReviewGitTool(request.cwd)] : undefined
    const tools =
      request.access === 'read-only' ? ['read', 'grep', 'find', 'ls', 'git_inspect'] : undefined
    const { session: createdSession } = await api.createAgentSessionFromServices({
      services,
      sessionManager,
      model: explicitModel,
      tools,
      customTools,
    })
    session = createdSession
    await session.bindExtensions({ mode: 'json' })
    runtime = new api.AgentSessionRuntime(session, services, async () => {
      throw new Error('Session replacement is not available in a Pi child process')
    })
    if (!session.model) fail('Pi did not select a model for the child run')
    if (request.effort !== undefined) {
      if (!session.getAvailableThinkingLevels().includes(request.effort))
        fail(`Unsupported effort "${request.effort}" for ${modelReference(session.model)}`)
      session.setThinkingLevel(request.effort)
    }
    if (signal) {
      const onAbort = () => {
        void abortSession().catch(() => {})
      }
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
    }
    if (signal?.aborted) fail('Child run cancelled before ready')
    const resourceContext = makeContext(request, packageInfo, resources, selectedSkills, session)
    await send({
      type: 'ready',
      model: modelReference(session.model),
      effort: session.thinkingLevel,
      sessionFile: session.sessionFile,
      resources: resourceContext,
    })
    unsubscribe = session.subscribe(event => {
      if (event.type !== 'turn_end') return
      const now = Date.now()
      if (now - lastProgress < PROGRESS_INTERVAL_MS) return
      lastProgress = now
      const current = telemetry(session)
      void send({
        type: 'progress',
        usage: current.usage,
        context: current.context,
      })
    })
    if (signal?.aborted) fail('Child run cancelled before prompt')
    await session.prompt(request.prompt, { expandPromptTemplates: false, source: 'rpc' })
    if (signal?.aborted) fail('Child run cancelled')
    const outcome = finalAssistantOutcome(session)
    const current = telemetry(session)
    await send({
      type: 'progress',
      usage: current.usage,
      context: current.context,
    })
    if (outcome.error) {
      result = {
        type: 'result',
        ...outcome,
        usage: current.usage,
        context: current.context,
        model: modelReference(session.model),
        effort: session.thinkingLevel,
        sessionFile: session.sessionFile,
      }
      exitCode = 1
    } else {
      result = {
        type: 'result',
        ...outcome,
        usage: current.usage,
        context: current.context,
        model: modelReference(session.model),
        effort: session.thinkingLevel,
        sessionFile: session.sessionFile,
      }
      exitCode = 0
    }
  } catch (error) {
    const cancelled = signal?.aborted === true
    result = {
      type: 'result',
      text: '',
      error: cancelled ? 'Child run cancelled' : errorMessage(error),
      ...(session ? telemetry(session) : {}),
      ...(session?.model
        ? { model: modelReference(session.model), effort: session.thinkingLevel }
        : {}),
      ...(session?.sessionFile ? { sessionFile: session.sessionFile } : {}),
    }
    exitCode = 1
  } finally {
    removeAbortListener?.()
    unsubscribe?.()
    if (session && signal?.aborted) {
      try {
        await abortSession()
      } catch (error) {
        if (!result?.error) result = { type: 'result', text: '', error: errorMessage(error) }
      }
    }
    if (runtime) {
      try {
        await runtime.dispose()
      } catch (error) {
        if (exitCode === 0) {
          result = {
            type: 'result',
            text: '',
            error: `Pi child shutdown failed: ${errorMessage(error)}`,
            ...(session ? telemetry(session) : {}),
            ...(session?.model
              ? { model: modelReference(session.model), effort: session.thinkingLevel }
              : {}),
            ...(session?.sessionFile ? { sessionFile: session.sessionFile } : {}),
          }
          exitCode = 1
        }
      }
    } else if (session) {
      session.dispose()
    }
  }
  await send(result ?? { type: 'result', text: '', error: 'Pi child ended without an outcome' })
  return exitCode
}

function sendIpc(message) {
  return new Promise(resolve => {
    if (typeof process.send !== 'function' || !process.connected) {
      resolve()
      return
    }
    try {
      process.send(message, () => resolve())
    } catch {
      resolve()
    }
  })
}

function runAsChild() {
  if (typeof process.send !== 'function') {
    console.error('src/pi-child.mjs must be launched with child_process.fork and IPC')
    process.exitCode = 2
    return
  }
  let controller
  let started = false
  let closing = false
  let pendingAbort = false
  const abort = () => {
    pendingAbort = true
    controller?.abort()
  }
  process.on('SIGTERM', abort)
  process.on('SIGINT', abort)
  process.on('disconnect', abort)
  process.on('message', message => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'cancel') {
      abort()
      return
    }
    if (message.type !== 'start' || started || closing) return
    started = true
    controller = new AbortController()
    if (pendingAbort) controller.abort()
    void runPiChild(message.request, sendIpc, { signal: controller.signal })
      .catch(error => {
        console.error(errorMessage(error))
        return 1
      })
      .then(exitCode => {
        closing = true
        if (process.connected) process.disconnect()
        process.exitCode = exitCode ?? 1
      })
  })
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isMainModule()) runAsChild()
