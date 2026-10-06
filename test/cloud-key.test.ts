// T257: per-host cloud key, nonce proof, allowlisted enrolment, immediate revoke.
// The cloud server does not exist. These tests are the fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOUD_ENROLMENT_FILE, CLOUD_KEY_FILE, CLOUD_POP_PREFIX,
  ENROL_CHALLENGE_PATH, ENROL_PATH, REVOKE_SESSION_PATH,
  cloudCertificate, cloudPopMessage, exchangeDeviceSession, loadOrCreateCloudKey,
  type CloudExchangeIO, type CloudPostResult, type HostEnrolment,
} from "../src/cloud-key.ts";
import { canonical, fingerprint, generateKeyPair, signData, verifyData, type KeyPair } from "../src/crypto.ts";

const TOKEN = "mbx-login-token-do-not-store";
const BEARER = "mbx-bearer-do-not-store";
const REFRESH = "mbx-refresh-do-not-store";
const NONCE = "nonce-cloud-pop-01";
const NOW = 1_700_000_000_000;

const ENROLMENT: HostEnrolment = {
  host_id: "host_test_1",
  client_id: "agentmbx-cli",
  token_endpoint: "http://127.0.0.1/token",
  jwks_uri: "http://127.0.0.1/jwks",
  resources: { api: "http://127.0.0.1/api", relay: "http://127.0.0.1/relay" },
};

interface Hit { url: string; raw: string; body: unknown; authorization: string }

const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function treeHas(dir: string, needle: string): boolean {
  if (!existsSync(dir)) return false;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) { if (treeHas(path, needle)) return true; }
    else if (ent.isFile() && readFileSync(path).includes(Buffer.from(needle))) return true;
  }
  return false;
}

function homeDir(): string {
  return mkdtempSync(join(tmpdir(), "mbx-cloud-"));
}

async function serve(route: (hit: Hit) => { status: number; json?: unknown }): Promise<{
  base: string;
  hits: Hit[];
  close: () => Promise<void>;
}> {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    req.on("error", () => {});
    try {
      const raw = await readBody(req);
      let body: unknown = null;
      if (raw) { try { body = JSON.parse(raw) as unknown; } catch { body = raw; } }
      const hit = { url: req.url ?? "", raw, body, authorization: String(req.headers.authorization ?? "") };
      hits.push(hit);
      const out = route(hit);
      res.statusCode = out.status;
      if (out.json === undefined) res.end();
      else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(out.json)); }
    } catch { res.statusCode = 500; res.end(); }
  });
  server.on("clientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function happyRoute(hit: Hit): { status: number; json?: unknown } {
  if (hit.authorization !== `Bearer ${TOKEN}`) return { status: 401, json: { error: "invalid_token" } };
  if (hit.url === ENROL_CHALLENGE_PATH) return { status: 200, json: { nonce: NONCE, expires_in: 60 } };
  if (hit.url === ENROL_PATH) return { status: 200, json: { ...ENROLMENT, sync_url: "https://sync.example/v1", note: "dropped-sync-secret" } };
  if (hit.url === REVOKE_SESSION_PATH) return { status: 204 };
  return { status: 404, json: { error: "nope" } };
}

function ioFor(lines: string[]): CloudExchangeIO {
  return {
    postJson: async (url, body, headers): Promise<CloudPostResult> => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: JSON.stringify(body),
        redirect: "manual",
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) { try { parsed = JSON.parse(text) as unknown; } catch { parsed = null; } }
      return { kind: "json", status: res.status, body: parsed };
    },
    now: () => NOW,
    log: (line) => lines.push(line),
  };
}

test("cloud key is created mode 0600 and then reused", () => {
  const home = homeDir();
  const first = loadOrCreateCloudKey(home);
  const second = loadOrCreateCloudKey(home);
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(second.privateKey, first.privateKey);
  assert.equal(mode(join(home, CLOUD_KEY_FILE)), 0o600);
  assert.equal(fingerprint(first.publicKey).split("-").length, 4);
});

test("cloud key mode stays 0600 under a wide umask", () => {
  const home = homeDir();
  const prev = process.umask(0o777);
  try {
    const key = loadOrCreateCloudKey(home);
    assert.equal(mode(join(home, CLOUD_KEY_FILE)), 0o600);
    assert.equal(loadOrCreateCloudKey(home).publicKey, key.publicKey);
  } finally { process.umask(prev); }
});

