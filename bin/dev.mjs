#!/usr/bin/env node
import { resolve } from 'node:path'
import {
  composeResources,
  getSpecialization,
  resourceSummary,
  specializationNames,
} from '../src/specializations.mjs'
import {
  acquireRuntime,
  defaultDataHome,
  gitRoot,
  resolveSelection,
  saveSelection,
  sessionDir,
} from '../src/preferences.mjs'
import { loadPi } from '../src/pi-runtime.mjs'
import { createWorkExtension } from '../src/work-extension.mjs'
import { readDispatch } from '../src/work-dispatch.mjs'

function parseArgs(argv) {
  const options = { cwd: process.cwd(), dataHome: defaultDataHome() }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cwd') options.cwd = resolve(argv[++index])
    else if (arg === '--data-home') options.dataHome = resolve(argv[++index])
    else if (arg === '--specialization') options.specialization = argv[++index]
    else if (arg === '--save-specialization') options.saveSpecialization = argv[++index]
    else if (arg === '--resume') options.resume = resolve(argv[++index])
    else if (arg === '--continue') options.continueSession = true
    else if (arg === '--diagnostics') options.diagnostics = true
    else if (arg === '--probe-runtime') options.probeRuntime = true
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option ${arg}. Use --help.`)
  }
  return options
}

function printHelp() {
  process.stdout
    .write(`dev — Pi development environment\n\nUsage: dev [options]\n\nOptions:\n  --cwd PATH                    launch from PATH\n  --specialization NAME        temporary specialization (${specializationNames().join(' | ')})\n  --save-specialization NAME   explicitly save a repository/directory preference\n  --resume PATH                resume a Pi JSONL session\n  --continue                    resume the newest session for this launch directory\n  --data-home PATH             dedicated dev data home\n  --diagnostics                resolve dependencies and print composition
  --probe-runtime              exercise SDK startup without opening the TUI\n  --help                       show this help\n`)
}

function specializationFromSession(api, manager) {
  const entries = manager.getEntries()
  const metadata = entries.findLast(
    entry => entry.type === 'custom' && entry.customType === 'dev/specialization'
  )
  return metadata?.data?.specialization
}

function validateDiagnostics(services, specialization, resources, verbose = false) {
  const errors = [
    ...services.diagnostics.filter(({ type }) => type === 'error').map(({ message }) => message),
    ...services.resourceLoader
      .getSkills()
      .diagnostics.filter(({ type }) => type === 'error')
      .map(({ message }) => message),
    ...services.resourceLoader.getExtensions().errors.map(({ error, path }) => `${path}: ${error}`),
  ]
  if (errors.length > 0)
    throw new Error(
      `Pi startup cannot continue for specialization "${specialization.name}":\n${errors.join('\n')}`
    )
  if (verbose) {
    const { skills } = services.resourceLoader.getSkills()
    process.stdout.write(
      `specialization: ${specialization.name}\nskills loaded: ${skills.length}\n`
    )
    process.stdout.write(
      `resources:\n${resourceSummary(resources)}\nskill provenance:\n${skills.map(({ name, filePath, disableModelInvocation }) => `${name} -> ${filePath}${disableModelInvocation ? ' [hidden]' : ''}`).join('\n')}\n`
    )
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()
  const root = gitRoot(options.cwd)
  const selection = resolveSelection({
    cwd: options.cwd,
    dataHome: options.dataHome,
    explicit: options.specialization,
  })
  if (options.saveSpecialization) {
    getSpecialization(options.saveSpecialization)
    const path = saveSelection({
      cwd: options.cwd,
      dataHome: options.dataHome,
      specialization: options.saveSpecialization,
    })
    process.stdout.write(`saved specialization ${options.saveSpecialization} at ${path}\n`)
    if (
      !options.specialization &&
      !options.resume &&
      !options.continueSession &&
      !options.diagnostics
    )
      return
  }
  const { api, packageInfo } = await loadPi()
  const sessionPath = options.resume
  let sessions
  if (sessionPath) {
    sessions = api.SessionManager.open(sessionPath, sessionDir(options.dataHome), options.cwd)
  } else if (options.continueSession) {
    sessions = api.SessionManager.continueRecent(options.cwd, sessionDir(options.dataHome))
  } else {
    sessions = api.SessionManager.create(options.cwd, sessionDir(options.dataHome))
  }
  let recorded
  if (sessionPath || options.continueSession) recorded = specializationFromSession(api, sessions)
  const selectedName = recorded ?? selection.specialization
  if ((sessionPath || options.continueSession) && !recorded && !options.specialization)
    throw new Error(
      'This conversation has no dev specialization metadata. Resume it with an explicit --specialization choice.'
    )
  const specialization = getSpecialization(selectedName)
  const resources = composeResources({ cwd: options.cwd, gitRoot: root, specialization })
  if (options.diagnostics) {
    process.stdout.write(
      `cwd: ${options.cwd}\npi: ${packageInfo.version} (${packageInfo.root})\ndata home: ${options.dataHome}\ndispatch: ${readDispatch().path}\nselection: ${selectedName} (${recorded ? 'conversation metadata' : selection.source})\n`
    )
    process.stdout.write(
      `SOUL.md: ${resources.soulPath}\nresource paths:\n${resourceSummary(resources)}\n`
    )
    return
  }
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const runtimeResources = composeResources({ cwd, gitRoot: gitRoot(cwd), specialization })
    const work = createWorkExtension({
      dataHome: options.dataHome,
      specialization: specialization.name,
    })
    const services = await api.createAgentSessionServices({
      cwd,
      agentDir: options.dataHome,
      resourceLoaderOptions: {
        additionalSkillPaths: runtimeResources.skillPaths,
        appendSystemPrompt: [specialization.guidance],
        extensionFactories: [{ name: 'dev:work', factory: work.factory }],
      },
    })
    const result = await api.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })
    work.bindSession(result.session)
    return { ...result, services, diagnostics: services.diagnostics }
  }
  const runtime = await api.createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir: options.dataHome,
    sessionManager: sessions,
  })
  validateDiagnostics(runtime.services, specialization, resources, options.probeRuntime)
  if (!recorded)
    sessions.appendCustomEntry('dev/specialization', {
      version: 1,
      specialization: specialization.name,
      source: selection.source,
    })
  if (options.probeRuntime) {
    await runtime.dispose()
    process.stdout.write('runtime probe: ok\n')
    return
  }
  const mode = new api.InteractiveMode(runtime, { startupDiagnostics: runtime.diagnostics })
  const releaseRuntime = acquireRuntime(options.dataHome)
  process.once('exit', releaseRuntime)
  const terminate = async () => {
    try {
      await runtime.dispose()
    } finally {
      process.exit(1)
    }
  }
  process.once('SIGTERM', terminate)
  process.once('SIGINT', terminate)
  process.once('SIGHUP', terminate)
  try {
    await mode.run()
  } finally {
    await runtime.dispose()
    releaseRuntime()
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
