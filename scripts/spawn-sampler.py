#!/usr/bin/env python3
"""Spawn sampler (macOS, unprivileged, read-only). Written for T341 (process-spawn budget).

Polls libproc's pid list in-process (no ps spawns of its own) and records every process that appears during the window
whose argv names agentmbx, that runs the claude-posttool.sh wrapper, or whose parent is a resident agentmbx mcp/watch/daemon.
Each event carries the ancestor chain (harness attribution) and is re-read once after exec. It never signals, kills or
attaches to anything. Children that live < poll interval can be missed; state the poll rate in any report.
Usage: python3 spawn-sampler.py <seconds> [poll_ms] > report.json
Classify installed vs dev-checkout starts by argv path (node_modules/agentmbx vs a worktree's bin/agentmbx.js):
other agents' test suites otherwise dominate the counts.
"""
import ctypes, ctypes.util, json, sys, time, re

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)

class BSDInfo(ctypes.Structure):
    _fields_ = [("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32), ("pbi_xstatus", ctypes.c_uint32),
                ("pbi_pid", ctypes.c_uint32), ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
                ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32), ("pbi_rgid", ctypes.c_uint32),
                ("pbi_svuid", ctypes.c_uint32), ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
                ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32), ("pbi_nfiles", ctypes.c_uint32),
                ("pbi_pgid", ctypes.c_uint32), ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
                ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32), ("pbi_start_tvsec", ctypes.c_uint64),
                ("pbi_start_tvusec", ctypes.c_uint64)]

PROC_PIDTBSDINFO = 3
BUF = (ctypes.c_int * 16384)()

def pids():
    n = libproc.proc_listallpids(BUF, ctypes.sizeof(BUF))
    return set(BUF[:max(n, 0)])

def info(pid):
    b = BSDInfo()
    if libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(b), ctypes.sizeof(b)) != ctypes.sizeof(b):
        return None
    return {"ppid": b.pbi_ppid, "comm": b.pbi_comm.decode(errors="replace")}

def argv(pid):
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    size = ctypes.c_size_t(65536); buf = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        return None
    raw = buf.raw[: size.value]
    argc = int.from_bytes(raw[:4], "little")
    parts = [p for p in raw[4:].split(b"\0") if p]
    return [p.decode(errors="replace") for p in parts[1 : 1 + argc]]

AGENTMBX = re.compile(r"agentmbx(?:\.js)?$")
def mbx_command(args):
    if not args: return None
    for i, a in enumerate(args):
        if AGENTMBX.search(a) and i + 1 < len(args):
            return " ".join(args[i + 1 : i + 4])
    return None

def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60
    poll = (float(sys.argv[2]) if len(sys.argv) > 2 else 5) / 1000
    known = pids(); resident = {}
    for p in known:
        c = mbx_command(argv(p))
        if c: resident[p] = c
    events, polls, t0 = [], 0, time.time()
    while time.time() - t0 < seconds:
        now = pids(); polls += 1
        for p in now - known:
            i = info(p); a = argv(p)
            if not i: continue
            cmd = mbx_command(a); parent = resident.get(i["ppid"])
            if cmd or parent or (a and any("posttool" in x for x in a)):
                chain, q = [], i["ppid"]
                for _ in range(8):
                    j = info(q) if q > 1 else None
                    if not j: break
                    pa = argv(q) or []
                    chain.append(next((x for x in pa[:3] if re.search(r"(claude|codex|grok|opencode|kimi|hermes|tui_gateway|orca)", x, re.I)), j["comm"])[-40:])
                    q = j["ppid"]
                events.append({"chain": chain, "t": round(time.time() - t0, 3), "pid": p, "ppid": i["ppid"], "comm": i["comm"],
                               "agentmbx": cmd, "parent_agentmbx": parent, "argv": (a or [])[:6]})
            if cmd and cmd.split()[0] in ("mcp", "watch", "daemon"): resident[p] = cmd
        for e in events:  # a child seen between fork and exec still shows its parent's comm/argv
            if e.get("final"): continue
            if e["pid"] not in now: e["final"] = "gone"; continue
            a2 = argv(e["pid"]); i2 = info(e["pid"])
            if i2 and a2 and (a2 != e["argv"] or i2["comm"] != e["comm"]):
                e["argv"] = a2[:6]; e["comm"] = i2["comm"]; e["final"] = "exec-seen"
            elif time.time() - t0 - e["t"] > 0.5: e["final"] = "stable"
        known = now
        time.sleep(poll)
    print(json.dumps({"seconds": round(time.time() - t0, 1), "polls": polls, "poll_ms": poll * 1000,
                      "resident_count": len(resident), "events": events}, indent=1))

if __name__ == "__main__":
    main()
