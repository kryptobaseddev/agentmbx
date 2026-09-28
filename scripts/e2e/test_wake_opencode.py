"""Run the native harness with mocked provider/process boundaries; never starts an agent."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.request


def fixture(home):
    db = sqlite3.connect(str(Path(home) / "mbx.db"))
    db.executescript("CREATE TABLE messages (id, thread, from_addr, reply_to, kind, body, envelope, origin, trust); CREATE TABLE deliveries (msg_id, agent, state);")
    db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)", ("test-message-id", "thread", "tester@e2e", None, "request", "request body", json.dumps({"to": ["oc-agent@e2e"]}), "local", "local"))
    db.execute("INSERT INTO deliveries VALUES (?,?,?)", ("test-message-id", "oc-agent", "delivered"))
    db.commit()
    return db


class ReceiptTest(unittest.TestCase):
    def test_exact_reply_and_original_ack_required(self):
        inspect = runpy.run_path(str(Path(__file__).with_name("wake_receipt.py")))["inspect_receipt"]
        with tempfile.TemporaryDirectory() as home:
            db = fixture(home)
            reply = {"id": "reply", "thread": "thread", "reply_to": "test-message-id", "from": "oc-agent@e2e", "to": ["tester@e2e"], "kind": "reply", "body": "PONG-exact"}
            db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)", ("reply", "thread", "oc-agent@e2e", "test-message-id", "reply", "PONG-exact", json.dumps(reply), "local", "local"))
            db.execute("INSERT INTO deliveries VALUES (?,?,?)", ("unrelated", "oc-agent", "acked"))
            db.commit()
            check = lambda: inspect(home, "test-message-id", "oc-agent", "PONG-exact")
            self.assertFalse(check()["receipt_verified"])
            db.execute("UPDATE deliveries SET state='acked' WHERE msg_id='test-message-id'")
            db.commit()
            self.assertTrue(check()["receipt_verified"])
            for column, bad in [("thread", "other"), ("reply_to", "other"), ("from_addr", "oc-agent@other"), ("body", "prefix PONG-exact"), ("kind", "message"), ("trust", "legacy"), ("origin", "remote")]:
                original = db.execute(f"SELECT {column} FROM messages WHERE id='reply'").fetchone()[0]
                db.execute(f"UPDATE messages SET {column}=? WHERE id='reply'", (bad,)); db.commit()
                self.assertFalse(check()["receipt_verified"], column)
                db.execute(f"UPDATE messages SET {column}=? WHERE id='reply'", (original,)); db.commit()
            reply["to"] = ["somebody@e2e"]
            db.execute("UPDATE messages SET envelope=? WHERE id='reply'", (json.dumps(reply),)); db.commit()
            self.assertFalse(check()["receipt_verified"])
            self.assertEqual(db.execute("SELECT state FROM deliveries WHERE msg_id='test-message-id'").fetchone()[0], "acked")
            db.close()


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
                    if "init" in args:
                        fixture(kwargs["env"]["MBX_HOME"]).close()
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
                self.assertEqual(len(resumed_commands), 1)  # service status only; mailbox observation uses read-only SQLite
                after = json.loads(reports[0].read_text())
                for key in ("session_id", "message_id", "token", "mbx_home", "work"):
                    self.assertEqual(after[key], report[key])



if __name__ == "__main__":
    unittest.main()
