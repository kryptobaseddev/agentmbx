#!/usr/bin/env python3
"""Real end-to-end: an idle OpenCode session (on the running `opencode service`) is woken by mbx (POST /synthetic),
reads the message through the mbx MCP tools (configured per-project in a scratch dir), and replies through mbx."""
import argparse, base64, runpy, json, os, subprocess, sys, tempfile, time, urllib.request, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MBX = os.path.join(ROOT, "bin", "agentmbx.js")
receipt_tools = runpy.run_path(os.path.join(ROOT, "scripts/e2e/wake_receipt.py"))
inspect_receipt = receipt_tools["inspect_receipt"]
find_request = receipt_tools["find_request"]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--resume", metavar="RESULT", help="Observe the retained session and original message; never approve prompts or resend")
options = parser.parse_args()
state = None
if options.resume:
    with open(options.resume) as f: state = json.load(f)
    required = ("mbx_home", "work", "agent", "token")
    if state.get("version") != 1 or any(not isinstance(state.get(k), str) or not state[k] for k in required):
        parser.error("Result lacks resumable state; do not create a replacement session to bypass its prompt")
    home, work, agent, token = (state[k] for k in ("mbx_home", "work", "agent", "token"))
    if not os.path.isdir(home) or not os.path.isdir(work):
        parser.error("Retained mailbox home or work directory is missing")
else:
    home = tempfile.mkdtemp(prefix="mbx-e2e-home-")
    work = os.path.realpath(tempfile.mkdtemp(prefix="oc-agent-"))
    agent = "oc-agent"; token = "PONG-" + uuid.uuid4().hex[:6]
env = dict(os.environ, MBX_HOME=home, MBX_NO_DESKTOP="1")
MODEL = {"providerID": "opencode", "id": os.environ.get("OC_MODEL", "mimo-v2.6-flash-free")}
sid = state.get("session_id") if state else None
mid = state.get("message_id") if state else None
phase = state.get("phase", "observe") if state else "setup"
history = list(state.get("history", [])) if state else []
request_body = (state.get("request_body") if state else None) or f"Please answer this with the mbx_send tool: to [\"tester\"], kind reply, reply_to this message's id, body exactly {token}. Then call mbx_ack on it."

def api(method, path, body=None):
    req = urllib.request.Request(url + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": auth, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read() or b"null")
def mbx(*a, stdin=None, e=env): return subprocess.run(["node", MBX, *a], env=e, input=stdin, capture_output=True, text=True, cwd=work, check=True, timeout=30)

def persist(outcome, permissions=None, **details):
    history.append({"at": time.time(), "phase": phase, "outcome": outcome,
                    "session_id": sid, "message_id": mid, **details})
    result = {"version": 1, "agent": agent, "token": token, "outcome": outcome, "phase": phase,
              "session_id": sid, "mbx_home": home, "work": work, "message_id": mid,
              "request_body": request_body, "permissions": permissions or [], "history": history, **details}
    result_path = os.path.join(work, "wake-result.json")
    # Replace atomically so interruption cannot destroy the last usable recovery record.
    pending = result_path + ".tmp"
    with open(pending, "w") as f:
        json.dump(result, f, indent=2)
        f.flush(); os.fsync(f.fileno())
    os.replace(pending, result_path)
    return result, result_path


def report(outcome, code, **details):
    result, result_path = persist(outcome, **details)
    print(json.dumps(result), flush=True)
    print("Session retained; recovery result:", result_path, flush=True)
    return code


def run():
    global sid, mid, phase, url, auth
    print("home", home, "work", work)
    if state is None:
        persist("initializing")
        with open(os.path.join(work, "opencode.json"), "w") as f:
            json.dump({"$schema": "https://opencode.ai/config.json", "mcp": {"servers": {"mbx": {"type": "local", "command": ["node", MBX, "mcp"],
                "environment": {"MBX_HOME": home, "MBX_AGENT": agent, "MBX_CLI": "opencode", "MBX_NO_DESKTOP": "1"}}}}}, f)
        mbx("init", "--host", "e2e", "--port", "17998")
    elif not isinstance(sid, str) or not sid:
        return report("blocked_missing_session_id", 3)

    url = subprocess.run(["opencode", "service", "status"], capture_output=True, text=True, check=True, timeout=15).stdout.split()[0].rstrip("/")
    with open(os.path.expanduser("~/.config/opencode/service.json")) as f: pw = json.load(f)["password"]
    auth = "Basic " + base64.b64encode(f"opencode:{pw}".encode()).decode()
    if state is None:
        phase = "creating_session"; persist("initializing")
        ses = api("POST", "/api/session", {"title": "mbx e2e", "model": MODEL, "location": {"directory": work}})
        sid = (ses.get("data") or ses)["id"]
        if not isinstance(sid, str) or not sid: raise ValueError("Provider returned no session ID")
        phase = "binding"; persist("initializing")
        mbx("hook", "session-start", "--cli", "opencode", stdin=json.dumps({"session_id": sid, "cwd": work}), e=dict(env, MBX_AGENT=agent))
        phase = "sending"; persist("initializing")
        sent = mbx("send", "--as", "tester", "--to", agent, "--kind", "request", "--needs-reply", "--subject", "ping from tester", "-m", request_body)
        mid = sent.stdout.strip()
        if not mid: raise RuntimeError("Send returned no message ID; no wake dispatched")
        phase = "dispatching"; persist("awaiting_reply")
        # JSON quoting keeps repository paths containing apostrophes safe inside JavaScript.
        code = f"const {{MbxNode}}=await import({json.dumps(ROOT + '/src/node.ts')});const {{dispatchWakes}}=await import({json.dumps(ROOT + '/src/wake.ts')});const node=new MbxNode();try{{console.log(JSON.stringify(await dispatchWakes(node)));}}finally{{node.close();}}"
        dispatched = subprocess.run(["node", "--input-type=module", "-e", code], env=env, capture_output=True, text=True, check=True, timeout=30)
        results = json.loads(dispatched.stdout)
        if not isinstance(results, list) or not any(isinstance(row, dict) and row.get("agent") == agent and isinstance(row.get("result"), dict) and row["result"].get("ok") is True for row in results):
            raise RuntimeError("Wake dispatcher did not confirm submission to the target agent: " + json.dumps(results)[:1000])
    elif not mid:
        # A send can commit before its process exits unsuccessfully. Recover only one exact
        # original request; never resend, redispatch, create a session, or answer a prompt.
        mid = find_request(home, agent, request_body)
        if not mid: return report("blocked_missing_message_id", 3)
    phase = "observe"; persist("awaiting_reply")
    t0 = time.monotonic()
    while time.monotonic() - t0 < 180:
        evidence = inspect_receipt(home, mid, agent, token)
        if evidence["receipt_verified"]:
            return report("receipt_verified", 0, evidence=evidence)
        reqs = api("GET", f"/api/session/{sid}/permission")
        reqs = reqs.get("data", reqs) if isinstance(reqs, dict) else reqs
        if not isinstance(reqs, list) or any(not isinstance(r, dict) for r in reqs):
            raise ValueError("Provider permission response is not a request list")
        if reqs:
            return report("awaiting_owner_approval", 3, permissions=[{"id": r.get("id"), "action": r.get("action")} for r in reqs], evidence=evidence)
        time.sleep(3)
        print(f"  waiting {time.monotonic()-t0:.0f}s", flush=True)
    return report("timed_out", 1, evidence=evidence)


try:
    result_code = run()
except Exception as error:
    result_code = report("harness_error", 1, error={"type": type(error).__name__, "message": str(error)[:1500]})
sys.exit(result_code)
