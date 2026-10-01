import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { Store } from "../src/store.ts";
import { privatePath } from "../src/private-files.ts";

const mode = (path: string) => statSync(path).mode & 0o7777;
test("startup repairs mailbox directory, keys, and store permission drift without losing mail", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-permissions-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const first = new MbxNode(home, { host: "alpha" });
  const id = first.send({ from: "sender", to: ["reader"], subject: "preserve", body: "private" }).envelope.id;
  first.close();
  // Public-only metadata fixture is enough to exercise both owner file paths without unlocking a key.
  const pub = JSON.parse(readFileSync(join(home, "host.key"), "utf8")).publicKey;
  writeFileSync(join(home, "owner.key"), JSON.stringify({ public_key: pub }));
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: pub }));
  const files = ["config.json", "host.key", "owner.key", "owner.json", "mbx.db"];
  const bytes = files.slice(0, 4).map(f => readFileSync(join(home, f)));
  for (const file of files) chmodSync(join(home, file), 0o666);
  chmodSync(home, 0o777);
  let warnings = "";
  t.mock.method(process.stderr, "write", (chunk: string) => { warnings += chunk; return true; });
  const second = new MbxNode(home);
  try {
    assert.equal(mode(home), 0o700);
    for (const file of [...files, "mbx.db-wal", "mbx.db-shm"]) assert.equal(mode(join(home, file)), 0o600, file);
    files.slice(0, 4).forEach((file, i) => assert.deepEqual(readFileSync(join(home, file)), bytes[i]));
    assert.equal(second.read(id, "reader").body, "private");
    assert.match(warnings, /repaired permission drift/);
    for (const file of files) assert.ok(warnings.includes(file));
    warnings = "";
    const third = new MbxNode(home); third.close();
    assert.equal(warnings, "", "correct modes do not produce recurring warnings");
  } finally { second.close(); }
});

test("Store repairs existing WAL and shared-memory file modes", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-wal-mode-"));
  const first = new Store(home);
  t.after(() => { first.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (const file of ["mbx.db-wal", "mbx.db-shm"]) chmodSync(join(home, file), 0o666);
  const second = new Store(home);
  try { for (const file of ["mbx.db-wal", "mbx.db-shm"]) assert.equal(mode(join(home, file)), 0o600); }
  finally { second.close(); }
});

test("startup refuses symlinked keys without chmoding their targets", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-key-link-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const target = join(home, "unrelated"); writeFileSync(target, "do not change"); chmodSync(target, 0o644);
  symlinkSync(target, join(home, "host.key"));
  assert.throws(() => new MbxNode(home), /refusing non-regular file/);
  assert.equal(mode(target), 0o644);
  assert.equal(readFileSync(target, "utf8"), "do not change");
  assert.throws(() => privatePath(join(home, "missing"), 0o600), /ENOENT/);
  privatePath(join(home, "missing"), 0o600, true);
  assert.throws(() => privatePath(home, 0o600), /refusing non-regular file/);
});