test("certificate verifies under the host key and the proof under the cloud key", () => {
  const host = generateKeyPair();
  const cloud = generateKeyPair();
  const aud = "https://accounts.example/api/auth";
  const cert = cloudCertificate({ hostKey: host, cloudPublicKey: cloud.publicKey, aud, iat: 1_700_000_000 });
  assert.equal("account_id" in cert.payload, false);
  assert.equal(cert.payload.aud, aud);
  assert.equal(cert.payload.type, "cloud-key");
  assert.equal(verifyData(host.publicKey, canonical(cert.payload), cert.sig), true);
  const message = cloudPopMessage({
    nonce: NONCE, hostPublicKey: host.publicKey, cloudPublicKey: cloud.publicKey, aud,
  });
  assert.equal(message, `${CLOUD_POP_PREFIX}\n${NONCE}\n${host.publicKey}\n${cloud.publicKey}\n${aud}`);
  assert.equal(verifyData(cloud.publicKey, message, signData(cloud.privateKey, message)), true);
});

test("exchange stores the allowlist only, revokes, and reuses the cloud key", async () => {
  const home = homeDir();
  const atRevoke: (string | null)[] = [];
  const enrolmentPath = join(home, CLOUD_ENROLMENT_FILE);
  const server = await serve((hit) => {
    if (hit.url === REVOKE_SESSION_PATH) atRevoke.push(existsSync(enrolmentPath) ? readFileSync(enrolmentPath, "utf8") : null);
    return happyRoute(hit);
  });
  const host = generateKeyPair();
  const lines: string[] = [];
  try {
    const outcome = await exchangeDeviceSession({
      home, hostKey: host, hostName: "macbook", audience: server.base, deviceToken: TOKEN,
    }, ioFor(lines));
    assert.equal(outcome.ok, true);
    const again = await exchangeDeviceSession({
      home, hostKey: host, hostName: "macbook", audience: server.base, deviceToken: TOKEN,
    }, ioFor(lines));
    assert.equal(again.ok, true);

    const text = lines.join("\n");
    assert.match(text, /Signed in\./);
    assert.match(text, /Session revoked\./);
    assert.match(text, /No bearer secret was stored\./);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes("Bearer"), false);
    const cloud = JSON.parse(readFileSync(join(home, CLOUD_KEY_FILE), "utf8")) as KeyPair;
    assert.ok(text.includes(`Cloud key: ${fingerprint(cloud.publicKey)}`));
    assert.equal(text.includes(cloud.privateKey), false);
    assert.equal(mode(join(home, CLOUD_KEY_FILE)), 0o600);
    assert.equal(mode(join(home, CLOUD_ENROLMENT_FILE)), 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(home, CLOUD_ENROLMENT_FILE), "utf8")), ENROLMENT);
    assert.equal(treeHas(home, TOKEN), false);
    assert.equal(treeHas(home, "access_token"), false);
    assert.equal(treeHas(home, "refresh_token"), false);
    assert.equal(treeHas(home, "dropped-sync-secret"), false);

    const challenges = server.hits.filter((hit) => hit.url === ENROL_CHALLENGE_PATH);
    const enrols = server.hits.filter((hit) => hit.url === ENROL_PATH);
    const revokes = server.hits.filter((hit) => hit.url === REVOKE_SESSION_PATH);
    assert.equal(challenges.length, 2);
    assert.equal(enrols.length, 2);
    assert.equal(revokes.length, 2);
    for (const hit of challenges) {
      const body = hit.body as { host_name: string; host_pub: string; cloud_pub: string };
      assert.equal(hit.authorization, `Bearer ${TOKEN}`);
      assert.equal(hit.raw.includes(TOKEN), false);
      assert.equal(hit.raw.includes(cloud.privateKey), false);
      assert.deepEqual(Object.keys(body).sort(), ["cloud_pub", "host_name", "host_pub"]);
      assert.equal(body.host_name, "macbook");
      assert.equal(body.host_pub, host.publicKey);
      assert.equal(body.cloud_pub, cloud.publicKey);
    }
    for (const hit of enrols) {
      const body = hit.body as {
        host_name: string; host_pub: string; nonce: string; proof: string;
        certificate: { payload: { v: number; type: string; host_pub: string; cloud_pub: string; aud: string; iat: number }; sig: string };
      };
      assert.equal(hit.raw.includes(TOKEN), false);
      assert.equal(hit.raw.includes(cloud.privateKey), false);
      assert.deepEqual(Object.keys(body).sort(), ["certificate", "host_name", "host_pub", "nonce", "proof"]);
      assert.equal(body.nonce, NONCE);
      assert.equal(body.certificate.payload.aud, server.base);
      assert.equal(body.certificate.payload.iat, 1_700_000_000);
      assert.equal("account_id" in body.certificate.payload, false);
      assert.equal(verifyData(host.publicKey, canonical(body.certificate.payload), body.certificate.sig), true);
      assert.equal(verifyData(cloud.publicKey, cloudPopMessage({
        nonce: body.nonce,
        hostPublicKey: host.publicKey,
        cloudPublicKey: cloud.publicKey,
        aud: server.base,
      }), body.proof), true);
    }
    for (const hit of revokes) {
      assert.equal(hit.authorization, `Bearer ${TOKEN}`);
      assert.equal(hit.raw, "{}");
    }
    assert.ok(server.hits.findIndex((hit) => hit.url === ENROL_PATH) < server.hits.findIndex((hit) => hit.url === REVOKE_SESSION_PATH));
    assert.deepEqual(atRevoke, [null, JSON.stringify(ENROLMENT) + "\n"]);
  } finally { await server.close(); }
});

