"""Run the native harness with mocked provider/process boundaries; never starts an agent."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.request


class PermissionBoundaryTest(unittest.TestCase):
    def test_pending_permissions_are_retained_without_approval(self):
        for action in ["mcp__mbx__mbx_inbox", "unrelated command containing mbx"]:
            with self.subTest(action=action), tempfile.TemporaryDirectory() as root:
                calls = []
                original_open = open
                original_mkdtemp = tempfile.mkdtemp

                def local_open(path, *args, **kwargs):
                    if str(path).endswith("/.config/opencode/service.json"):
                        return io.StringIO(json.dumps({"password": "test-only"}))
                    return original_open(path, *args, **kwargs)

                def command(args, **kwargs):
                    self.assertTrue(kwargs.get("check"), "Subprocess failures must stop the harness")
                    output = "http://provider.invalid" if args[:3] == ["opencode", "service", "status"] else ""
                    if "send" in args:
                        output = "test-message-id"
                    return subprocess.CompletedProcess(args, 0, output, "")

                def request(req, **kwargs):
                    calls.append((req.method, req.full_url))
                    if req.method == "POST" and req.full_url.endswith("/api/session"):
                        return io.BytesIO(json.dumps({"data": {"id": "ses_test"}}).encode())
                    if req.method == "GET" and req.full_url.endswith("/permission"):
                        return io.BytesIO(json.dumps({"data": [{"id": "per_test", "action": action}]}).encode())
                    raise AssertionError(f"Unexpected provider action: {req.method} {req.full_url}")

                with patch("builtins.open", local_open), patch("tempfile.mkdtemp", lambda **kw: original_mkdtemp(dir=root, **kw)), \
                     patch("sys.argv", ["wake-opencode.py"]), patch("subprocess.run", command), patch("urllib.request.urlopen", request), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as exit_result:
                        runpy.run_path(str(Path(__file__).with_name("wake-opencode.py")), run_name="__main__")
                self.assertEqual(exit_result.exception.code, 3)
                self.assertEqual([method for method, _ in calls], ["POST", "GET"])
                reports = list(Path(root).glob("*/wake-result.json"))
                self.assertEqual(len(reports), 1)
                report = json.loads(reports[0].read_text())
                self.assertEqual(report["outcome"], "awaiting_owner_approval")
                self.assertEqual(report["session_id"], "ses_test")
                self.assertEqual(report["permissions"], [{"id": "per_test", "action": action}])
                calls.clear()
                resumed_commands = []
                def resume_command(args, **kwargs):
                    resumed_commands.append(args)
                    return command(args, **kwargs)
                with patch("builtins.open", local_open), patch("sys.argv", ["wake-opencode.py", "--resume", str(reports[0])]), \
                     patch("subprocess.run", resume_command), patch("urllib.request.urlopen", request), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as resumed:
                        runpy.run_path(str(Path(__file__).with_name("wake-opencode.py")), run_name="__main__")
                self.assertEqual(resumed.exception.code, 3)
                self.assertEqual([method for method, _ in calls], ["GET"])
                self.assertEqual(len(resumed_commands), 2)  # service status and original thread only
                self.assertEqual(resumed_commands[1][-2:], ["thread", "test-message-id"])
                after = json.loads(reports[0].read_text())
                for key in ("session_id", "message_id", "token", "mbx_home", "work"):
                    self.assertEqual(after[key], report[key])



if __name__ == "__main__":
    unittest.main()
