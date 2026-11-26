import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface Result {
  readonly status: number | null
  readonly output: string
}

interface Run {
  readonly home: string
  readonly calls: () => readonly string[]
  readonly destination: string
  readonly result: Result
}

const source = fileURLToPath(new URL('../', import.meta.url))
const installer = join(source, 'scripts', 'install.sh')
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-install-check-')))
const remote = join(sandbox, 'remote')
const extensions = ['dev-footer', 'dev-header', 'dev-hush', 'terminal-status-title']
const nodeMinimum = (
  JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { engines: { node: string } }
).engines.node.replace('>=', '')
const tools = [
  'sh',
  'uname',
  'sed',
  'awk',
  'mktemp',
  'rm',
  'cat',
  'mkdir',
  'dirname',
  'cp',
  'mv',
  'rmdir',
  'chmod',
]

for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
const git = (args: readonly string[], cwd = sandbox): string => {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

const publish = (name: string, files: Readonly<Record<string, string>>) => {
  const work = join(sandbox, 'work', name)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(work, path, '..'), { recursive: true })
    writeFileSync(join(work, path), content)
  }
  git(['init', '--quiet', '-b', 'main'], work)
  git(['add', '.'], work)
  git(
    [
      '-c',
      'user.name=Install',
      '-c',
      'user.email=install@example.invalid',
      'commit',
      '--quiet',
      '-m',
      name,
    ],
    work
  )
  git(['init', '--quiet', '--bare', '-b', 'main', join(remote, name)])
  git(['push', '--quiet', join(remote, name), 'main'], work)
}

const located = (tool: string): string => {
  const result = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${tool} is needed to run the installer check`)
  return result.stdout.trim()
}

const executable = (path: string, body: string) =>
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 })

const piInstaller = join(sandbox, 'pi-install.sh')
writeFileSync(
  piInstaller,
  `bin="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin"
mkdir -p "$bin"
if [ -t 1 ]; then echo "pi-installer stdout=terminal" >> "$CALLS"; else echo "pi-installer stdout=pipe" >> "$CALLS"; fi
printf '#!/bin/sh\\necho "pi $*" >> "$CALLS"\\n' > "$bin/pi"
chmod 755 "$bin/pi"
`
)

const run = async (
  name: string,
  options: {
    readonly omit?: readonly string[]
    readonly toolchain?: boolean
    readonly node?: string
    readonly prepare?: (home: string) => void
    readonly answer?: string
    readonly npmPrefix?: string
    readonly failCopyOf?: string
    readonly failMoveOf?: string
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string>>
    readonly destination?: string
  } = {}
): Promise<Run> => {
  const root = join(sandbox, name)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const log = join(root, 'calls')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  writeFileSync(log, '')
  const omit = new Set(options.omit)
  for (const tool of [...tools, 'git'])
    if (!omit.has(tool)) symlinkSync(located(tool), join(bin, tool))
  if (options.failCopyOf !== undefined) {
    rmSync(join(bin, 'cp'))
    executable(
      join(bin, 'cp'),
      `case "$*" in */skills/${options.failCopyOf}\\ *) exit 1 ;; esac\nexec '${located('cp')}' "$@"\n`
    )
  }
  if (options.failMoveOf !== undefined) {
    rmSync(join(bin, 'mv'))
    executable(
      join(bin, 'mv'),
      `case "$*" in */${options.failMoveOf}\\ *) exit 1 ;; esac\nexec '${located('mv')}' "$@"\n`
    )
  }
  const npmPrefix = options.npmPrefix ?? join(root, 'npm-global')
  if (options.node !== undefined) executable(join(bin, 'node'), `echo v${options.node}\n`)
  else if (!omit.has('node')) symlinkSync(process.execPath, join(bin, 'node'))
  executable(
    join(bin, 'xcode-select'),
    options.toolchain === false ? 'exit 2\n' : 'echo /Library/Developer/CommandLineTools\n'
  )
  executable(
    join(bin, 'curl'),
    `out= url=
while [ $# -gt 0 ]; do
  case $1 in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
done
echo "curl $url" >> "$CALLS"
case $url in
  https://raw.githubusercontent.com/taekwondodev/dev/main/package.json) body='${join(source, 'package.json')}' ;;
  https://pi.dev/install.sh) body='${piInstaller}' ;;
  *) exit 22 ;;
esac
if [ -n "$out" ]; then cp "$body" "$out"; else cat "$body"; fi
`
  )
  executable(
    join(bin, 'npm'),
    `npm_logs=\${npm_config_logs_dir:-\${npm_config_cache:-$HOME/.npm}/_logs}
