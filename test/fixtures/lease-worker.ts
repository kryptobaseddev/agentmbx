import { Store } from "../../src/store.ts";
import { IdentityLeases, inspectLeaseProcess } from "../../src/identity-leases.ts";
import { generateKeyPair, fingerprint } from "../../src/crypto.ts";

const store = new Store(process.argv[2]);
let now = 1000;
const leases = new IdentityLeases(store, { idleTtlMs: 100, clock: () => now });
const holder = { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(generateKeyPair().publicKey), cli: "test", sessionId: String(process.pid) };
const tokens = new Map<string, string>();
process.on("message", (message: { id: number; operation: string; name: string; now: number }) => {
  now = message.now;
  try {
    let value: unknown;
    if (message.operation === "claim") {
      const row = leases.claim(message.name, holder); tokens.set(message.name, row.token); value = row;
    } else if (message.operation === "renew") value = leases.renew(message.name, tokens.get(message.name)!);
    else if (message.operation === "release") value = leases.release(message.name, tokens.get(message.name)!);
    else if (message.operation === "write") value = leases.withHeld(message.name, tokens.get(message.name)!, () => {
      store.set(`writer:${message.name}`, String(process.pid)); return process.pid;
    });
    else throw new Error(`unknown operation ${message.operation}`);
    process.send?.({ id: message.id, ok: true, value });
  } catch (error) { process.send?.({ id: message.id, ok: false, code: (error as { code?: string }).code, error: String(error) }); }
});
process.send?.({ ready: true });