test("a bearer in the enrolment response is not stored, and the session is still revoked", async () => {
  const server = await serve((hit) => {
    if (hit.url === ENROL_CHALLENGE_PATH) return { status: 200, json: { nonce: NONCE, expires_in: 30 } };
    if (hit.url === ENROL_PATH) return { status: 200, json: { ...ENROLMENT, access_token: BEARER, refresh_token: REFRESH } };
    if (hit.url === REVOKE_SESSION_PATH) return { status: 200, json: {} };
    return { status: 404 };
  });
  const home = homeDir();
  const lines: string[] = [];
  try {
    const outcome = await exchangeDeviceSession({
      home, hostKey: generateKeyPair(), hostName: "macbook", audience: server.base, deviceToken: TOKEN,
    }, ioFor(lines));
    assert.equal(outcome.ok, false);
    assert.ok(lines.includes("The sign-in server returned a bearer token. It was not stored."));
    assert.equal(existsSync(join(home, CLOUD_ENROLMENT_FILE)), false);
    assert.equal(existsSync(join(home, CLOUD_KEY_FILE)), true);
    assert.equal(treeHas(home, TOKEN), false);
    assert.equal(treeHas(home, BEARER), false);
    assert.equal(treeHas(home, REFRESH), false);
    assert.equal(server.hits.filter((hit) => hit.url === REVOKE_SESSION_PATH).length, 1);
    assert.equal(lines.join("\n").includes(TOKEN), false);
    assert.equal(lines.join("\n").includes(BEARER), false);
  } finally { await server.close(); }
});

test("enrol failure and challenge failure still revoke and write no enrolment", async () => {
  const enrolFail = await serve((hit) => {
    if (hit.url === ENROL_CHALLENGE_PATH) return { status: 200, json: { nonce: NONCE, expires_in: 30 } };
    if (hit.url === ENROL_PATH) return { status: 400, json: { error: "invalid_client" } };
    if (hit.url === REVOKE_SESSION_PATH) return { status: 200, json: {} };
    return { status: 404 };
  });
  const home = homeDir();
  try {
    const outcome = await exchangeDeviceSession({
      home, hostKey: generateKeyPair(), hostName: "macbook", audience: enrolFail.base, deviceToken: TOKEN,
    }, ioFor([]));
    assert.equal(outcome.ok, false);
    assert.equal(existsSync(join(home, CLOUD_ENROLMENT_FILE)), false);
    assert.equal(treeHas(home, TOKEN), false);
    assert.equal(enrolFail.hits.filter((hit) => hit.url === REVOKE_SESSION_PATH).length, 1);
  } finally { await enrolFail.close(); }

  const challengeFail = await serve((hit) => {
    if (hit.url === ENROL_CHALLENGE_PATH) return { status: 500, json: {} };
    if (hit.url === REVOKE_SESSION_PATH) return { status: 200, json: {} };
    return { status: 404 };
  });
  const other = homeDir();
  try {
    const outcome = await exchangeDeviceSession({
      home: other, hostKey: generateKeyPair(), hostName: "macbook", audience: challengeFail.base, deviceToken: TOKEN,
    }, ioFor([]));
    assert.equal(outcome.ok, false);
    assert.equal(existsSync(join(other, CLOUD_ENROLMENT_FILE)), false);
    assert.equal(existsSync(join(other, CLOUD_KEY_FILE)), true);
    assert.equal(treeHas(other, TOKEN), false);
    assert.equal(challengeFail.hits.some((hit) => hit.url === ENROL_PATH), false);
    assert.equal(challengeFail.hits.filter((hit) => hit.url === REVOKE_SESSION_PATH).length, 1);
  } finally { await challengeFail.close(); }
});

