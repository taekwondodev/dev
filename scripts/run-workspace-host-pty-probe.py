import json
import os
import pty
import re
import select
import signal
import tempfile
import time
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
SCRIPT = os.path.join(ROOT, 'scripts', 'workspace-host-pty-probe.ts')
LOG_FD, LOG = tempfile.mkstemp(prefix='dev36-host-workspace-pty-', suffix='.log')
TASK_RESUME = '00000000-0000-4000-8000-000000000006'
TASK_LEAD = '00000000-0000-4000-8000-000000000001'
WS_RESUME_A = '00000000-0000-4000-8000-000000000016'
WS_RESUME_C = '00000000-0000-4000-8000-000000000017'
TASK_FAIL = '00000000-0000-4000-8000-000000000005'
WS_FAIL = '00000000-0000-4000-8000-000000000015'
TIMEOUT = 240

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
    os.execvpe('node', ['node', SCRIPT], env)

os.set_blocking(master, False)
start = time.monotonic()
transcript = bytearray()
exit_status = None
sent = set()


def send_once(key, value):
    if key in sent:
        return
    os.write(master, value)
    sent.add(key)


with os.fdopen(LOG_FD, 'wb') as log:
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

        if 'DEV36_INITIAL_AGENT_START' in text:
            send_once('pending', b'queued while the stale native/custom batch was pending\r')
        if 'DEV36_READY_FOR_BASH' in text:
            send_once('bash-one', b'\x15!echo dev36-one | tee user-bash-one.txt\r')
        if 'DEV36_BASH_RESULT_1' in text:
            send_once('bash-two', b'!!echo dev36-two | tee user-bash-two.txt\r')
        if 'DEV36_READY_FOR_WORK' in text:
            send_once('start-work', b'start background work\r')
        if 'DEV36_READY_FOR_AGENT_ABORT' in text:
            send_once('agent-abort', b'non-user agent abort probe\r')
        if 'DEV36_AGENT_ABORTED_WITHOUT_ESCAPE_CANCELLED_WORK' in text:
            send_once('genuine-cancel', b'genuine terminal Escape cancellation\r')
        if 'DEV36_CANCEL_PROVIDER_STARTED' in text:
            send_once('provider-escape', b'\x1b')
        if 'DEV36_READY_FOR_RETAINED_WORK' in text:
            send_once('retained-work', b'start retained work\r')
        if 'DEV36_READY_FOR_COMMANDS' in text:
            send_once('workspace-list', b'/workspace list\r')
        if 'DEV36_COMMAND_DONE:list:1' in text:
            send_once('workspace-inspect', f'/workspace inspect {TASK_LEAD}\r'.encode())
        if 'DEV36_COMMAND_DONE:inspect:1' in text:
            send_once('resume-cancel', f'/workspace resume {TASK_RESUME}\r'.encode())
        if 'DEV36_SELECTOR_OPEN' in text and 'selector-escape' not in sent:
            time.sleep(0.25)
            send_once('selector-escape', b'\x1b')
        if 'DEV36_COMMAND_DONE:resume:1' in text:
            send_once('resume-explicit', f'/workspace resume {TASK_RESUME} --workspace {WS_RESUME_A}\r'.encode())
        if 'DEV36_CONFIRM_SWITCH_OPEN_1' in text:
            send_once('confirm-live-work', b'y\r')
        if 'DEV36_CONFIRM_SWITCH_OPEN_2' in text:
            send_once('confirm-retained-work', b'y\r')
        if 'DEV36_READY_FOR_REFUSED_SWITCH' in text:
            send_once('resume-refused', f'/workspace resume {TASK_RESUME} --workspace {WS_RESUME_C}\r'.encode())
        if 'DEV36_READY_FOR_FAILED_REBIND' in text:
            send_once('resume-failure', f'/workspace resume {TASK_FAIL} --workspace {WS_FAIL}\r'.encode())

        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            exit_status = status
            break

if exit_status is None:
    os.kill(pid, signal.SIGTERM)
    _, exit_status = os.waitpid(pid, 0)

text = transcript.decode('utf-8', errors='replace')
marker = 'DEV36_TUI_HOST_PROBE_PASSED '
match = re.search(re.escape(marker) + r'(\{[^\r\n]+\})', text)
report = json.loads(match.group(1)) if match else None
fixture = re.search(r'DEV36_FIXTURE ([^\r\n]+)', text)
required = {
    'pending', 'bash-one', 'bash-two', 'start-work', 'agent-abort', 'genuine-cancel',
    'provider-escape', 'retained-work', 'workspace-list', 'workspace-inspect', 'resume-cancel',
    'selector-escape', 'resume-explicit', 'confirm-live-work', 'resume-refused', 'resume-failure',
}
summary = {
    'exit_status_raw': exit_status,
    'timed_out': time.monotonic() - start >= TIMEOUT,
    'passed_marker': report is not None,
    'sent_actions': sorted(sent),
    'missing_actions': sorted(required - sent),
    'report': report,
    'pty_log': LOG,
    'fixture': fixture.group(1) if fixture else None,
    'output_tail': text[-12000:],
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
if (
    not os.WIFEXITED(exit_status)
    or os.WEXITSTATUS(exit_status) != 0
    or report is None
    or required - sent
):
    raise SystemExit(1)
