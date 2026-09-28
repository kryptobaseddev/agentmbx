import { Store } from "../../src/store.ts";
import { IdentityLeases } from "../../src/identity-leases.ts";
import { procStart } from "../../src/proc.ts";
import { fingerprint, generateKeyPair } from "../../src/crypto.ts";
const store = new Store(process.argv[2]), leases = new IdentityLeases(store);
process.on("message", (message) => {
  if (message === "stop") { store.close(); process.exit(0); }
  if (message !== "claim") return;
  try {
    const row = leases.claim("shared", { pid: process.pid, start: procStart(process.pid)!, keyFp: fingerprint(generateKeyPair().publicKey), cli: "test", sessionId: String(process.pid) });
    process.send?.({ result: "claimed", token: row.token });
  } catch (e) { process.send?.({ result: (e as { code?: string }).code ?? String(e) }); }
});
process.send?.({ ready: true });
