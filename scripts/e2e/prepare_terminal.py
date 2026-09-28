"""Prepare owner-operated native sessions. Preparation never starts a provider."""
import argparse
import json
from pathlib import Path
import shlex
import tempfile


def prepare_terminal(provider, root):
    base = Path(tempfile.mkdtemp(prefix='mbx-' + provider + '-native-')).resolve()
    home, work = base / 'mailbox', base / 'work'
    home.mkdir(mode=0o700)
    work.mkdir(mode=0o700)
    mbx = str(Path(root) / 'bin' / 'agentmbx.js')
    environment = {'MBX_HOME': str(home), 'MBX_AGENT': provider + '-native',
                   'MBX_CLI': provider, 'MBX_NO_DESKTOP': '1'}
    if provider == 'claude':
        config = base / 'mcp.json'
        config.write_text(json.dumps({'mcpServers': {'mbx': {
            'command': 'node', 'args': [mbx, 'mcp'], 'env': environment}}}, indent=2))
        config.chmod(0o600)
        argv = ['claude', '--mcp-config', str(config), '--strict-mcp-config',
                '--dangerously-load-development-channels', 'server:mbx']
    elif provider == 'codex':
        # JSON strings are valid TOML basic strings for these generated paths/values.
        settings = {'mcp_servers.mbx.command': json.dumps('node'),
                    'mcp_servers.mbx.args': json.dumps([mbx, 'mcp']),
                    'mcp_servers.mbx.env': '{' + ','.join(k + '=' + json.dumps(v) for k, v in environment.items()) + '}'}
        argv = ['codex', '--no-daemon', '--no-alt-screen', '--sandbox', 'read-only', '--ask-for-approval', 'on-request']
        for key, value in settings.items():
            argv += ['-c', key + '=' + value]
    else:
        raise ValueError('Unsupported provider')
    launch = base / 'launch.sh'
    launch.write_text('#!/bin/sh\nset -eu\n'
        'if ! [ -t 0 ] || ! [ -t 1 ]; then\n'
        '  echo "Open this launch script in your interactive terminal; no provider was started." >&2\n'
        '  exit 3\nfi\n' +
        '\n'.join('export ' + k + '=' + shlex.quote(v) for k, v in environment.items()) + '\n' +
        'cd ' + shlex.quote(str(work)) + '\nexec ' + shlex.join(argv) + '\n')
    launch.chmod(0o700)
    report = {'provider': provider, 'outcome': 'prepared_owner_launch', 'provider_started': False,
              'receipt_verified': False, 'mbx_home': str(home), 'work': str(work),
              'launch_script': str(launch), 'argv': argv,
              'next': 'Run launch_script in your terminal and handle provider prompts there. Keep that terminal open. No wake request has been sent.'}
    (base / 'launch-result.json').write_text(json.dumps(report, indent=2))
    return report


def entry(provider, root):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', action='store_true', help='Write an owner-operated launch script; do not start a provider')
    options = parser.parse_args()
    if options.prepare:
        print(json.dumps(prepare_terminal(provider, root)))
        return 0
    print(json.dumps({'provider': provider, 'outcome': 'blocked_harness_unsupported',
                      'reason': 'Unattended launch is disabled. Use --prepare for an owner-operated terminal session (T105).',
                      'provider_started': False, 'receipt_verified': False}))
    return 3
