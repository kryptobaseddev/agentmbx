#!/usr/bin/env python3
"""Real end-to-end: an idle OpenCode session (on the running `opencode service`) is woken by mbx (POST /synthetic),
reads the message through the mbx MCP tools (configured per-project in a scratch dir), and replies through mbx."""
import base64, json, os, subprocess, sys, tempfile, time, urllib.request, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MBX = os.path.join(ROOT, "bin", "agentmbx.js")
home = tempfile.mkdtemp(prefix="mbx-e2e-home-"); work = os.path.realpath(tempfile.mkdtemp(prefix="oc-agent-"))
env = dict(os.environ, MBX_HOME=home, MBX_NO_DESKTOP="1"); agent = "oc-agent"; token = "PONG-" + uuid.uuid4().hex[:6]
MODEL = {"providerID": "opencode", "id": os.environ.get("OC_MODEL", "mimo-v2.6-flash-free")}
json.dump({"$schema": "https://opencode.ai/config.json", "mcp": {"servers": {"mbx": {"type": "local", "command": ["node", MBX, "mcp"],
  "environment": {"MBX_HOME": home, "MBX_AGENT": agent, "MBX_CLI": "opencode", "MBX_NO_DESKTOP": "1"}}}}}, open(os.path.join(work, "opencode.json"), "w"))
url = subprocess.run(["opencode", "service", "status"], capture_output=True, text=True).stdout.split()[0].rstrip("/")
pw = json.load(open(os.path.expanduser("~/.config/opencode/service.json")))["password"]
auth = "Basic " + base64.b64encode(f"opencode:{pw}".encode()).decode()
def api(method, path, body=None):
    req = urllib.request.Request(url + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": auth, "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read() or b"null")
def mbx(*a, stdin=None, e=env): return subprocess.run(["node", MBX, *a], env=e, input=stdin, capture_output=True, text=True, cwd=work)

print("home", home, "work", work)
mbx("init", "--host", "e2e", "--port", "17998")
ses = api("POST", "/api/session", {"title": "mbx e2e", "model": MODEL, "location": {"directory": work}})
sid = (ses.get("data") or ses)["id"]; print("session", sid)
mbx("hook", "session-start", "--cli", "opencode", stdin=json.dumps({"session_id": sid, "cwd": work}), e=dict(env, MBX_AGENT=agent))
sent = mbx("send", "--as", "tester", "--to", agent, "--kind", "request", "--needs-reply", "--subject", "ping from tester",
           "-m", f"Please answer this with the mbx_send tool: to [\"tester\"], kind reply, reply_to this message's id, body exactly {token}. Then call mbx_ack on it.")
mid = sent.stdout.strip(); print("sent", mid)
d = subprocess.run(["node", "--input-type=module", "-e", f"const {{MbxNode}}=await import('{ROOT}/src/node.ts');const {{dispatchWakes}}=await import('{ROOT}/src/wake.ts');console.log(JSON.stringify(await dispatchWakes(new MbxNode())));"], env=env, capture_output=True, text=True)
print("dispatch:", d.stdout.strip(), d.stderr.strip()[-300:])
def replied():   # a reply from the agent, in the request's thread, carrying the token
    th = mbx("thread", mid).stdout
    return any(f"from: {agent}@" in part and token in part for part in th.split("\n# ")[1:])
t0 = time.time(); ok = False
seen = set()
while time.time() - t0 < 180:
    if replied(): ok = True; break
    try:   # a user would be asked here; approve only requests that are about the mbx tools, and log every one
        reqs = api("GET", f"/api/session/{sid}/permission"); reqs = reqs.get("data", reqs) if isinstance(reqs, dict) else reqs
        for r in reqs or []:
            if r["id"] in seen: continue
            seen.add(r["id"]); blob = json.dumps(r)
            print("permission request:", r.get("action"), r.get("resources"), blob[:300], flush=True)
            if "mbx" in blob: api("POST", f"/api/session/{sid}/permission/{r['id']}/reply", {"reply": "once"}); print("  -> approved once (mbx)", flush=True)
    except Exception as ex: print("perm poll error", ex, flush=True)
    time.sleep(3); print(f"  waiting {time.time()-t0:.0f}s", flush=True)
print("REPLY RECEIVED" if ok else "NO REPLY", f"after {time.time()-t0:.0f}s")
print(mbx("thread", mid).stdout[-1200:])
print("acked:", '"acked"' in mbx("inbox", "--as", agent, "--all", "--json").stdout)
try:
    msgs = api("GET", f"/api/session/{sid}/message")
    print("session transcript (tail):", json.dumps(msgs)[-1500:])
except Exception as ex: print("transcript error", ex)
try: api("DELETE", f"/api/session/{sid}")
except Exception: pass
sys.exit(0 if ok else 1)
