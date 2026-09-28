// Native OpenCode binding evidence. Start submits one bootstrap prompt; observe never mutates the provider.
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MbxNode } from "../../src/node.ts";
import { captureWakeIdentity } from "../../src/wake-identity.ts";
import { findIdentityControl } from "../../src/identity-control.ts";
import { opencodeService } from "../../src/wake.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BOOTSTRAP = "For this isolated AgentMBX integration test, call mbx_whoami once, report the returned address, and stop. Do not rename the mailbox, send or acknowledge mail, or answer permission prompts.";
type Api = (method: "GET" | "POST", path: string, body?: unknown) => Promise<any>;
export interface BindingState {
  version: 1; kind: "opencode-binding"; root: string; revision: string; home: string; work: string;
  sessionId: string | null; phase: string; history: { at: string; phase: string; details?: unknown }[];
  model: { providerID: "opencode"; id: string };
}

function revision(): string {
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", "src", "dist", "bin", "scripts/e2e/opencode-binding.ts"], { cwd: ROOT });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function save(path: string, state: BindingState, phase: string, details?: unknown) {
  state.phase = phase;
  state.history.push({ at: new Date().toISOString(), phase, ...(details === undefined ? {} : { details }) });
  writeFileSync(path + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flush: true });
  renameSync(path + ".tmp", path);
}

async function withStateLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  let fd: number;
  try { fd = openSync(path + ".lock", "wx", 0o600); }
  catch { throw new Error("Binding state is already in use or locked after interruption; inspect it before any new attempt"); }
  try { return await operation(); }
  finally { closeSync(fd); unlinkSync(path + ".lock"); }
}

function load(path: string): BindingState {
  const state = JSON.parse(readFileSync(path, "utf8")) as BindingState;
  // A copied or hand-edited report must never point this helper at the live mailbox.
  if (state.version !== 1 || state.kind !== "opencode-binding" || state.root !== ROOT
    || state.home !== join(dirname(resolve(path)), "mailbox") || state.work !== join(dirname(resolve(path)), "work")
    || !Array.isArray(state.history) || (state.sessionId !== null && !/^ses_[a-zA-Z0-9]+$/.test(state.sessionId)))
    throw new Error("Invalid or relocated binding state; inspect it without starting a replacement session");
  return state;
}

export function prepareBinding(model = "longcat-2.5-preview-free", getRevision = revision) {
  const rev = getRevision(), base = mkdtempSync(join(tmpdir(), "mbx-opencode-binding-"));
  const home = join(base, "mailbox"), work = join(base, "work"), path = join(base, "binding-result.json");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
  const node = new MbxNode(home, { host: "native-test", port: 0 }); node.close();
  writeFileSync(join(work, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { servers: {
    mbx: { type: "local", command: [process.execPath, join(ROOT, "bin/agentmbx.js"), "mcp"], environment: {
      MBX_HOME: home, MBX_AGENT: "opencode-native", MBX_CLI: "opencode", MBX_NO_DESKTOP: "1",
    } },
  } } }, null, 2), { mode: 0o600 });
  const state: BindingState = { version: 1, kind: "opencode-binding", root: ROOT, revision: rev, home, work,
    sessionId: null, phase: "prepared", history: [], model: { providerID: "opencode", id: model } };
  save(path, state, "prepared");
  return { path, state };
}

