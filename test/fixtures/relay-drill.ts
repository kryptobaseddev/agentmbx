// Child process for the relay crash drills (T167, docs/spec/relay-durability.md §5). It runs one side of the relay
// protocol on real stores (a relay, a sending host or a receiving host) and kills itself with SIGKILL at the named
// boundary: no finally block, no exit handler, no graceful close, exactly like a power cut to the process. The parent
// then restarts it or reopens its store and checks that nothing was lost or duplicated. Never used outside tests.
//
// argv[2] is JSON: {role:"relay", dir, port, key, crash?} | {role:"sender"|"receiver", home, host, relay, crash?}
import { join } from "node:path";
import { keyPairFromPrivate } from "../../src/crypto.ts";
import { MbxNode } from "../../src/node.ts";
import { RelayCore, startRelayServer } from "../../src/relay.ts";
import { SqliteRelayStore } from "../../src/relay-store.ts";
import { relayOpen, relayPushOutbox, relayReceive } from "../../src/relay-v2.ts";

type Cfg = { role: "relay"; dir: string; port: number; key: string; crash?: string }
  | { role: "sender" | "receiver"; home: string; host: string; relay: string; crash?: string };
const cfg = JSON.parse(process.argv[2]!) as Cfg;
const crash = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("unreachable: SIGKILL"); };

if (cfg.role === "relay") {
  const store = new SqliteRelayStore(join(cfg.dir, "relay.db"));
  const core = new RelayCore({}, { store, key: keyPairFromPrivate(cfg.key), log: () => {} });
  /** Kill right after `name` returns: its transaction committed, its answer never leaves. */
  const afterCommit = (name: "pushItems" | "pullItems" | "ackItems") => {
    const orig = core[name].bind(core) as (...a: unknown[]) => unknown;
    (core as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => { orig(...a); return crash(); };
  };
  switch (cfg.crash) {
    case "push:before-commit": { // inside pushItems' transaction, after the row is written: never committed
      const orig = store.insertItem.bind(store);
      store.insertItem = (i) => { orig(i); return crash(); };
      break;
    }
    case "push:after-commit": afterCommit("pushItems"); break;
    case "pull:before-response": afterCommit("pullItems"); break;
    case "ack:before-commit": { // the delete runs inside an outer transaction that never commits
      const orig = store.ack.bind(store);
      store.ack = (target, through) => store.transaction(() => { orig(target, through); return crash(); });
      break;
    }
    case "ack:after-commit": afterCommit("ackItems"); break;
    case undefined: break;
    default: throw new Error(`unknown relay crash point ${cfg.crash}`);
  }
  await startRelayServer(core, cfg.port, "127.0.0.1", { log: () => {} });
  process.stdout.write("ready\n");
} else {
  const node = new MbxNode(cfg.home, { host: cfg.host });
  const is = (input: unknown, init: RequestInit | undefined, path: string, method: string) => String(input).includes(path) && (init?.method ?? "GET") === method;
  const f: typeof fetch = async (input, init) => {
    if (cfg.crash === "push:before-send" && is(input, init, "/v2/relay/items", "POST")) crash(); // the sealed bytes are already persisted
    if (cfg.crash === "ack:before-send" && is(input, init, "/v2/relay/ack", "POST")) crash(); // checkpointed, never acked
    const res = await fetch(input, init);
    if ((cfg.crash === "push:after-response" && is(input, init, "/v2/relay/items", "POST")) || (cfg.crash === "ack:after-response" && is(input, init, "/v2/relay/ack", "POST"))) {
      await res.clone().arrayBuffer(); // the relay committed and answered; this host dies before it records anything
      crash();
    }
    return res;
  };
  if (cfg.crash === "receive:after-deliver") { // the mailbox committed the message; the relay checkpoint is never written
    const orig = node.receive.bind(node);
    node.receive = (x, via) => { orig(x, via); return crash(); };
  }
  const s = await relayOpen(node, cfg.relay, f);
  if (!s) { process.stdout.write("no-session\n"); process.exit(3); }
  const out = cfg.role === "sender" ? await relayPushOutbox(node, s) : { accepted: await relayReceive(node, s) };
  node.close();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
