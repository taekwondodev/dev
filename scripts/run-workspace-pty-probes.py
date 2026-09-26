# Drives the workspace host probes through the real Pi TUI in a pseudo-terminal. Python only
# because Node has no built-in pseudo-terminal; each probe is TypeScript and describes here only
# the keys a user types when it prints a marker.
import json
import os
import pty
import re
import select
import signal
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Action:
    name: str
    trigger: str
    keys: bytes
    required: bool = True
    delay: float = 0.0


@dataclass(frozen=True)
class Probe:
    script: str
    passed_marker: str
    actions: tuple[Action, ...]
    timeout: float = 240.0
    fixture_marker: str | None = None


def stub_actions() -> tuple[Action, ...]:
    task_lead = '00000000-0000-4000-8000-000000000001'
    task_fail = '00000000-0000-4000-8000-000000000005'
    task_resume = '00000000-0000-4000-8000-000000000006'
    ws_fail = '00000000-0000-4000-8000-000000000015'
    ws_resume_a = '00000000-0000-4000-8000-000000000016'
    ws_resume_c = '00000000-0000-4000-8000-000000000017'
    return (
        Action('pending', 'DEV36_INITIAL_AGENT_START',
               b'queued while the stale native/custom batch was pending\r'),
        Action('bash-one', 'DEV36_READY_FOR_BASH', b'\x15!echo dev36-one | tee user-bash-one.txt\r'),
        Action('bash-two', 'DEV36_BASH_RESULT_1', b'!!echo dev36-two | tee user-bash-two.txt\r'),
        Action('start-work', 'DEV36_READY_FOR_WORK', b'start background work\r'),
        Action('agent-abort', 'DEV36_READY_FOR_AGENT_ABORT', b'non-user agent abort probe\r'),
        Action('genuine-cancel', 'DEV36_AGENT_ABORTED_WITHOUT_ESCAPE_CANCELLED_WORK',
               b'genuine terminal Escape cancellation\r'),
        Action('provider-escape', 'DEV36_CANCEL_PROVIDER_STARTED', b'\x1b'),
        Action('retained-work', 'DEV36_READY_FOR_RETAINED_WORK', b'start retained work\r'),
        Action('workspace-list', 'DEV36_READY_FOR_COMMANDS', b'/workspace list\r'),
        Action('workspace-inspect', 'DEV36_COMMAND_DONE:list:1',
               f'/workspace inspect {task_lead}\r'.encode()),
        Action('resume-cancel', 'DEV36_COMMAND_DONE:inspect:1',
               f'/workspace resume {task_resume}\r'.encode()),
        Action('selector-escape', 'DEV36_SELECTOR_OPEN', b'\x1b', delay=0.25),
        Action('resume-explicit', 'DEV36_COMMAND_DONE:resume:1',
               f'/workspace resume {task_resume} --workspace {ws_resume_a}\r'.encode()),
        Action('confirm-live-work', 'DEV36_CONFIRM_SWITCH_OPEN_1', b'y\r'),
        Action('confirm-retained-work', 'DEV36_CONFIRM_SWITCH_OPEN_2', b'y\r', required=False),
        Action('resume-refused', 'DEV36_READY_FOR_REFUSED_SWITCH',
               f'/workspace resume {task_resume} --workspace {ws_resume_c}\r'.encode()),
        Action('resume-failure', 'DEV36_READY_FOR_FAILED_REBIND',
               f'/workspace resume {task_fail} --workspace {ws_fail}\r'.encode()),
    )


PROBES = {
    # A stub lifecycle, for fault injection the real authority cannot be driven into.
    'stub': Probe(
        script='scripts/workspace-host-pty-probe.ts',
        passed_marker='DEV36_TUI_HOST_PROBE_PASSED ',
        fixture_marker='DEV36_FIXTURE ',
        actions=stub_actions(),
    ),
    # Every workspace decision real, to catch drift at the seam the stub cannot see.
    'real': Probe(
        script='scripts/workspace-host-real-authority-probe.ts',
        passed_marker='DEV_REAL_AUTHORITY_PROBE_PASSED ',
        actions=(
            Action('user-bash', 'DEV_REAL_AUTHORITY_READY_FOR_USER_BASH',
                   b'\x15!printf user-bash > user.txt\r'),
            Action('reload', 'DEV_REAL_AUTHORITY_READY_FOR_RELOAD', b'\x15/reload\r'),
        ),
    ),
}


def run(name: str, probe: Probe) -> bool:
    log_fd, log_path = tempfile.mkstemp(prefix=f'dev-workspace-pty-{name}-', suffix='.log')
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
        os.execvpe('node', ['node', str(ROOT / probe.script)], env)

    os.set_blocking(master, False)
    start = time.monotonic()
    transcript = bytearray()
    exit_status = None
    sent: list[str] = []
    with os.fdopen(log_fd, 'wb') as log:
        while time.monotonic() - start < probe.timeout:
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
            for action in probe.actions:
                if action.name not in sent and action.trigger in text:
                    if action.delay:
                        time.sleep(action.delay)
                    os.write(master, action.keys)
                    sent.append(action.name)
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                exit_status = status
                break
    timed_out = exit_status is None
    if timed_out:
        os.kill(pid, signal.SIGTERM)
        _, exit_status = os.waitpid(pid, 0)

    text = transcript.decode('utf-8', errors='replace')
    match = re.search(re.escape(probe.passed_marker) + r'(\{[^\r\n]+\})', text)
    report = json.loads(match.group(1)) if match else None
    fixture = (
        re.search(re.escape(probe.fixture_marker) + r'([^\r\n]+)', text)
        if probe.fixture_marker else None
    )
    missing = sorted(action.name for action in probe.actions
                     if action.required and action.name not in sent)
    passed = (os.WIFEXITED(exit_status) and os.WEXITSTATUS(exit_status) == 0
              and report is not None and not missing)
    print(json.dumps({
        'probe': name,
        'script': probe.script,
        'exit_status_raw': exit_status,
        'timed_out': timed_out,
        'passed_marker': report is not None,
        'sent_actions': sent,
        'missing_actions': missing,
        'report': report,
        'pty_log': log_path,
        'fixture': fixture.group(1) if fixture else None,
        'output_tail': '' if passed else text[-12000:],
    }, ensure_ascii=False, indent=2))
    return passed


if __name__ == '__main__':
    selected = sys.argv[1:] or list(PROBES)
    unknown = [name for name in selected if name not in PROBES]
    if unknown:
        raise SystemExit(f'Unknown probe(s) {unknown}; choose from {sorted(PROBES)}')
    results = [run(name, PROBES[name]) for name in selected]
    if not all(results):
        raise SystemExit(1)
