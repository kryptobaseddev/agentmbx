#!/usr/bin/env python3
"""Real end-to-end: an IDLE interactive Codex TUI is woken by mbx (codex queue), reads the message through the
mbx MCP tools, and replies through mbx. Uses a throwaway MBX_HOME and working dir; touches no user config."""
import fcntl, json, os, pty, re, select, struct, subprocess, sys, tempfile, termios, threading, time, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MBX = os.path.join(ROOT, "bin", "agentmbx.js")
home = tempfile.mkdtemp(prefix="mbx-e2e-home-"); work = os.path.realpath(tempfile.mkdtemp(prefix="cx-agent-"))
env = dict(os.environ, MBX_HOME=home, MBX_NO_DESKTOP="1")
agent = "cx-agent"; token = "PONG-" + uuid.uuid4().hex[:6]
mcp = ["-c", 'mcp_servers.mbx.command="node"', "-c", 'mcp_servers.mbx.args=["%s","mcp"]' % MBX,
       "-c", 'mcp_servers.mbx.env={MBX_HOME="%s",MBX_AGENT="%s",MBX_CLI="codex",MBX_NO_DESKTOP="1"}' % (home, agent),
       "-c", 'projects={"%s"={trust_level="trusted"}}' % work, "-c", 'approval_policy="never"', "-c", 'mcp_servers.mbx.default_tools_approval_mode="approve"', "-s", "read-only", "--disable", "hooks"]

def mbx(*args, stdin=None):
    return subprocess.run(["node", MBX, *args], env=env, input=stdin, capture_output=True, text=True, cwd=work)

print("home", home, "work", work)
mbx("init", "--host", "e2e", "--port", "17999")
# 1. create a Codex thread headlessly (it also connects the mbx MCP server once)
out = subprocess.run(["codex", "exec", "--skip-git-repo-check", "--json", *mcp, "Reply with exactly: READY"],
                     cwd=work, capture_output=True, text=True, timeout=180, stdin=subprocess.DEVNULL)
tid = next((json.loads(l).get("thread_id") for l in out.stdout.splitlines() if '"thread_id"' in l), None)
assert tid, out.stdout[-2000:] + out.stderr[-2000:]
print("thread", tid)
# 2. bind the thread to the agent the way the Codex SessionStart hook would
env_agent = dict(env, MBX_AGENT=agent)
subprocess.run(["node", MBX, "hook", "session-start", "--cli", "codex"], env=env_agent, input=json.dumps({"session_id": tid, "cwd": work}), text=True, cwd=work)
# 3. open the real interactive TUI on that thread and leave it idle
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work); os.execvpe("codex", ["codex", "resume", tid, "--no-alt-screen", "-c", "check_for_update_on_startup=false", *mcp], dict(os.environ, TERM="xterm-256color"))
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
buf = bytearray()
def pump():
    while True:
        try:
            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                d = os.read(fd, 65536); buf.extend(d)
                if b"\x1b[6n" in d: os.write(fd, b"\x1b[1;1R")   # answer cursor-position queries like a terminal
        except OSError: return
threading.Thread(target=pump, daemon=True).start()
time.sleep(20)
print("TUI idle; sending mbx request")
# 4. another agent sends a request; one dispatcher pass wakes the idle Codex through `codex queue`
sent = mbx("send", "--as", "tester", "--to", agent, "--kind", "request", "--needs-reply", "--subject", "ping from tester",
           "-m", f"Please answer this with the mbx_send tool: to [\"tester\"], kind reply, reply_to this message's id, body exactly {token}. Then call mbx_ack on it.")
mid = sent.stdout.strip(); print("sent", mid, sent.stderr.strip())
wake = subprocess.run(["node", "--input-type=module", "-e",
  f"const {{MbxNode}}=await import('{ROOT}/src/node.ts');const {{dispatchWakes}}=await import('{ROOT}/src/wake.ts');"
  "const n=new MbxNode();console.log(JSON.stringify(await dispatchWakes(n)));"], env=env, capture_output=True, text=True)
print("dispatch:", wake.stdout.strip(), wake.stderr.strip()[-300:])
t0 = time.time(); ok = False
while time.time() - t0 < 150:
    inbox = mbx("inbox", "--as", "tester", "--json").stdout
    if token in mbx("search", token).stdout or token in inbox:
        ok = True; break
    time.sleep(3); print(f"  waiting {time.time()-t0:.0f}s", flush=True)
print("reply received" if ok else "NO REPLY", f"after {time.time()-t0:.0f}s")
print(mbx("thread", mid).stdout[-1500:])
print("ack state:", mbx("inbox", "--as", agent, "--all", "--json").stdout)
os.kill(pid, 9)
screen = re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", bytes(buf)).decode("utf8", "ignore")
print("--- TUI tail ---\n", screen[-1200:])
sys.exit(0 if ok else 1)
