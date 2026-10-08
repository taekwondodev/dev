from __future__ import annotations

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

ROOT = Path(__file__).resolve().parents[2]
ESCAPES = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


@dataclass(frozen=True)
class Action:
    name: str
    trigger: str
    keys: str
    required: bool = True
    delay: float = 0.0

    occurrence: int = 1


@dataclass(frozen=True)
class Probe:
    script: str
    passed_marker: str
    actions: tuple[Action, ...]
    timeout: float = 240.0
    fixture_marker: str | None = None
    inputs_marker: str | None = None


    expect: tuple[str, ...] = ()
    expect_raw: tuple[str, ...] = ()

    env: tuple[tuple[str, str], ...] = ()


STUB_ACTIONS = (
    Action('pending', 'DEV36_INITIAL_AGENT_START',
           'queued while the stale native/custom batch was pending\r'),
    Action('bash-one', 'DEV36_READY_FOR_BASH', '\x15!echo dev36-one | tee user-bash-one.txt\r'),
    Action('bash-two', 'DEV36_BASH_RESULT_1', '!!echo dev36-two | tee user-bash-two.txt\r'),
    Action('start-work', 'DEV36_READY_FOR_WORK', 'start background work\r'),
    Action('agent-abort', 'DEV36_READY_FOR_AGENT_ABORT', 'non-user agent abort probe\r'),
    Action('genuine-cancel', 'DEV36_AGENT_ABORTED_WITHOUT_ESCAPE_CANCELLED_WORK',
           'genuine terminal Escape cancellation\r'),
    Action('provider-escape', 'DEV36_CANCEL_PROVIDER_STARTED', '\x1b'),
    Action('retained-work', 'DEV36_READY_FOR_RETAINED_WORK', 'start retained work\r'),
    Action('workspace-list', 'DEV36_READY_FOR_COMMANDS', '/workspace list\r'),
    Action('workspace-inspect', 'DEV36_COMMAND_DONE:list:1', '/workspace inspect {TASK_LEAD}\r'),
    Action('release-other', 'DEV36_COMMAND_DONE:inspect:1', '/workspace release {TASK_RESUME}\r'),
    Action('release-own', 'DEV36_COMMAND_DONE:release:1', '/workspace release {TASK_B}\r'),
    Action('resume-ambiguous', 'DEV36_READY_FOR_AMBIGUOUS_RESUME', 'resume the retained task\r'),
    Action('resume-live', 'DEV36_READY_FOR_LIVE_RESUME', 'resume its first workspace\r'),
    Action('work-stop', 'DEV36_READY_FOR_WORK_STOP', '/work stop\r'),
    Action('resume-explicit', 'DEV36_READY_FOR_EXPLICIT_RESUME', 'resume it now\r'),
    Action('resume-refused', 'DEV36_READY_FOR_REFUSED_SWITCH', 'resume the other workspace\r'),
    Action('resume-failure', 'DEV36_READY_FOR_FAILED_REBIND', 'resume the failing task\r'),
)


QUIT_ACTIONS = (
    Action('quit', 'Press ctrl+o to show full startup help', '\x15/quit\r', delay=2.0),
)


