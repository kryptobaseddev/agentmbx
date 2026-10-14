#!/usr/bin/env python3
"""Summarize one spawn-sampler.py report: installed agentmbx starts grouped by kind and harness.

Usage: python3 spawn-summarize.py report.json
Harness = first of grok/opencode/codex/kimi/tui_gateway(hermes)/claude found in the ancestor chain.
Dev-checkout and test-suite starts (argv not under node_modules/agentmbx) are counted separately, by subtree, and left out
of the table, because other agents' test runs otherwise dominate. Grok's own hook curl calls are skipped.
"""
import json, collections, re, sys

d = json.load(open(sys.argv[1]))
print('seconds', d['seconds'], 'polls', d['polls'], 'poll_ms', d['poll_ms'], 'resident agentmbx processes', d['resident_count'])
c = collections.Counter(); test = collections.Counter()
for e in d['events']:
    av = e['argv']; a = ' '.join(av); ch = ' '.join(e['chain'][:4]).lower()
    harness = next((h for h in ['grok', 'opencode', 'codex', 'kimi', 'tui_gateway', 'claude'] if re.search(r'(^|[/ ])' + h, ch)), 'other')
    if 'hook/grok' in a or 'data-urlencode' in a:
        continue
    if len(av) > 1 and av[1].endswith('claude-posttool.sh'):
        k = 'sh wrapper claude-posttool.sh (no node)'
    elif e['parent_agentmbx']:
        k = f"child of resident {e['parent_agentmbx'].split()[0]}: {e['comm']} ({e.get('final')})"
    elif 'node_modules/agentmbx' in a:
        m = re.search(r'agentmbx\.js\s+(\S+(?:\s+\S+){0,2})', a)
        k = 'node agentmbx ' + (m.group(1) if m else '?')
    elif e['agentmbx']:
        test[harness] += 1
        continue
    else:
        k = f"other {e['comm']} {a[:50]}"
    c[(k, harness)] += 1
for (k, h), v in sorted(c.items(), key=lambda x: (x[0][0], -x[1])):
    print(f'{v:3d}  {h:9s} {k}')
print('agentmbx starts from a dev checkout/test suite (not installed), by subtree:', dict(test))
