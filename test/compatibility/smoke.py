"""Optional manual PTY smoke; only run against disposable project copies.

Usage: python3 test/compatibility/smoke.py baseline regular /tmp/compat-workspace
Requires Python 3 + pexpect; no project or extension dependency is added.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import time
import pexpect

FIXTURES = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('variant', choices=('baseline', 'current'))
parser.add_argument('mode', choices=('regular', 'fullscreen'))
parser.add_argument('workspace', type=Path)
options = parser.parse_args()
if options.variant == 'baseline' and options.mode != 'regular':
    parser.error('The baseline is only verified in regular mode')
ROOT = options.workspace.resolve()
PROJECT = ROOT / options.variant
if not (PROJECT / 'package.json').is_file() or PROJECT.resolve() == FIXTURES.parents[1]:
    parser.error('Prepare disposable baseline/current project copies first; do not use the checkout')
NODE = shutil.which('node')
if NODE is None:
    parser.error('node is required')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def run(variant, mode):
    project = ROOT / variant
    run_dir = ROOT / f'{variant}-{mode}'
    agent = run_dir / 'agent'
    home = run_dir / 'home'
    cwd = run_dir / 'cwd'
    for p in (agent, home, cwd):
        p.mkdir(parents=True, exist_ok=True)
    evidence = ROOT / 'evidence'
    evidence.mkdir(exist_ok=True)
    events = evidence / f'{variant}-{mode}-events.jsonl'
    events.write_text('')
    settings = {
        'managementUrl': 'https://management.example.invalid',
        'managementKey': 'synthetic-only',
        'refreshMinutes': 60,
        'maxVisibleAccounts': 4,
        'providers': {'claude': True, 'codex': True, 'deepseek': True, 'grok': True, 'kimi': True},
    }
    (agent / 'pi-cliproxy-usage.json').write_text(json.dumps(settings))
    (agent / 'settings.json').write_text(json.dumps({'quietStartup': True, 'tuiMode': mode}))
    shutil.copyfile(FIXTURES / 'fixture-template.ts.in', project / 'compatibility-smoke.ts')
    env = {
        'PATH': os.environ['PATH'],
        'HOME': str(home),
        'XDG_CONFIG_HOME': str(home / '.config'),
        'XDG_CACHE_HOME': str(home / '.cache'),
        'XDG_DATA_HOME': str(home / '.local/share'),
        'TERM': 'xterm-256color',
        'LANG': 'C.UTF-8',
        'PI_CODING_AGENT_DIR': str(agent),
        'PI_OFFLINE': '1',
        'PI_SKIP_VERSION_CHECK': '1',
        'PI_TELEMETRY': '0',
        'PI_IMAGE_PROTOCOL': 'none',
        'COMPAT_EVENTS': str(events),
    }
    cli = project / 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
    args = ['--import', str(FIXTURES / 'network-guard.mjs'), str(cli),
            '--no-extensions', '-e', str(project / 'compatibility-smoke.ts'),
            '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
            '--offline', '--no-session', '--model', 'openai/gpt-4o', '--api-key', 'synthetic-only']
    if variant == 'current':
        args += ['--no-mcp', '--tui-mode', mode]
    sdk_version = json.loads((project / 'node_modules/@earendil-works/pi-coding-agent/package.json').read_text())['version']
    result = {'variant': variant, 'sdk_version': sdk_version, 'mode': mode, 'checks': [], 'status': 'running'}
    child = pexpect.spawn(NODE, args, cwd=str(cwd), env=env, dimensions=(40, 120), encoding='utf-8', timeout=25)
    transcript = (evidence / f'{variant}-{mode}-pty.log').open('w')
    child.logfile_read = transcript
    try:
        def wait(text):
            child.expect_exact(text)
            result['checks'].append(text)
        def drain_until_quiet():
            # Consume pexpect's buffered tail and fresh output, so the next
            # assertion cannot match a previous operation's redraw.
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    child.expect(r'(?s).+', timeout=0.25)
                except pexpect.TIMEOUT:
                    return
            raise RuntimeError('PTY did not reach an output-quiet boundary')
        def key(data):
            drain_until_quiet()
            child.send(data)
        def command(text):
            drain_until_quiet()
            child.send(text)
            time.sleep(0.15)
            # Exact argument completions consume Enter; dismiss only their menu.
            if text.startswith('/cliproxy-usage '):
                child.send('\x1b')
                time.sleep(0.15)
            child.send('\r')
        def event_list():
            return [json.loads(line) for line in events.read_text().splitlines()]
        wait('left 75%')
        command('/cliproxy-usage')
        wait('CLIProxyAPI Usage')
        wait('Enter/Esc close')
        key('r')
        # A widget row has no reset countdown. Require the updated details row,
        # rather than accepting the underlying widget's earlier redraw.
        child.expect(r'│[^\r\n]*7d[^\r\n]*left 65%[^\r\n]*resets in 2d[^\r\n]*│')
        result['checks'].append('updated details row: 7d left 65%, resets in 2d')
        key('\x1b')
        time.sleep(0.3)
        # Reopen to prove the first overlay closed and another can be constructed.
        command('/cliproxy-usage')
        wait('CLIProxyAPI Usage')
        wait('Enter/Esc close')
        key('\r')
        time.sleep(0.3)
        command('/cliproxy-usage settings')
        wait('CLIProxyAPI Usage Settings')
        wait('Refresh interval')
        key('\x1b')
        time.sleep(0.3)
        command('/cliproxy-usage status')
        wait('Current usage provider: Codex')
        wait('Last refresh:')
        command('/compat-model unsupported')
        wait('SMOKE_MODEL o3')
        command('/cliproxy-usage')
        wait('has no supported CLIProxyAPI usage source.')
        command('/compat-model supported')
        wait('SMOKE_MODEL gpt-4o')
        command('/compat-exit')
        child.expect(pexpect.EOF)
        child.close()
        data = event_list()
        assert child.exitstatus == 0 and child.signalstatus is None, (child.exitstatus, child.signalstatus)
        assert not any(e['kind'] == 'blocked-network' for e in data), 'Network was attempted'
        assert sum(e['kind'] == 'mock-restored' for e in data) == 1, data
        assert sum(e['kind'] == 'discovery' for e in data) == 2, data
        assert sum(e['kind'] == 'quota' for e in data) == 2, data
        assert any(e['kind'] == 'session-start' and e['mode'] == 'tui' and e['hasUI'] for e in data)
        assert [e['id'] for e in data if e['kind'] == 'model'] == ['o3', 'gpt-4o'], data
        assert sum(e['kind'] == 'shutdown' for e in data) == 1, data
        result.update(status='passed', exitstatus=child.exitstatus, quota_requests=2, unexpected_network=0)
    except Exception as exc:
        result.update(status='failed', error=str(exc))
        if child.isalive():
            child.terminate(force=True)
        raise
    finally:
        transcript.close()
        raw = (evidence / f'{variant}-{mode}-pty.log').read_text()
        (evidence / f'{variant}-{mode}-pty.txt').write_text(ANSI.sub('', raw))
        (evidence / f'{variant}-{mode}-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    run(options.variant, options.mode)