PROBES = {

    'compaction': Probe(
        script='tests/workspace/compaction-pty-probe.ts',
        passed_marker='DEV_COMPACTION_PTY_PASSED ',
        timeout=120.0,
        actions=(
            Action('idle-escape', 'DEV_COMPACTION_IDLE_ESCAPE', '\x1b'),
            Action('ready-escape', 'DEV_COMPACTION_READY_ESCAPE', '\x1b'),
        ),
    ),

    'stub': Probe(
        script='tests/workspace/workspace-host-pty-probe.ts',
        passed_marker='DEV36_TUI_HOST_PROBE_PASSED ',
        fixture_marker='DEV36_FIXTURE ',
        inputs_marker='DEV36_INPUTS ',
        actions=STUB_ACTIONS,
    ),


    'real': Probe(
        script='tests/workspace/workspace-host-real-authority-probe.ts',
        passed_marker='DEV_REAL_AUTHORITY_PROBE_PASSED ',
        inputs_marker='DEV_REAL_AUTHORITY_INPUTS ',
        actions=(
            Action('after-refused-allocation', 'DEV_REAL_AUTHORITY_READY_FOR_NEXT_CALL',
                   '\x15continue after the refused allocation\r'),
            Action('user-bash', 'DEV_REAL_AUTHORITY_READY_FOR_USER_BASH',
                   '\x15!printf user-bash > user.txt\r'),
            Action('reload', 'DEV_REAL_AUTHORITY_READY_FOR_RELOAD', '\x15/reload\r'),
            Action('check', 'DEV_REAL_AUTHORITY_READY_FOR_CHECK',
                   '\x15/workspace check {TASK_HOST}\r'),
            Action('release-own', 'DEV_REAL_AUTHORITY_READY_FOR_OWN_RELEASE',
                   '\x15/workspace release {TASK_HOST}\r'),
            Action('quit', 'DEV_REAL_AUTHORITY_READY_FOR_QUIT', '\x15/quit\r', delay=0.5),
        ),
        expect=('✓ 1 worktree removed', 'Exit 0: done.'),
    ),


    'quit': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=QUIT_ACTIONS,
        expect=('Sweeping workspaces…', '✓ 1 reservation released', '✓ 1 worktree removed',
                'Exit 0: done.'),
        expect_raw=('\x1b]9;4;3\x07', '\x1b]9;4;1;100\x07'),
        env=(('TERM_PROGRAM', 'ghostty'),),
    ),

    'quit-release': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=(*QUIT_ACTIONS, Action('confirm', '[y = release, Enter = keep]', 'y\r', delay=0.5)),
        expect=('dev workspace release {TASK}', 'Status: The worktree directory is missing',
                'Release 1 task (1 managed worktree)?', 'including uncommitted changes and undelivered commits',
                '✓ 1 worktree removed', 'Exit 0: done.'),
        env=(('LAUNCHER_TUI_MISSING_WORKTREE', 'release'),),
    ),

    'quit-release-declined': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=(*QUIT_ACTIONS, Action('decline', '[y = release, Enter = keep]', '\r', delay=0.5)),
        expect=('dev workspace release {TASK}', 'Exit 0: done.'),
        env=(('LAUNCHER_TUI_MISSING_WORKTREE', 'decline'),),
    ),

    'quit-release-interrupt': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=(*QUIT_ACTIONS, Action('interrupt', '[y = release, Enter = keep]', '\x03', delay=0.5)),
        expect=('(cancelled)', 'Exit 130: release cancelled; nothing was released.'),
        env=(('LAUNCHER_TUI_MISSING_WORKTREE', 'interrupt'),),
    ),


    'quit-undelivered': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        actions=(*QUIT_ACTIONS, Action('confirm', '[y = release, Enter = keep]', 'y\r', delay=0.5)),
        expect=('dev workspace release {TASK}',
                'Status: Delivery to the integration target could not be verified.',
                'Release 1 task (1 managed worktree)?', '✓ 1 worktree removed', 'Exit 0: done.'),
        expect_raw=('\x1b[33mdev workspace release ', '\x1b[2mStatus:', '\x1b[31mThis deletes'),
        env=(('LAUNCHER_TUI_UNDELIVERED_WORKTREE', '1'), ('TERM_PROGRAM', 'ghostty')),
    ),

    'quit-self-remove': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=QUIT_ACTIONS,
        expect=('✓ 1 worktree removed', 'Exit 0: done.'),
        env=(('LAUNCHER_TUI_SELF_REMOVE', '1'),),
    ),

    'quit-contained-history': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=QUIT_ACTIONS,
        expect=('Not included in the quick release:',
                'Status: A cleanup guard blocked removal after completion was verified.', 'Exit 1:'),
        env=(('LAUNCHER_TUI_CONTAINED_HISTORY', '1'),),
    ),

    'quit-interrupt': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=QUIT_ACTIONS,
        expect=('Quitting was interrupted before the sweep started; nothing was released.',
                'Exit 130'),
        env=(('LAUNCHER_TUI_FAULT', 'sigint-after-quit'),),
    ),

    'quit-interrupt-during-sweep': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=QUIT_ACTIONS,
        expect=('Interrupt received: the sweep, or a confirmed release, runs on',
                '✓ 1 worktree removed',
                'Exit 130: interrupted after the sweep'),
        env=(('LAUNCHER_TUI_FAULT', 'sigint-during-sweep'),),
    ),

    'interactive-failure': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=(),
        expect=('Pi interactive mode failed', 'injected interactive mode failure'),
        env=(('LAUNCHER_TUI_FAULT', 'interactive-failure'),),
    ),

    'quit-shutdown-failure': Probe(
        script='tests/workspace/workspace-launcher-tui-probe.ts',
        passed_marker='DEV_LAUNCHER_TUI_PROBE_PASSED ',
        inputs_marker='DEV_LAUNCHER_TUI_INPUTS ',
        timeout=240.0,
        actions=QUIT_ACTIONS,
        expect=(
            'Closing the session failed',
            'injected session disposal failure',
            'nothing was swept or released',
            'Exit 1.',
        ),
        env=(('LAUNCHER_TUI_FAULT', 'shutdown-after-quit'),),
    ),

    'release': Probe(
        script='tests/workspace/workspace-release-pty-probe.ts',
        passed_marker='DEV_RELEASE_PTY_PROBE_PASSED ',
        inputs_marker='DEV_RELEASE_INPUTS ',
        timeout=180.0,
        actions=(
            Action('cancel', 'DEV_RELEASE_READY_FOR_CANCEL', 'n\r', delay=1.0),

            Action('ctrl-c', 'Type y to release, anything else to cancel: ', '\x03', delay=0.3,
                   occurrence=2),
            Action('ctrl-z', 'Type y to release, anything else to cancel: ', '\x1a', delay=0.3,
                   occurrence=3),
            Action('ctrl-d', 'Type y to release, anything else to cancel: ', '\x04', delay=0.3,
                   occurrence=4),
            Action('unfinished-confirm', 'DEV_RELEASE_READY_FOR_UNFINISHED', 'y\r', delay=1.0),
            Action('confirm', 'DEV_RELEASE_READY_FOR_CONFIRM', 'y\r', delay=1.0),
        ),
        expect=('the worktree and everything in it are deleted', ': removed', ': released'),
    ),
}


