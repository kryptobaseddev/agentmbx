// `agentmbx doctor`: one checklist that says what works, what doesn't, and the one command that fixes it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fingerprint } from "./crypto.ts";
import { signHop } from "./http.ts";
import { kimiHostedServer, kimiInstances } from "./kimi-web.ts";
import { kimiDesktop } from "./kimi-desktop.ts";
import { version } from "./version.ts";
import { MbxNode } from "./node.ts";
import { authHelperPath, keychainOwnerStatus, ownerInfo } from "./owner.ts";
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

export interface DaemonReadiness extends Check { state: "matching" | "unverified" | "unreachable" }

/** Diagnostic identity comparison, not authentication or proof of message receipt. No pairing side effects. */
export async function daemonReadiness(node: MbxNode, timeoutMs = 1500): Promise<DaemonReadiness> {
  const address = `127.0.0.1:${node.config.port}`;
  const unknown = (reason: string): DaemonReadiness => ({ state: "unverified", level: "warn", label: `daemon identity unverified on ${address}: ${reason}`,
    fix: "check the process listening on this port; an older AgentMBX daemon may need restarting after update" });
  let response: Response;
  try { response = await fetch(`http://${address}/v1/status`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    // Only a refused connection establishes an absent listener. Timeout/reset/abort is uncertain.
    const refused = (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED";
    return { state: refused ? "unreachable" : "unverified", level: "fail", label: `daemon not answering on ${address}`,
      fix: refused ? `agentmbx daemon install   (log: ${join(node.home, "daemon.log")})` : "check the process listening on this port before installing or restarting the daemon" };
  }
  if (response.status !== 200) { await response.body?.cancel(); return unknown(`HTTP ${response.status} (unsupported status endpoint or another service)`); }
  try {
    const reader = response.body?.getReader();
    if (!reader) return unknown("empty response");
    let size = 0; const parts: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 8192) return unknown("response exceeds 8192 bytes");
        parts.push(value);
      }
    } finally { await reader.cancel(); }
    const r = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (r?.service !== "agentmbx" || r.v !== 1 || typeof r.host !== "string" || typeof r.host_pubkey !== "string"
      || typeof r.version !== "string" || r.version.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(r.version)
      || typeof r.started_at !== "string" || !Number.isFinite(Date.parse(r.started_at)) || new Date(r.started_at).toISOString() !== r.started_at)
      return unknown("malformed AgentMBX status");
    if (r.host !== node.host || r.host_pubkey !== node.key.publicKey) return unknown("reported host or key differs from this mailbox");
    if (r.version !== version()) return { state: "unverified", level: "warn", label: `daemon reports expected host ${r.host} on ${address}, but version ${r.version} differs from CLI ${version()}`,
      fix: "restart the daemon after updating; existing MCP sessions may also need restarting" };
    return { state: "matching", level: "ok", label: `daemon reports expected host ${r.host} on ${address} (version ${r.version}, started ${r.started_at}); receipt not tested` };
  } catch { return unknown("malformed, interrupted, or timed-out status response"); }
}

/** Binding evidence is separate from configuration and never proves end-to-end delivery. */
export function sessionReadiness(node: MbxNode, cli: string): Check {
  const rows = node.store.db.prepare("SELECT pid,pid_start,updated_at,session_id,channel FROM sessions WHERE cli=?").all(cli) as
    { pid: number | null; pid_start: string | null; updated_at: string; session_id: string; channel: number }[];
  const live = rows.filter((s) => s.pid && node.sameSession(s.pid, s, { proof: true }));
  if (!rows.length) return { level: "info", label: `${cli}: no mailbox session bindings; receipt not tested` };
  if (!live.length) return { level: "warn", label: `${cli}: no verified live mailbox binding (${rows.length} stale or unverified); receipt not tested`,
    fix: "open a provider session and check its AgentMBX session-start hook" };
  const real = live.filter((s) => !s.session_id.startsWith("mcp-")).length;
  const channels = live.filter((s) => s.channel).length;
  const stale = rows.length - live.length;
  const onlyProvisional = !real && !channels;
  const hostedPids = cli === "kimi" ? new Set([...kimiInstances().map(instance => instance?.pid), kimiDesktop()?.pid]) : new Set<number | undefined>();
  const hostedProvisional = live.filter(s => s.session_id.startsWith("mcp-") && hostedPids.has(s.pid!)).length;
  if (hostedProvisional) return { level: "warn",
    label: `${cli}: ${hostedProvisional} hosted conversation(s) not linked to their mbx server yet; ${real} real session ID(s); receipt not tested`,
    fix: "each hosted conversation links itself on its next prompt (the [mbx] note asks it to call mbx_whoami with a bind ticket)" };

  return { level: onlyProvisional ? "warn" : "info",
    label: `${cli}: ${live.length} verified live mailbox binding(s), ${real} real session ID(s), ${channels} channel binding(s)`
      + (stale ? `, ${stale} stale or unverified` : "") + "; receipt not tested",
    ...(onlyProvisional ? { fix: "run the provider session-start hook to bind its real session ID" }
      : cli === "claude" && !channels ? { fix: "start Claude with 'agentmbx claude' (adds the mbx channel) so idle sessions wake on mail; others see mail on their next prompt" } : {}) };
}

