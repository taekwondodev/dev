import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ttyScript } from '../../src/orb/ssh.ts'

const PTY_RUN = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'dumb'
    os.execvp('bash', ['bash', '-c', sys.argv[1]])
deadline, out, done = time.time() + 5, b'', False
while time.time() < deadline:
    if select.select([fd], [], [], 0.2)[0]:
        try:
            data = os.read(fd, 4096)
        except OSError:
            done = True
            break
        if not data:
            done = True
            break
        out += data
    elif os.waitpid(pid, os.WNOHANG)[0] != 0:
        done = True
        break
if not done:
    os.kill(pid, 9)
sys.stdout.write(('finished' if done else 'hung') + '\\n' + out.decode(errors='replace'))
`

const repo = mkdtempSync(join(tmpdir(), 'orb-pager-'))
try {
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', repo, ...args],
      { stdio: 'ignore' }
    )
  git('init', '-q')
  for (let i = 0; i < 10; i++) git('commit', '-q', '--allow-empty', '-m', `commit ${i}`)

  const run = spawnSync('python3', ['-I', '-c', PTY_RUN, ttyScript(repo, 'git log --oneline')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: repo },
  })
  assert.equal(run.status, 0, run.stderr)
  const [state, ...output] = run.stdout.split('\n')
  assert.equal(state, 'finished', `the paging command hung:\n${output.join('\n')}`)
  assert.match(output.join('\n'), /commit 0/)
  assert.doesNotMatch(output.join('\n'), /RETURN/)
} finally {
  rmSync(repo, { recursive: true, force: true })
}