def stop(pid: int, grace: float = 10.0) -> int:
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return status
        time.sleep(0.1)
    os.kill(pid, signal.SIGKILL)
    return os.waitpid(pid, 0)[1]


def run(name: str, probe: Probe) -> bool:
    log_fd, log_path = tempfile.mkstemp(prefix=f'dev-workspace-pty-{name}-', suffix='.log')
    env = os.environ.copy()
    env.update({
        'TERM': 'xterm-256color',
        'COLUMNS': '110',
        'LINES': '36',
        'PI_OFFLINE': '1',
        'PI_TELEMETRY_DISABLED': '1',
        'TERM_PROGRAM': 'probe',
    })
    env.update(dict(probe.env))
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execvpe('node', ['node', str(ROOT / probe.script)], env)

    os.set_blocking(master, False)
    start = time.monotonic()
    transcript = bytearray()
    exit_status = None
    sent: list[str] = []
    inputs: dict[str, str] = {}
    input_error = None
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
            if probe.inputs_marker and not inputs:
                printed = re.search(re.escape(probe.inputs_marker) + r'(\{[^\r\n]+\})', text)
                inputs = json.loads(printed.group(1)) if printed else {}
            for action in probe.actions:
                if action.name in sent:
                    continue
                try:
                    trigger = action.trigger.format_map(inputs)
                    keys = action.keys.format_map(inputs)
                except KeyError as missing:
                    if inputs:
                        input_error = f'{action.name} needs {missing}, which the probe did not print'
                        break
                    continue
                if text.count(trigger) >= action.occurrence:
                    if action.delay:
                        time.sleep(action.delay)
                    os.write(master, keys.encode())
                    sent.append(action.name)
                    break
            if input_error:
                break
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                exit_status = status
                break
    timed_out = exit_status is None and input_error is None
    if exit_status is None:
        exit_status = stop(pid)

    text = transcript.decode('utf-8', errors='replace')
    match = re.search(re.escape(probe.passed_marker) + r'(\{[^\r\n]+\})', text)
    report = json.loads(match.group(1)) if match else None
    fixture = (
        re.search(re.escape(probe.fixture_marker) + r'([^\r\n]+)', text)
        if probe.fixture_marker else None
    )
    missing = sorted(action.name for action in probe.actions
                     if action.required and action.name not in sent)
    missing_output = []
    plain = ESCAPES.sub('', text)
    for needles, haystack in ((probe.expect, plain), (probe.expect_raw, text)):
        for needle in needles:
            try:
                expected = needle.format_map(inputs)
            except KeyError:
                missing_output.append(needle)
                continue
            if expected not in haystack:
                missing_output.append(expected)
    passed = (os.WIFEXITED(exit_status) and os.WEXITSTATUS(exit_status) == 0
              and report is not None and not missing and not missing_output
              and input_error is None)
    print(json.dumps({
        'probe': name,
        'script': probe.script,
        'exit_status_raw': exit_status,
        'timed_out': timed_out,
        'passed_marker': report is not None,
        'sent_actions': sent,
        'missing_actions': missing,
        'missing_output': missing_output,
        'input_error': input_error,
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
