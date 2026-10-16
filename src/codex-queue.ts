// Codex's experimental queue API; no thread is started or resumed by this client.
import { spawn } from "node:child_process";
import { ulid } from "./crypto.ts";
import { identityGeneration } from "./identity-control.ts";
import { inspectLeaseProcess, type IdentityLease } from "./identity-leases.ts";
import type { Store } from "./store.ts";

type Process = { pid: number; start: string };
export interface CodexPending {
  v: 1; thread: string; agent: string; generation: string; holder: Process;
  clientId: string; deliveries: { id: string; agent: string }[]; settled: boolean;
  writer: Process; worker?: Process;
}
export interface CodexQueueContext {
  store: Store; agent: string; deliveries: CodexPending["deliveries"];
  run: <T>(operation: () => T, readOnly?: boolean) => T;
  keep: (pending: CodexPending) => boolean;
}
export const codexPendingKey = (p: Pick<CodexPending, "thread" | "generation">) => `codex-queue:${encodeURIComponent(p.thread)}:${p.generation}`;
const processShape = (p: Process) => Number.isSafeInteger(p?.pid) && p.pid > 0 && typeof p.start === "string" && p.start.length > 0 && p.start.length <= 300;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 300;
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
export const codexFailureClass = (value: string): string => /experimental|unknown method|method not found/i.test(value) ? "unsupported-protocol"
  : /no rollout|thread.*not found|no such thread/i.test(value) ? "thread-missing"
  : /locked|database.*busy/i.test(value) ? "storage-busy" : /auth|login|credential/i.test(value) ? "authentication"
  : /ENOENT/i.test(value) ? "unavailable"
  : /EACCES|permission denied/i.test(value) ? "permission" : /timeout|timed out/i.test(value) ? "timeout" : "provider-error";

function records(store: Store): CodexPending[] {
  return (store.db.prepare("SELECT k,v FROM kv WHERE k GLOB 'codex-queue:*'").all() as { k: string; v: string }[]).map(row => {
    let p: CodexPending;
    try { p = JSON.parse(row.v); } catch { throw fail("CODEX_QUEUE_STATE", "invalid Codex pending receipt"); }
    if (p?.v !== 1 || !text(p.thread) || !text(p.agent) || !/^[a-f0-9]{64}$/.test(p.generation)
      || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(p.clientId) || !processShape(p.holder) || !processShape(p.writer)
      || p.worker !== undefined && !processShape(p.worker) || typeof p.settled !== "boolean"
      || !Array.isArray(p.deliveries) || !p.deliveries.length || !p.deliveries.every(d => text(d?.id) && text(d?.agent))
      || row.k !== codexPendingKey(p)) throw fail("CODEX_QUEUE_STATE", "invalid Codex pending receipt");
    return p;
  });
}
const sameRecord = (store: Store, p: CodexPending) => {
  try { return JSON.parse(store.get(codexPendingKey(p)) ?? "null")?.clientId === p.clientId; } catch { return false; }
};
const drop = (store: Store, p: CodexPending) => store.tx(() => {
  if (sameRecord(store, p)) store.db.prepare("DELETE FROM kv WHERE k=?").run(codexPendingKey(p));
});
const finished = (p: CodexPending) => {
  if (p.settled) return true;
  const process = p.worker ?? p.writer, evidence = inspectLeaseProcess(process.pid);
  return evidence.alive === false || evidence.alive === true && evidence.start !== null && evidence.start !== process.start;
};

