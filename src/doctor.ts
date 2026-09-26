// `agentmbx doctor`: one checklist that says what works, what doesn't, and the one command that fixes it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint } from "./crypto.ts";
import { signHop } from "./http.ts";
import { MbxNode } from "./node.ts";
import { ownerPath } from "./owner.ts";
import { detect, edits, skillStatus, wired, type SetupCtx } from "./setup.ts";

export type Level = "ok" | "fail" | "warn" | "info";
export interface Check { level: Level; label: string; fix?: string }

export const VERSION = (() => {
  try { return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version; } catch { return "unknown"; }
})();

/** True when something answers HTTP on the daemon port (an unsigned request gets 401, which still proves it is up). */
export async function daemonAnswers(port: number, timeoutMs = 1500): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/v1/agents`, { signal: AbortSignal.timeout(timeoutMs) }); return true; } catch { return false; }
}

export async function doctor(ctx: SetupCtx, mbxHome: string, opts: { peerTimeoutMs?: number } = {}): Promise<Check[]> {
  const out: Check[] = [];
  const add = (level: Level, label: string, fix?: string) => out.push({ level, label, fix });
  add("info", `agentmbx ${VERSION} (node ${process.versions.node})`);
  if (Number(process.versions.node.split(".")[0]) < 24) add("fail", `Node ${process.versions.node} is too old`, "install Node 24 or later");

  const initialized = existsSync(join(mbxHome, "config.json"));
  let node: MbxNode | null = null;
  if (!initialized) add("fail", `host not initialized (${mbxHome})`, "agentmbx setup   (or: agentmbx init --host <name>)");
  else {
    node = new MbxNode(mbxHome);
    add("ok", `host ${node.host} initialized (key ${fingerprint(node.key.publicKey)})`);
    if (await daemonAnswers(node.config.port)) add("ok", `daemon answers on 127.0.0.1:${node.config.port}`);
    else add("fail", `daemon not answering on 127.0.0.1:${node.config.port}`, "agentmbx daemon install   (log: " + join(mbxHome, "daemon.log") + ")");
  }

  for (const d of detect(ctx)) {
    if (!d.found) { if (d.why !== "not found") add("info", `${d.cli}: ${d.why}`); continue; }
    const es = edits(ctx, d.cli);
    for (const kind of ["mcp", "hooks"] as const) {
      const e = es.filter((x) => x.kind === kind);
      if (!e.length) continue;
      const ok = e.every(wired);
      const what = kind === "mcp" ? "MCP server" : "hooks";
      add(ok ? "ok" : "fail", `${d.cli}: ${what} ${ok ? "wired" : "not wired"} (${e.map((x) => x.path.replace(ctx.home, "~")).join(", ")})`, ok ? undefined : `agentmbx setup --only ${d.cli}`);
    }
  }

  const sk = skillStatus(ctx.home);
  add(sk.installed ? "ok" : "warn", `skill ${sk.installed ? "installed" : "not installed"} (~/.agents/skills/agentmbx)`, sk.installed ? undefined : "agentmbx setup --only skill");
  for (const l of sk.links) if (!l.ok) add("warn", `skill not linked at ${l.path.replace(ctx.home, "~")}`, "agentmbx setup --only skill");

  if (node) {
    add("info", existsSync(ownerPath(node.home)) ? `owner key present (${node.ownerPub ? fingerprint(node.ownerPub) : "?"})` : "no owner key on this host (optional: agentmbx owner init)");
    const peers = node.peers();
    const approved = peers.filter((p) => p.state === "approved");
    if (!approved.length) add("info", "no paired hosts (optional: agentmbx pair <host>:7373)");
    await Promise.all(approved.map(async (p) => {
      try {
        const path = "/v1/agents";
        const res = await fetch(`http://${p.addr}${path}`, { headers: signHop(node!, "GET", path, ""), signal: AbortSignal.timeout(opts.peerTimeoutMs ?? 3000) });
        if (res.ok) add("ok", `peer ${p.host} (${p.addr}) reachable and accepts our signature`);
        else add("warn", `peer ${p.host} (${p.addr}) answered ${res.status}: ${(await res.text()).slice(0, 120)}`, `re-pair: agentmbx peers remove ${p.host} && agentmbx pair ${p.addr}`);
      } catch (e) { add("warn", `peer ${p.host} (${p.addr}) unreachable: ${(e as Error).message}`, `check that its daemon runs and TCP ${p.addr.split(":").pop()} is open`); }
    }));
    for (const p of peers.filter((x) => x.state === "pending")) add("warn", `pairing with ${p.host} pending (code ${p.code})`, `if ${p.host} shows the same code: agentmbx pair approve ${p.host} ${p.code}`);
    node.close();
  }
  return out;
}

export const failed = (checks: Check[]) => checks.some((c) => c.level === "fail");

export function formatChecks(checks: Check[]): string {
  const mark: Record<Level, string> = { ok: "✔", fail: "✗", warn: "!", info: "·" };
  return checks.map((c) => `${mark[c.level]} ${c.label}${c.fix ? `\n    fix: ${c.fix}` : ""}`).join("\n");
}
