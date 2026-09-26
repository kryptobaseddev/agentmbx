#!/usr/bin/env python3
"""Real end-to-end: an IDLE interactive Claude Code session started with the mbx channel
(--dangerously-load-development-channels server:mbx) is woken by a channel event pushed by its own mbx MCP server,
reads the message with the mbx tools, and replies through mbx. Throwaway MBX_HOME + dir; --strict-mcp-config."""
import fcntl, json, os, pty, re, select, struct, subprocess, sys, tempfile, termios, threading, time, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MBX = os.path.join(ROOT, "bin", "mbx.js")
home = tempfile.mkdtemp(prefix="mbx-e2e-home-"); work = os.path.realpath(tempfile.mkdtemp(prefix="cl-agent-"))
env = dict(os.environ, MBX_HOME=home, MBX_NO_DESKTOP="1"); agent = "cl-agent"; token = "PONG-" + uuid.uuid4().hex[:6]
cfg = os.path.join(work, ".mcp-test.json")
json.dump({"mcpServers": {"mbx": {"command": "node", "args": [MBX, "mcp"], "env": {"MBX_HOME": home, "MBX_AGENT": agent, "MBX_NO_DESKTOP": "1"}}}}, open(cfg, "w"))
def mbx(*a): return subprocess.run(["node", MBX, *a], env=env, capture_output=True, text=True, cwd=work)
print("home", home, "work", work, flush=True)
mbx("init", "--host", "e2e", "--port", "17997")
args = ["claude", "--mcp-config", cfg, "--strict-mcp-config", "--dangerously-load-development-channels", "server:mbx",
        "--allowedTools", "mcp__mbx__mbx_inbox,mcp__mbx__mbx_read,mcp__mbx__mbx_send,mcp__mbx__mbx_ack,mcp__mbx__mbx_whoami"]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work); os.execvpe("claude", args, dict(os.environ, TERM="xterm-256color"))
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
buf = bytearray()
def clean(b): return re.sub(r"\x1b\[[0-9;?>]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\\\)", "", b.decode("utf8", "ignore"))
def pump():
    while True:
        try:
            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                d = os.read(fd, 65536); buf.extend(d)
                if b"\x1b[6n" in d: os.write(fd, b"\x1b[1;1R")
        except OSError: return
threading.Thread(target=pump, daemon=True).start()
# get past startup confirmations (folder trust, development-channel warning) by accepting the default option
answered = 0; t = time.time()
while time.time() - t < 60:
    time.sleep(2); screen = clean(bytes(buf[-6000:]))
    if re.search(r"(trust this folder|Do you trust|development channel|Loading development|I am using this for local development|Enter to confirm)", screen, re.I) and answered < 4:
        os.write(fd, b"\r"); answered += 1; buf.extend(b"\n<<answered>>\n"); time.sleep(3)
    elif answered and time.time() - t > 25: break
s = mbx("status").stdout; print("after startup:", s.replace("\n", " | "), flush=True)
print("agents:", mbx("agents").stdout.strip(), flush=True)
time.sleep(15)
print("session idle; sending", flush=True)
sent = mbx("send", "--as", "tester", "--to", agent, "--kind", "request", "--needs-reply", "--subject", "ping from tester",
           "-m", f"Please answer this with the mbx_send tool: to [\"tester\"], kind reply, reply_to this message's id, body exactly {token}. Then call mbx_ack on it.")
mid = sent.stdout.strip(); print("sent", mid, sent.stderr.strip(), flush=True)
t0 = time.time(); ok = False
while time.time() - t0 < 180:
    if token in mbx("search", token).stdout: ok = True; break
    time.sleep(3)
print("REPLY RECEIVED" if ok else "NO REPLY", f"after {time.time()-t0:.0f}s", flush=True)
print(mbx("thread", mid).stdout[-1500:])
print("acked:", '"acked"' in mbx("inbox", "--as", agent, "--all", "--json").stdout)
os.kill(pid, 9)
print("--- screen tail ---\n", clean(bytes(buf))[-2500:])
sys.exit(0 if ok else 1)