export async function providerApi(): Promise<Api> {
  const service = await opencodeService();
  if (!service) throw new Error("OpenCode service is unavailable; no provider started");
  return async (method, path, body) => {
    const response = await fetch(service.url + path, { method, headers: { authorization: service.auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`OpenCode ${method} ${path}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

export async function startBinding(path: string, api: Api, getRevision = revision) {
  return withStateLock(path, async () => {
    const state = load(path);
    if (state.phase !== "prepared" || state.sessionId !== null) throw new Error("Start was already attempted; use observe, never resend or replace the session");
    if (state.revision !== getRevision()) throw new Error("Prepared revision changed; no session started");
    try {
      save(path, state, "create_started");
      const result = await api("POST", "/api/session", { title: "AgentMBX native lease binding", model: state.model, location: { directory: state.work } });
      const id = (result?.data ?? result)?.id;
      if (typeof id !== "string" || !/^ses_[a-zA-Z0-9]+$/.test(id)) throw new Error("Provider response lacks a valid session ID; creation outcome uncertain");
      state.sessionId = id;
      save(path, state, "session_created");
      save(path, state, "bootstrap_started");
      await api("POST", `/api/session/${encodeURIComponent(id)}/synthetic`, { text: BOOTSTRAP, delivery: "queue", resume: true });
      save(path, state, "bootstrap_submitted");
      return state;
    } catch (error) {
      save(path, state, "submission_uncertain", { error: (error as Error).message });
      throw error;
    }
  });
}

export type BindingProof = { verified: false; reason: string } | { verified: true; agent: string; sessionId: string;
  parentPid: number; mcpPid: number; keyFingerprint: string; generation: string | null };
export function inspectBinding(state: BindingState): BindingProof {
  if (!state.sessionId) return { verified: false, reason: "session ID is unknown" };
  const node = new MbxNode(state.home);
  try {
    const row = node.store.db.prepare("SELECT * FROM sessions WHERE cli='opencode' AND session_id=?").get(state.sessionId) as ReturnType<MbxNode["sessionsFor"]>[number] | undefined;
    if (!row) return { verified: false, reason: "no exact native session binding" };
    const guard = captureWakeIdentity(node, row);
    if (!guard) return { verified: false, reason: "binding has no current matching lease/process proof" };
    return guard.run(() => {
      const control = findIdentityControl(node.store, "opencode", state.sessionId!);
      return { verified: true as const, agent: row.agent, sessionId: row.session_id, parentPid: control.parent_pid,
        mcpPid: control.mcp_pid, keyFingerprint: control.control_key, generation: control.generation };
    });
  } finally { node.close(); }
}

export async function observeBinding(path: string, api: Api, inspect = inspectBinding, getRevision = revision) {
  return withStateLock(path, async () => {
    const state = load(path);
    // Observation may retain an uncertain creation, but cannot invent or rediscover its identity by directory.
    if (!state.sessionId) {
      const result = { binding: { verified: false }, outcome: state.phase === "prepared" ? "not_started" : "blocked_missing_session_id", receiptVerified: false };
      save(path, state, state.phase, result); return result;
    }
    if (state.revision !== getRevision()) throw new Error("Prepared revision changed; retain session and inspect the pinned checkout");
    const prefix = `/api/session/${encodeURIComponent(state.sessionId)}`;
    const response = await api("GET", prefix + "/permission"), permissions = response?.data ?? response;
    if (!Array.isArray(permissions)) throw new Error("Permission response is not a list");
    const session = await api("GET", prefix), messages = await api("GET", prefix + "/message");
    const rows = messages?.data ?? messages;
    if (!Array.isArray(rows)) throw new Error("Message response is not a list");
    const calls = rows.flatMap((message: any) => (Array.isArray(message.content) ? message.content : []).flatMap((part: any) =>
      (part.type === "tool" && Array.isArray(part.state?.metadata?.toolCalls) ? part.state.metadata.toolCalls : [])
        .map((call: any) => ({ messageId: message.id, tool: call.tool, status: call.status }))));
    const binding = inspect(state);
    const result = { outcome: permissions.length ? "awaiting_owner_approval" : binding.verified ? "binding_verified" : "binding_pending",
      binding, receiptVerified: false, permissions: permissions.map((p: any) => ({ id: p.id, action: p.action })),
      providerTime: (session?.data ?? session)?.time ?? null, toolCalls: calls };
    save(path, state, "observed", result);
    return result;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, path] = process.argv.slice(2);
    if (action === "prepare") console.log(JSON.stringify(prepareBinding(process.env.OC_MODEL)));
    else if (path && (action === "start" || action === "observe")) {
      const api = await providerApi();
      console.log(JSON.stringify(action === "start" ? await startBinding(path, api) : await observeBinding(path, api)));
    } else throw new Error("Usage: node scripts/e2e/opencode-binding.ts prepare | start RESULT | observe RESULT");
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
