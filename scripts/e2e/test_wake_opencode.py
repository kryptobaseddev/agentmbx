"""Run the native harness with mocked provider/process boundaries; never starts an agent."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import re
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
    def test_uncertain_send_recovery_rejects_ambiguous_requests(self):
        find = runpy.run_path(str(Path(__file__).with_name("wake_receipt.py")))["find_request"]
        with tempfile.TemporaryDirectory() as home:
            db = fixture(home)
            self.assertIsNone(find(home, "oc-agent", "wrong body"))
            self.assertIsNone(find(home, "other-agent", "request body"))
            self.assertEqual(find(home, "oc-agent", "request body"), "test-message-id")
            db.execute("INSERT INTO messages SELECT 'duplicate', thread, from_addr, reply_to, kind, body, envelope, origin, trust FROM messages")
            db.commit()
            with self.assertRaisesRegex(ValueError, "Multiple matching"):
                find(home, "oc-agent", "request body")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT state FROM deliveries").fetchone()[0], "delivered")
            db.close()

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
                    if "--input-type=module" in args:
                        output = '[{"agent":"oc-agent","result":{"ok":true,"via":"opencode synthetic"}}]'
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


class RecoveryTest(unittest.TestCase):
    def exercise(self, failure=None):
        with tempfile.TemporaryDirectory() as root:
            commands, requests = [], []
            original_open, original_mkdtemp = open, tempfile.mkdtemp
            mailbox = None

            def local_open(path, *args, **kwargs):
                if str(path).endswith("/.config/opencode/service.json"):
                    return io.StringIO('{"password":"test-only"}')
                return original_open(path, *args, **kwargs)

            def command(args, **kwargs):
                nonlocal mailbox
                commands.append(args)
                self.assertTrue(kwargs.get("check"))
                self.assertGreater(kwargs.get("timeout", 0), 0)
                output = "http://provider.invalid" if args[:3] == ["opencode", "service", "status"] else ""
                if "init" in args:
                    mailbox = kwargs["env"]["MBX_HOME"]
                    db = fixture(mailbox)
                    db.execute("DELETE FROM messages"); db.execute("DELETE FROM deliveries"); db.commit(); db.close()
                if "hook" in args and failure == "hook":
                    raise subprocess.CalledProcessError(1, args)
                if "send" in args:
                    if failure == "send_before": raise subprocess.CalledProcessError(1, args)
                    body = args[args.index("-m") + 1]
                    db = sqlite3.connect(str(Path(mailbox) / "mbx.db"))
                    db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)", ("test-message-id", "thread", "tester@e2e", None, "request", body, json.dumps({"to": ["oc-agent@e2e"]}), "local", "local"))
                    db.execute("INSERT INTO deliveries VALUES (?,?,?)", ("test-message-id", "oc-agent", "delivered"))
                    db.commit(); db.close()
                    if failure == "send_after": raise subprocess.CalledProcessError(1, args)
                    output = "test-message-id"
                if "--input-type=module" in args:
                    if failure == "dispatch": raise subprocess.CalledProcessError(1, args)
                    if failure == "dispatch_timeout": raise subprocess.TimeoutExpired(args, kwargs["timeout"])
                    output = json.dumps([{"agent": "oc-agent", "result": {"ok": failure != "dispatch_refused", "via": "test"}}])
                    if failure is None:
                        db = sqlite3.connect(str(Path(mailbox) / "mbx.db"))
                        body = db.execute("SELECT body FROM messages WHERE id='test-message-id'").fetchone()[0]
                        token = re.search(r"body exactly (PONG-\w+)", body)[1]
                        reply = {"id": "reply", "thread": "thread", "reply_to": "test-message-id", "from": "oc-agent@e2e", "to": ["tester"], "kind": "reply", "body": token}
                        db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)", ("reply", "thread", "oc-agent@e2e", "test-message-id", "reply", token, json.dumps(reply), "local", "local"))
                        db.execute("UPDATE deliveries SET state='acked'"); db.commit(); db.close()
                if "thread" in args: raise AssertionError("Receipt observation must not impersonate the leased session")
                return subprocess.CompletedProcess(args, 0, output, "")

            def request(req, **kwargs):
                requests.append((req.method, req.full_url))
                if req.method == "POST" and req.full_url.endswith("/api/session"):
                    if failure == "create": raise OSError("Provider response lost")
                    return io.BytesIO(b'{"data":{"id":"ses_test"}}')
                if req.method == "GET" and req.full_url.endswith("/permission"):
                    return io.BytesIO(b'{"data":[{"id":"per_test","action":"mbx_read"}]}')
                if req.method == "GET" and req.full_url.endswith("/message"):
                    return io.BytesIO(b'{"data":[]}')
                raise AssertionError(f"Unexpected provider action: {req.method} {req.full_url}")

            def invoke(argv):
                with patch("builtins.open", local_open), patch("tempfile.mkdtemp", lambda **kw: original_mkdtemp(dir=root, **kw)), \
                     patch("sys.argv", argv), patch("subprocess.run", command), patch("urllib.request.urlopen", request), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as result:
                        runpy.run_path(str(Path(__file__).with_name("wake-opencode.py")), run_name="__main__")
                return result.exception.code

            self.assertEqual(invoke(["wake-opencode.py"]), 0 if failure is None else 1)
            reports = list(Path(root).glob("*/wake-result.json"))
            self.assertEqual(len(reports), 1, "Session evidence must survive every post-create failure")
            report = json.loads(reports[0].read_text())
            self.assertEqual(report["session_id"], None if failure == "create" else "ses_test")
            if failure is None:
                self.assertTrue(report["evidence"]["receipt_verified"])
            else:
                self.assertEqual(report["outcome"], "harness_error")
                commands.clear(); requests.clear()
                self.assertEqual(invoke(["wake-opencode.py", "--resume", str(reports[0])]), 3)
                self.assertFalse(any("send" in c or "hook" in c or "--input-type=module" in c for c in commands))
                self.assertTrue(all(method == "GET" for method, _ in requests))
                after = json.loads(reports[0].read_text())
                self.assertEqual(after["session_id"], report["session_id"])
                self.assertTrue(any(event["outcome"] == "harness_error" for event in after["history"]))
                if failure == "send_after": self.assertEqual(after["message_id"], "test-message-id")

    def test_verified_receipt_does_not_require_cli_identity(self):
        self.exercise()

    def test_setup_and_dispatch_failures_preserve_recovery(self):
        for failure in ["create", "hook", "send_before", "send_after", "dispatch", "dispatch_timeout", "dispatch_refused"]:
            with self.subTest(failure=failure): self.exercise(failure)


if __name__ == "__main__":
    unittest.main()
