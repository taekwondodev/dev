import json
import os
import pty
import re
import select
import signal
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts' / 'workspace-host-real-authority-probe.ts'
LOG = Path(tempfile.gettempdir()) / 'dev-workspace-real-authority-pty.log'
TIMEOUT = 240
MARKER = 'DEV_REAL_AUTHORITY_PROBE_PASSED '
ACTIONS = {
    'DEV_REAL_AUTHORITY_READY_FOR_USER_BASH': b'\x15!printf user-bash > user.txt\r',
    'DEV_REAL_AUTHORITY_READY_FOR_RELOAD': b'\x15/reload\r',
}

env = os.environ.copy()
env.update({
    'TERM': 'xterm-256color',
    'COLUMNS': '110',
    'LINES': '36',
    'PI_OFFLINE': '1',
    'PI_TELEMETRY_DISABLED': '1',
})

pid, master = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    os.execvpe('node', ['node', str(SCRIPT)], env)

os.set_blocking(master, False)
start = time.monotonic()
transcript = bytearray()
exit_status = None
sent = []

with LOG.open('wb') as log:
    while time.monotonic() - start < TIMEOUT:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                block = os.read(master, 65536)
            except OSError:
                block = b''
            if block:
                log.write(block)
                log.flush()
                transcript.extend(block)
        text = transcript.decode('utf-8', errors='replace')
        for trigger, keys in ACTIONS.items():
            if trigger in text and trigger not in sent:
                os.write(master, keys)
                sent.append(trigger)
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            exit_status = status
            break

if exit_status is None:
    os.kill(pid, signal.SIGTERM)
    _, exit_status = os.waitpid(pid, 0)

text = transcript.decode('utf-8', errors='replace')
match = re.search(re.escape(MARKER) + r'(\{.+?\})\r?\n', text, re.DOTALL)
report = json.loads(match.group(1)) if match else None
missing = sorted(set(ACTIONS) - set(sent))
print(json.dumps({
    'exit_status_raw': exit_status,
    'timed_out': time.monotonic() - start >= TIMEOUT,
    'passed_marker': report is not None,
    'missing_actions': missing,
    'report': report,
    'pty_log': str(LOG),
    'output_tail': text[-6000:] if report is None else '',
}, ensure_ascii=False, indent=2))
if not os.WIFEXITED(exit_status) or os.WEXITSTATUS(exit_status) != 0 or report is None or missing:
    raise SystemExit(1)