test("revoke failure stores nothing", async () => {
  const server = await serve((hit) => {
    if (hit.url === ENROL_CHALLENGE_PATH) return { status: 200, json: { nonce: NONCE, expires_in: 30 } };
    if (hit.url === ENROL_PATH) return { status: 200, json: ENROLMENT };
    if (hit.url === REVOKE_SESSION_PATH) return { status: 500, json: {} };
    return { status: 404 };
  });
  const home = homeDir();
  const lines: string[] = [];
  try {
    const outcome = await exchangeDeviceSession({
      home, hostKey: generateKeyPair(), hostName: "macbook", audience: server.base, deviceToken: TOKEN,
    }, ioFor(lines));
    assert.equal(outcome.ok, false);
    assert.ok(lines.includes("The sign-in session could not be revoked. No enrolment was stored. Run `agentmbx login` again."));
    assert.equal(existsSync(join(home, CLOUD_ENROLMENT_FILE)), false);
    assert.equal(treeHas(home, TOKEN), false);
    assert.equal(lines.join("\n").includes("Signed in."), false);
  } finally { await server.close(); }
});

test("a corrupt cloud key and a symlink are not replaced", async () => {
  const server = await serve((hit) => {
    if (hit.url === REVOKE_SESSION_PATH) return { status: 200, json: {} };
    return { status: 500, json: {} };
  });
  const home = homeDir();
  const keyPath = join(home, CLOUD_KEY_FILE);
  writeFileSync(keyPath, "{", { mode: 0o600 });
  const lines: string[] = [];
  try {
    const outcome = await exchangeDeviceSession({
      home, hostKey: generateKeyPair(), hostName: "macbook", audience: server.base, deviceToken: TOKEN,
    }, ioFor(lines));
    assert.equal(outcome.ok, false);
    assert.equal(readFileSync(keyPath, "utf8"), "{");
    assert.equal(existsSync(join(home, CLOUD_ENROLMENT_FILE)), false);
    assert.ok(lines.includes("The cloud key on this machine could not be used. It was not replaced."));
    assert.equal(server.hits.some((hit) => hit.url === ENROL_CHALLENGE_PATH), false);
    assert.equal(server.hits.filter((hit) => hit.url === REVOKE_SESSION_PATH).length, 1);

    const linked = homeDir();
    const target = join(linked, "real.key");
    writeFileSync(target, "target-secret", { mode: 0o600 });
    symlinkSync(target, join(linked, CLOUD_KEY_FILE));
    const linkLines: string[] = [];
    const refused = await exchangeDeviceSession({
      home: linked, hostKey: generateKeyPair(), hostName: "macbook", audience: server.base, deviceToken: TOKEN,
    }, ioFor(linkLines));
    assert.equal(refused.ok, false);
    assert.equal(readFileSync(target, "utf8"), "target-secret");
    assert.equal(existsSync(join(linked, CLOUD_ENROLMENT_FILE)), false);
    assert.equal(treeHas(linked, TOKEN), false);
  } finally { await server.close(); }
});

test("a bad host key and an unsafe token do not create a cloud key", async () => {
  const urls: string[] = [];
  const io: CloudExchangeIO = {
    postJson: async (url) => {
      urls.push(url);
      if (url.endsWith(REVOKE_SESSION_PATH)) return { kind: "json", status: 200, body: {} };
      return { kind: "json", status: 500, body: {} };
    },
    now: () => NOW,
    log: () => {},
  };
  const home = homeDir();
  const host = generateKeyPair();
  const other = generateKeyPair();
  const mismatch = await exchangeDeviceSession({
    home,
    hostKey: { publicKey: host.publicKey, privateKey: other.privateKey },
    hostName: "macbook",
    audience: "http://127.0.0.1:9",
    deviceToken: TOKEN,
  }, io);
  assert.equal(mismatch.ok, false);
  assert.equal(existsSync(join(home, CLOUD_KEY_FILE)), false);
  assert.deepEqual(urls, ["http://127.0.0.1:9/revoke-session"]);

  const calls: string[] = [];
  const unsafe = await exchangeDeviceSession({
    home, hostKey: host, hostName: "macbook", audience: "http://127.0.0.1:9", deviceToken: "bad\ntoken",
  }, {
    postJson: async (url) => { calls.push(url); return { kind: "network", message: "no" }; },
    now: () => NOW,
    log: (line) => calls.push(line),
  });
  assert.equal(unsafe.ok, false);
  assert.deepEqual(calls, ["The sign-in server sent an unexpected token response."]);
  assert.equal(existsSync(join(home, CLOUD_KEY_FILE)), false);
});

test("a sign-in URL with a query does not receive the device token", async () => {
  const calls: string[] = [];
  const outcome = await exchangeDeviceSession({
    home: homeDir(),
    hostKey: generateKeyPair(),
    hostName: "macbook",
    audience: "https://user:pass@accounts.example/api/auth?x=1",
    deviceToken: TOKEN,
  }, {
    postJson: async (url) => { calls.push(url); return { kind: "network", message: "no" }; },
    now: () => NOW,
    log: () => {},
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(calls, []);
});
