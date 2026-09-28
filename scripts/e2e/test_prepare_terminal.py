"""Exercise launch scripts using fake providers; no native CLI or model is started."""
import json
import os
from pathlib import Path
import pty
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch


class TerminalLaunchTest(unittest.TestCase):
    def test_preparation_and_owner_terminal_boundary(self):
        prepare = runpy.run_path(str(Path(__file__).with_name('prepare_terminal.py')))['prepare_terminal']
        original_mkdtemp = tempfile.mkdtemp
        for provider in ('claude', 'codex'):
            with self.subTest(provider=provider), tempfile.TemporaryDirectory(prefix="owner's space ") as directory:
                root = Path(directory)
                marker = root / 'invocation.json'
                fake = root / provider
                fake.write_text('#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nPath(os.environ["TEST_MARKER"]).write_text(json.dumps({"argv":sys.argv[1:],"home":os.environ["MBX_HOME"],"cwd":os.getcwd()}))\n')
                fake.chmod(0o700)
                with patch('tempfile.mkdtemp', lambda **kw: original_mkdtemp(dir=root, **kw)):
                    report = prepare(provider, root)
                self.assertFalse(marker.exists())
                self.assertFalse(report['provider_started'])
                self.assertFalse(report['receipt_verified'])
                env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'], TEST_MARKER=str(marker))
                blocked = subprocess.run(['sh', report['launch_script']], stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=5)
                self.assertEqual(blocked.returncode, 3)
                self.assertFalse(marker.exists())
                master, slave = pty.openpty()
                try:
                    launched = subprocess.run(['sh', report['launch_script']], stdin=slave, stdout=slave, stderr=slave, env=env, timeout=5)
                    self.assertEqual(launched.returncode, 0)
                finally:
                    os.close(slave); os.close(master)
                invocation = json.loads(marker.read_text())
                self.assertEqual(invocation['argv'], report['argv'][1:])
                self.assertEqual(invocation['home'], report['mbx_home'])
                self.assertEqual(invocation['cwd'], report['work'])
                self.assertFalse((Path(report['mbx_home']) / 'mbx.db').exists())
                for forbidden in ('--allowedTools', '--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', 'approval_policy="never"', 'trust_level="trusted"', 'default_tools_approval_mode="approve"'):
                    self.assertNotIn(forbidden, ' '.join(invocation['argv']))


if __name__ == '__main__':
    unittest.main()