/** One bounded helper for a batch, only when queue I/O is needed; no per-tool child or direct Codex database writes. */
async function nativeQueue<T>(binary: string, operation: (call: (method: string, params: unknown) => Promise<any>, worker: Process) => Promise<T>): Promise<T> {
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  let buffer = "", stderr = "", nextId = 0, ended = false;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const reject = (error: Error) => { for (const p of waiting.values()) p.reject(error); waiting.clear(); };
  const timer = setTimeout(() => { reject(fail("ETIMEDOUT", "Codex queue helper timed out")); child.kill(); }, 20_000);
  const exited = new Promise<void>(resolve => {
    child.once("error", error => { ended = true; reject(error); resolve(); });
    child.once("exit", (code, signal) => { ended = true; reject(Object.assign(new Error("Codex queue helper closed"), { exitCode: code, signal })); resolve(); });
  });
  child.stdin.on("error", reject);
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    if (buffer.length > 2 * 1024 * 1024) { reject(fail("CODEX_QUEUE_PROTOCOL", "Codex queue response exceeded limit")); child.kill(); return; }
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line), pending = waiting.get(response.id);
        if (!pending) continue; // notifications, never model input
        waiting.delete(response.id);
        if (response.error) pending.reject(Object.assign(new Error(String(response.error.message).slice(0, 300)), { rpcCode: response.error.code }));
        else pending.resolve(response.result);
      } catch { reject(fail("CODEX_QUEUE_PROTOCOL", "invalid Codex queue response")); }
    }
  });
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    if (ended) { reject(fail("CODEX_QUEUE_CLOSED", "Codex queue helper closed")); return; }
    const id = ++nextId; waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  let error: unknown;
  try {
    await call("initialize", { clientInfo: { name: "agentmbx_queue", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const start = child.pid ? inspectLeaseProcess(child.pid).start : null;
    if (!child.pid || !start) throw fail("CODEX_QUEUE_PROCESS", "Codex queue helper birth is unknown");
    return await operation(call, { pid: child.pid, start });
  } catch (e) { error = e; throw e; }
  finally {
    child.stdin.end();
    const stop = setTimeout(() => child.kill("SIGKILL"), 1000); // only our helper: ignored EOF/SIGTERM cannot stall the daemon
    await exited; clearTimeout(stop); clearTimeout(timer);
    if (error instanceof Error) Object.assign(error, { exitCode: child.exitCode, stderrClass: codexFailureClass(stderr || error.message) });
  }
}

async function owned(call: (method: string, params: unknown) => Promise<any>, p: CodexPending): Promise<string[]> {
  const ids: string[] = [], cursors = new Set<string>(); let cursor: string | null = null;
  do {
    const page = await call("thread/queue/list", { threadId: p.thread, cursor, limit: 100 });
    if (!Array.isArray(page?.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw fail("CODEX_QUEUE_PROTOCOL", "invalid Codex queue page");
    for (const item of page.data) {
      if (!text(item?.id) || !text(item?.clientUserMessageId)) throw fail("CODEX_QUEUE_PROTOCOL", "invalid Codex queued item");
      if (item.clientUserMessageId === p.clientId) ids.push(item.id);
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw fail("CODEX_QUEUE_PROTOCOL", "repeated Codex queue cursor");
    if (cursor) cursors.add(cursor);
    if (cursors.size > 100) throw fail("CODEX_QUEUE_PROTOCOL", "Codex queue pagination exceeded limit");
  } while (cursor);
  return ids;
}

async function reconcileOne(store: Store, binary: string, p: CodexPending, keep: (p: CodexPending) => boolean): Promise<boolean> {
  return nativeQueue(binary, async call => {
    const ids = await owned(call, p);
    if (keep(p) && ids.length) return false;
    for (const id of ids) {
      const result = await call("thread/queue/delete", { threadId: p.thread, queuedSubmissionId: id });
      if (typeof result?.deleted !== "boolean") throw fail("CODEX_QUEUE_PROTOCOL", "invalid Codex queue deletion receipt");
    }
    // An absent item is not proof while its original add can still commit in another helper.
    if (!ids.length && !finished(p)) return false;
    drop(store, p); return true;
  });
}

export async function reconcileCodexQueue(store: Store, binary: string, keep: (p: CodexPending) => boolean): Promise<Set<string>> {
  const blocked = new Set<string>();
  let pending: CodexPending[];
  try { pending = records(store); } catch { return new Set(["*"]); } // preserve corrupt receipts; never guess ownership
  for (const p of pending) if (!keep(p)) {
    try { if (!await reconcileOne(store, binary, p, keep)) blocked.add(p.agent); }
    catch (error) {
      blocked.add(p.agent);
      const e = error as Error & { exitCode?: number; stderrClass?: string; rpcCode?: number };
      store.audit("codex.queue.cleanup_failed", { agent: p.agent, thread: p.thread, exitCode: e.exitCode ?? null, rpcCode: e.rpcCode ?? null, stderrClass: e.stderrClass ?? codexFailureClass(e.message) });
    }
  }
  return blocked;
}

/** Pending is persisted inside the captured lease; native I/O and helper shutdown are always outside it. */
export async function enqueueCodexQueue(binary: string, thread: string, message: string, context: CodexQueueContext, recheck: () => boolean): Promise<string> {
  const { store } = context;
  for (const previous of records(store).filter(p => p.thread === thread)) {
    if (!await reconcileOne(store, binary, previous, context.keep)) throw fail("CODEX_QUEUE_PENDING", "an owned Codex notice is still queued or being submitted");
  }
  const writerStart = inspectLeaseProcess(process.pid).start;
  if (!writerStart) throw fail("CODEX_QUEUE_PROCESS", "Codex queue writer birth is unknown");
  const pending = context.run((): CodexPending => {
    if (!recheck()) throw fail("CODEX_QUEUE_FENCED", "Codex wake authority changed");
    if (records(store).some(p => p.thread === thread)) throw fail("CODEX_QUEUE_PENDING", "an owned Codex notice is pending");
    const lease = store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(context.agent) as unknown as IdentityLease;
    if (!lease || lease.cli !== "codex" || lease.session_id !== thread || lease.released_at !== null || !lease.holder_start) throw fail("CODEX_QUEUE_FENCED", "Codex wake lease changed");
    const generation = identityGeneration(lease.token);
    if (!generation) throw fail("CODEX_QUEUE_FENCED", "Codex wake generation is missing");
    const p: CodexPending = { v: 1, thread, agent: lease.name, generation, holder: { pid: lease.holder_pid, start: lease.holder_start },
      clientId: ulid(), deliveries: context.deliveries, settled: false, writer: { pid: process.pid, start: writerStart } };
    store.set(codexPendingKey(p), JSON.stringify(p)); return p;
  }, false);
  let submitted = false;
  try {
    return await nativeQueue(binary, async (call, worker) => {
      context.run(() => {
        if (!sameRecord(store, pending) || !recheck()) throw fail("CODEX_QUEUE_FENCED", "Codex wake authority changed");
        pending.worker = worker; store.set(codexPendingKey(pending), JSON.stringify(pending));
      }, false);
      submitted = true;
      const result = await call("thread/queue/add", { threadId: thread, clientUserMessageId: pending.clientId, input: [{ type: "text", text: message, text_elements: [] }] });
      const item = result?.queuedSubmission;
      if (!text(item?.id) || item.clientUserMessageId !== pending.clientId || !Array.isArray(item.input)
        || item.input.length !== 1 || item.input[0]?.type !== "text" || item.input[0]?.text !== message)
        throw fail("CODEX_QUEUE_PROTOCOL", "mismatched Codex queue receipt");
      return item.id;
    });
  } catch (error) {
    if (submitted && error instanceof Error && !(error as { rpcCode?: number }).rpcCode)
      Object.assign(error, { code: (error as { code?: string }).code ?? "CODEX_QUEUE_CLOSED" });
    throw error;
  } finally {
    if (!submitted) drop(store, pending);
    store.tx(() => {
      if (sameRecord(store, pending)) store.set(codexPendingKey(pending), JSON.stringify({ ...pending, settled: true }));
    });
    // Releasing/reading during the native add still requires withdrawing a late admission.
    if (!context.keep(pending)) try { await reconcileOne(store, binary, { ...pending, settled: true }, context.keep); } catch { /* durable receipt retries next daemon pass */ }
  }
}