mkdir -p "$npm_logs" && echo log > "$npm_logs/debug.log"
if [ "$*" = 'prefix -g' ]; then echo '${npmPrefix}'; exit 0; fi
echo "npm $(pwd) $* pi=$(command -v pi)" >> "$CALLS"
`
  )
  options.prepare?.(home)

  const env = {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    PATH: bin,
    TMPDIR: root,
    CALLS: log,
    DEV_INSTALL_GIT_BASE: pathToFileURL(remote).href,
    ...options.env,
  }
  const cwd = options.cwd ?? root
  const result =
    options.answer === undefined
      ? await withoutTerminal(env, cwd)
      : withTerminal(env, cwd, options.answer)
  return {
    home,
    destination: options.destination ?? join(home, '.local', 'share', 'dev'),
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(line => line !== ''),
    result,
  }
}

const withoutTerminal = (env: Readonly<Record<string, string>>, cwd: string): Promise<Result> =>
  new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => (output += String(chunk)))
    child.stderr.on('data', chunk => (output += String(chunk)))
    child.on('error', reject)
    child.on('close', status => resolve({ status, output }))
    child.stdin.end(readFileSync(installer))
  })

const terminalDriver = `
import json, os, pty, select, signal, sys, time
env, cwd, script, answer = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4].encode()
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.dup2(os.open(script, os.O_RDONLY), 0)
    os.execve('/bin/sh', ['sh'], env)
output, answered, deadline = b'', False, time.monotonic() + 60
while True:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        sys.stdout.write(output.decode(errors='replace') + '\\ninstaller did not finish within 60 seconds\\n')
        sys.exit(124)
    if not select.select([fd], [], [], remaining)[0]:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    if not answered and b'[y/N]' in output:
        os.write(fd, answer + b'\\n')
        answered = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(output.decode(errors='replace'))
