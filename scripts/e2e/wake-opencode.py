#!/usr/bin/env python3
"""Real end-to-end: an idle OpenCode session (on the running `opencode service`) is woken by mbx (POST /synthetic),
reads the message through the mbx MCP tools (configured per-project in a scratch dir), and replies through mbx."""
import argparse, base64, runpy, json, os, subprocess, sys, tempfile, time, urllib.request, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MBX = os.path.join(ROOT, "bin", "agentmbx.js")
inspect_receipt = runpy.run_path(os.path.join(ROOT, "scripts/e2e/wake_receipt.py"))["inspect_receipt"]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--resume", metavar="RESULT", help="Observe the retained session and original message; never approve prompts or resend")
options = parser.parse_args()
state = None
if options.resume:
    with open(options.resume) as f: state = json.load(f)
    required = ("session_id", "mbx_home", "work", "message_id", "agent", "token")
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
if state is None:
    with open(os.path.join(work, "opencode.json"), "w") as f:
        json.dump({"$schema": "https://opencode.ai/config.json", "mcp": {"servers": {"mbx": {"type": "local", "command": ["node", MBX, "mcp"],
            "environment": {"MBX_HOME": home, "MBX_AGENT": agent, "MBX_CLI": "opencode", "MBX_NO_DESKTOP": "1"}}}}}, f)
url = subprocess.run(["opencode", "service", "status"], capture_output=True, text=True, check=True).stdout.split()[0].rstrip("/")
pw = json.load(open(os.path.expanduser("~/.config/opencode/service.json")))["password"]
auth = "Basic " + base64.b64encode(f"opencode:{pw}".encode()).decode()
def api(method, path, body=None):
    req = urllib.request.Request(url + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": auth, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read() or b"null")
def mbx(*a, stdin=None, e=env): return subprocess.run(["node", MBX, *a], env=e, input=stdin, capture_output=True, text=True, cwd=work, check=True)

def persist(outcome, permissions=None):
    result = {"version": 1, "agent": agent, "token": token, "outcome": outcome,
              "session_id": sid, "mbx_home": home, "work": work, "message_id": mid,
              "permissions": permissions or []}
    result_path = os.path.join(work, "wake-result.json")
    with open(result_path, "w") as f: json.dump(result, f, indent=2)
    return result, result_path

print("home", home, "work", work)
if state is not None:
    sid, mid = state["session_id"], state["message_id"]
    print("Resuming retained session", sid, "message", mid, flush=True)
else:
    mbx("init", "--host", "e2e", "--port", "17998")
    ses = api("POST", "/api/session", {"title": "mbx e2e", "model": MODEL, "location": {"directory": work}})
    sid = (ses.get("data") or ses)["id"]; print("session", sid)
    mbx("hook", "session-start", "--cli", "opencode", stdin=json.dumps({"session_id": sid, "cwd": work}), e=dict(env, MBX_AGENT=agent))
    sent = mbx("send", "--as", "tester", "--to", agent, "--kind", "request", "--needs-reply", "--subject", "ping from tester",
               "-m", f"Please answer this with the mbx_send tool: to [\"tester\"], kind reply, reply_to this message's id, body exactly {token}. Then call mbx_ack on it.")
    mid = sent.stdout.strip(); print("sent", mid)
    if not mid: raise RuntimeError("Send returned no message ID; no wake dispatched")
    persist("awaiting_reply")
    d = subprocess.run(["node", "--input-type=module", "-e", f"const {{MbxNode}}=await import('{ROOT}/src/node.ts');const {{dispatchWakes}}=await import('{ROOT}/src/wake.ts');console.log(JSON.stringify(await dispatchWakes(new MbxNode())));"], env=env, capture_output=True, text=True, check=True)
    print("dispatch:", d.stdout.strip(), d.stderr.strip()[-300:])
t0 = time.time(); ok = False
seen = set()
while time.time() - t0 < 180:
    evidence = inspect_receipt(home, mid, agent, token)
    if evidence["receipt_verified"]: ok = True; break
    try:   # Observe permission requests; only the owner may answer them in the provider UI.
        reqs = api("GET", f"/api/session/{sid}/permission"); reqs = reqs.get("data", reqs) if isinstance(reqs, dict) else reqs
        if reqs:
            result, result_path = persist("awaiting_owner_approval", [{"id": r.get("id"), "action": r.get("action")} for r in reqs])
            print(json.dumps(result), flush=True)
            print("Session retained for inspection and explicit owner action in OpenCode; result:", result_path, flush=True)
            sys.exit(3)
    except Exception as ex: print("perm poll error", ex, flush=True)
    time.sleep(3); print(f"  waiting {time.time()-t0:.0f}s", flush=True)
result, result_path = persist("receipt_verified" if ok else "timed_out")
result["evidence"] = evidence
with open(result_path, "w") as f: json.dump(result, f, indent=2)
print("REPLY RECEIVED" if ok else "NO REPLY", f"after {time.time()-t0:.0f}s")
print(mbx("thread", mid).stdout[-1200:])
print("receipt:", json.dumps(evidence))
try:
    msgs = api("GET", f"/api/session/{sid}/message")
    print("session transcript (tail):", json.dumps(msgs)[-1500:])
except Exception as ex: print("transcript error", ex)
print("Session retained for inspection:", sid, "work:", work, flush=True)
sys.exit(0 if ok else 1)