/** A `kimi web` server reads its hooks once at start: one started before AgentMBX was set up runs none (no bind, no Stop). */
export function kimiServerHooks(home: string, kimiHome = process.env.KIMI_CODE_HOME || join(home, ".kimi-code")): Check[] {
  let wiredAt: number;
  try { const cfg = join(kimiHome, "config.toml"); if (!readFileSync(cfg, "utf8").includes("agentmbx hook")) return []; wiredAt = statSync(cfg).mtimeMs; } catch { return []; }
  return kimiInstances(kimiHome).filter(i => typeof i.pid === "number" && typeof i.started_at === "number" && i.started_at < wiredAt && kimiHostedServer(i.pid, kimiHome) !== null)
    .map(i => ({ level: "warn" as Level, label: `kimi web server pid ${i.pid} (port ${i.port}) started before its AgentMBX hooks were last written: its sessions get no mbx hooks`,
      fix: "restart that kimi web server (stop it, then run kimi web again)" }));
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
    out.push(await daemonReadiness(node));
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

  if (node) {
    for (const d of detect(ctx).filter((d) => d.found)) out.push(sessionReadiness(node, d.cli));
    for (const c of kimiServerHooks(ctx.home)) out.push(c);
  }

  const sk = skillStatus(ctx.home);
  add(sk.installed ? "ok" : "warn", `skill ${sk.installed ? "installed" : "not installed"} (~/.agents/skills/agentmbx)`, sk.installed ? undefined : "agentmbx setup --only skill");
  for (const l of sk.links) if (!l.ok) add("warn", `skill not linked at ${l.path.replace(ctx.home, "~")}`, "agentmbx setup --only skill");

  if (node) {
    const owner = ownerInfo(node.home);
    if (!owner) add("info", `no owner key on this host (optional: agentmbx owner init${authHelperPath() ? ", approve the Touch ID prompt" : ", in a terminal"})`);
    else if (owner.backend === "file") add("ok", `owner key ${fingerprint(owner.public_key)} (passphrase file ${owner.path})`);
    else {
      const st = await keychainOwnerStatus(node.home);
      add(st.ok ? "ok" : "fail", `owner key ${fingerprint(owner.public_key)} (macOS Keychain, Touch ID)${st.ok ? "" : `: ${st.detail}`}`,
        st.ok ? undefined : "reinstall AgentMBX.app (agentmbx daemon install); if the Keychain key is gone, move owner.json aside and run agentmbx owner init");
    }
    const peers = node.peers();
    const approved = peers.filter((p) => p.state === "approved");
    if (!approved.length) add("info", "no paired hosts (optional: agentmbx pair <host>:7373)");
    await Promise.all(approved.map(async (p) => {
      try {
        const path = "/v1/agents";
        const res = await fetch(`http://${p.addr}${path}`, { headers: signHop(node!, "GET", path, ""), signal: AbortSignal.timeout(opts.peerTimeoutMs ?? 3000) });
        if (res.ok) add("ok", `peer ${p.host} (${p.addr}) reachable and accepts our signature`);
        else add("warn", `peer ${p.host} (${p.addr}) answered ${res.status}: ${(await res.text()).slice(0, 120)}`, `re-pair: agentmbx peers remove ${p.host} && agentmbx pair ${p.addr}`);
      } catch (e) {
        const seen = node!.store.get(`peer-lastseen:${p.host}`);
        add("warn", `peer ${p.host} (${p.addr}) unreachable: ${(e as Error).message}${seen && seen !== p.addr ? `; last seen at ${seen}` : ""}`,
          seen && seen !== p.addr ? `the daemon re-checks it every minute; to move it now: agentmbx peers addr ${p.host} ${seen}` : `check that its daemon runs and TCP ${p.addr.split(":").pop()} is open`);
      }
      // T201: how this peer's address was last healed, and how fresh its presence beacon is
      try {
        const heal = JSON.parse(node!.store.get(`peer-heal:${p.host}`) ?? "null") as { via: string; at: string; from: string; to: string } | null;
        const pres = node!.store.get(`peer-presence-at:${p.host}`);
        if (heal || pres) add("info", `peer ${p.host}: ${heal ? `address healed ${heal.from} -> ${heal.to} via ${heal.via} at ${heal.at}` : "address never healed"}; ${pres ? `last presence ${pres}` : "no presence beacon yet (peer runs an older AgentMBX)"}`);
      } catch { /* malformed kv: nothing to report */ }
    }));
    for (const p of peers.filter((x) => x.state === "pending")) add("warn", `pairing with ${p.host} pending (code ${p.code})`, `if ${p.host} shows the same code: agentmbx pair approve ${p.host} ${p.code}`);
    const relay = process.env.MBX_RELAY_URL ?? (node.config as { relay?: string }).relay ?? null;
    if (relay) {
      const enrolled = node.store.get(`relay-enrolled:${relay}`);
      add(enrolled ? "ok" : "warn", `relay configured: ${relay}${enrolled ? " (enrolled)" : " (not yet enrolled — the daemon enrols on its next pass)"}`,
        enrolled ? undefined : `check the relay is running: agentmbx relay serve --port …`);
    }
    node.close();
  }
  return out;
}

export const failed = (checks: Check[]) => checks.some((c) => c.level === "fail");

export function formatChecks(checks: Check[]): string {
  const mark: Record<Level, string> = { ok: "✔", fail: "✗", warn: "!", info: "·" };
  return checks.map((c) => `${mark[c.level]} ${c.label}${c.fix ? `\n    fix: ${c.fix}` : ""}`).join("\n");
}