sys.exit(os.waitstatus_to_exitcode(status))
`

const withTerminal = (
  env: Readonly<Record<string, string>>,
  cwd: string,
  answer: string
): Result => {
  const result = spawnSync(
    'python3',
    ['-I', '-c', terminalDriver, JSON.stringify(env), cwd, installer, answer],
    { encoding: 'utf8', timeout: 90_000 }
  )
  return { status: result.status, output: result.stdout + result.stderr }
}

const piInstalls = (calls: readonly string[]) =>
  calls.filter(line => line.startsWith('pi install ')).map(line => line.slice('pi install '.length))

const installedSkills = (home: string) => readdirSync(join(home, '.agents', 'skills')).toSorted()

try {
  publish('dev', { 'package.json': '{}\n', 'README.md': 'dev\n' })
  publish('skills', {
    'skills/alpha/SKILL.md': 'alpha\n',
    'skills/beta/SKILL.md': 'beta\n',
    'skills/beta/references/notes.md': 'notes\n',
  })

  const missing = await run('missing', { omit: ['node', 'git'], toolchain: false })
  assert.notEqual(missing.result.status, 0)
  assert.match(
    missing.result.output,
    new RegExp(`Node ${nodeMinimum} or newer is missing.*brew install node`)
  )
  assert.match(
    missing.result.output,
    /Xcode Command Line Tools are missing.*xcode-select --install/
  )
  assert.match(missing.result.output, /git is missing/)
  assert.match(missing.result.output, /Nothing was changed/)
  assert.deepEqual(missing.calls(), [
    'curl https://raw.githubusercontent.com/taekwondodev/dev/main/package.json',
  ])
  assert.deepEqual(readdirSync(missing.home), [], 'missing prerequisites change nothing')

  const old = await run('old-node', { node: '20.1.0' })
  assert.notEqual(old.result.status, 0)
  assert.match(
    old.result.output,
    new RegExp(`Node ${nodeMinimum} or newer, as a stable release, is required, found 20.1.0`)
  )
  assert.deepEqual(readdirSync(old.home), [])

  const prerelease = await run('prerelease-node', { node: `${nodeMinimum}-rc.1` })
  assert.notEqual(prerelease.result.status, 0)
  assert.match(prerelease.result.output, new RegExp(`found ${nodeMinimum}-rc\\.1`))
  assert.deepEqual(readdirSync(prerelease.home), [])

  const lockedPrefix = join(sandbox, 'readonly-npm-prefix')
  mkdirSync(lockedPrefix, { mode: 0o555 })
  const locked = await run('locked-prefix', { npmPrefix: lockedPrefix })
  assert.notEqual(locked.result.status, 0)
  assert.match(locked.result.output, /npm cannot link the dev command without sudo/)
  assert.deepEqual(readdirSync(locked.home), [])
  assert.deepEqual(locked.calls(), [
    'curl https://raw.githubusercontent.com/taekwondodev/dev/main/package.json',
  ])

  const existing = await run('existing', {
    prepare: home => {
      mkdirSync(join(home, '.local', 'share', 'dev', 'keep'), { recursive: true })
    },
  })
  assert.notEqual(existing.result.status, 0)
  assert.match(existing.result.output, /dev already exists/)
  assert.deepEqual(readdirSync(existing.destination), ['keep'])
  assert.equal(
    existing.calls().some(line => line.startsWith('curl https://pi.dev')),
    false,
    'an existing destination stops before Pi and the clone'
  )

  const fresh = await run('fresh', {
    prepare: home => {
      mkdirSync(join(home, '.agents', 'skills', 'mine'), { recursive: true })
      writeFileSync(join(home, '.agents', 'skills', 'mine', 'SKILL.md'), 'mine\n')
    },
  })
  assert.equal(fresh.result.status, 0, fresh.result.output)
  const piBin = join(fresh.home, '.pi', 'agent', 'bin', 'pi')
  assert.equal(
    git(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', 'main@{upstream}'],
      fresh.destination
    ),
    'origin/main'
  )
  assert.equal(
    git(['remote', 'get-url', 'origin'], fresh.destination),
    `${pathToFileURL(remote).href}/dev`
  )
  const calls = fresh.calls()
  assert.ok(calls.includes('pi-installer stdout=pipe'))
  assert.deepEqual(
    calls.filter(line => line.startsWith('npm ')),
    ['ci', 'run setup', 'link --ignore-scripts'].map(
      args => `npm ${fresh.destination} ${args} pi=${piBin}`
    )
  )
  assert.deepEqual(
    piInstalls(calls),
    extensions.map(extension => `git:github.com/taekwondodev/${extension}`)
  )
  assert.match(fresh.result.output, /No terminal to ask, so npm:pi-claude-bridge was not installed/)
  assert.deepEqual(installedSkills(fresh.home), ['alpha', 'beta', 'mine'])
  assert.equal(
    readFileSync(join(fresh.home, '.agents', 'skills', 'beta', 'references', 'notes.md'), 'utf8'),
    'notes\n'
  )
  assert.equal(
    readFileSync(join(fresh.home, '.agents', 'skills', 'mine', 'SKILL.md'), 'utf8'),
    'mine\n'
  )
  assert.equal(
    existsSync(join(fresh.home, '.agents', 'skills', 'alpha', '.git')),
    false,
    'skills are copied, not checked out'
  )

  const colliding = await run('colliding', {
    node: nodeMinimum,
    prepare: home => {
      mkdirSync(join(home, '.agents', 'skills', 'beta'), { recursive: true })
      writeFileSync(join(home, '.agents', 'skills', 'beta', 'SKILL.md'), 'personal\n')
    },
  })
  assert.equal(colliding.result.status, 0, colliding.result.output)
  assert.match(colliding.result.output, /Skipped the whole skill library: .* names: beta\n/)
  assert.deepEqual(installedSkills(colliding.home), ['beta'])
  assert.equal(
    readFileSync(join(colliding.home, '.agents', 'skills', 'beta', 'SKILL.md'), 'utf8'),
    'personal\n'
  )

  const failedCopy = await run('failed-copy', {
    failCopyOf: 'beta',
    prepare: home => {
      mkdirSync(join(home, '.agents', 'skills', 'mine'), { recursive: true })
    },
  })
  assert.notEqual(failedCopy.result.status, 0)
  assert.match(failedCopy.result.output, /No skill was installed and your entries are unchanged/)
  assert.deepEqual(
    readdirSync(join(failedCopy.home, '.agents', 'skills')),
    ['mine'],
    'a failed copy leaves no skill and no staging directory'
  )

  const failedMove = await run('failed-move', {
    failMoveOf: 'beta',
    prepare: home => {
      mkdirSync(join(home, '.agents', 'skills', 'mine'), { recursive: true })
    },
  })
  assert.notEqual(failedMove.result.status, 0)
  assert.match(failedMove.result.output, /No skill was installed and your entries are unchanged/)
  assert.deepEqual(
    readdirSync(join(failedMove.home, '.agents', 'skills')),
    ['mine'],
    'a failed move removes the skills moved before it'
  )

  const start = join(sandbox, 'relative-start')
  const decoys = join(sandbox, 'relative-decoys')
  mkdirSync(start)
  mkdirSync(join(decoys, 'dev'), { recursive: true })
  const relative = await run('relative', {
    cwd: start,
    env: { DEV_DIR: 'dev', CDPATH: decoys },
    destination: join(start, 'dev'),
  })
  assert.equal(relative.result.status, 0, relative.result.output)
  assert.deepEqual(
    relative
      .calls()
      .filter(line => line.startsWith('npm '))
      .map(line => line.split(' ')[1]),
    [relative.destination, relative.destination, relative.destination],
    'a relative DEV_DIR resolves against the invocation directory, not CDPATH'
  )
  assert.deepEqual(readdirSync(join(decoys, 'dev')), [])
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], relative.destination), 'main')

  const accepted = await run('accepted', { answer: 'y' })
  assert.equal(accepted.result.status, 0, accepted.result.output)
  assert.deepEqual(piInstalls(accepted.calls()), [
    ...extensions.map(extension => `git:github.com/taekwondodev/${extension}`),
    'npm:pi-claude-bridge',
  ])
  assert.ok(accepted.calls().includes('pi-installer stdout=pipe'), 'Pi does not offer to start')
  assert.deepEqual(installedSkills(accepted.home), ['alpha', 'beta'])

  const declined = await run('declined', { answer: 'n' })
  assert.equal(declined.result.status, 0, declined.result.output)
  assert.equal(piInstalls(declined.calls()).includes('npm:pi-claude-bridge'), false)
  assert.match(declined.result.output, /Skipped npm:pi-claude-bridge/)
} finally {
  if (existsSync(join(sandbox, 'readonly-npm-prefix')))
    chmodSync(join(sandbox, 'readonly-npm-prefix'), 0o755)
  rmSync(sandbox, { recursive: true, force: true })
}
