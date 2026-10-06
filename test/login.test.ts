// T256: `agentmbx login` against an in-process RFC 8628 server. The cloud endpoint (T251) is absent.
// A successful poll must not leave the access token in the output or under MBX_HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import {
  CLOUD_ENROLMENT_FILE, CLOUD_KEY_FILE, cloudPopMessage,
  ENROL_CHALLENGE_PATH, ENROL_PATH, REVOKE_SESSION_PATH,
  type CloudCertificate,
} from "../src/cloud-key.ts";
import { canonical, fingerprint, verifyData } from "../src/crypto.ts";
import {
  DEFAULT_LOGIN_BASE_URL, DEVICE_CODE_PATH, DEVICE_GRANT_TYPE, DEVICE_TOKEN_PATH, LOGIN_CLIENT_ID,
  defaultLoginIO, openVerificationPage, parseLoginBase, runLogin, sshSession,
  type LoginIO, type LoginPostResult,
} from "../src/login.ts";
import { MbxNode } from "../src/node.ts";

const TOKEN = "mbx-login-token-do-not-store";
const DEVICE = "mbx-device-code-do-not-print";
const USER = "ABCD-EFGH";
const FP = "abcd-ef12-3456-7890";

const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

type Step = Record<string, unknown> | "drop";

async function fakeAuth(script: {
  device?: Step;
  polls: Step[];
  onJson?: (req: { url: string; body: string; authorization: string }) => Step | undefined;
}): Promise<{
  base: string;
  requests: () => { url: string; type: string; body: string }[];
  close: () => Promise<void>;
}> {
  const requests: { url: string; type: string; body: string }[] = [];
  let polls = 0;
  const server = createServer(async (req, res) => {
    req.on("error", () => {});
    const body = await readBody(req);
    requests.push({ url: req.url ?? "", type: String(req.headers["content-type"] ?? ""), body });
    const step = req.url === DEVICE_CODE_PATH ? (script.device ?? deviceBody())
      : req.url === DEVICE_TOKEN_PATH ? script.polls[polls++]
      : script.onJson?.({ url: req.url ?? "", body, authorization: String(req.headers.authorization ?? "") });
    answer(res, step);
  });
  server.on("clientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, requests: () => requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function answer(res: ServerResponse, step: Step | undefined): void {
  if (step === undefined) { res.statusCode = 404; res.end(); return; }
  if (step === "drop") { res.destroy(); return; }
  res.statusCode = typeof step.error === "string" ? 400 : 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(step));
}

function deviceBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_code: DEVICE, user_code: USER,
    verification_uri: "http://verify.example/device",
    verification_uri_complete: `http://verify.example/device?user_code=${USER}`,
    expires_in: 600, interval: 5, ...over,
  };
}

function harness(over: Partial<LoginIO> = {}): { io: LoginIO; lines: string[]; opened: string[]; sleeps: number[] } {
  const lines: string[] = [];
  const opened: string[] = [];
  const sleeps: number[] = [];
  const base = defaultLoginIO();
  return {
    lines, opened, sleeps,
    io: {
      ...base,
      post: base.post,
      open: async (url) => { opened.push(url); return true; },
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
      log: (line) => lines.push(line),
      isSsh: () => false,
      ...over,
    },
  };
}

async function cli(env: Record<string, string>, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const saved = { ...process.env };
  const log = console.log;
  const write = process.stderr.write.bind(process.stderr);
  let out = "", err = "";
  Object.assign(process.env, env);
  console.log = (...a: unknown[]) => { out += `${a.join(" ")}\n`; };
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try { process.exitCode = 0; await main(argv); return { code: Number(process.exitCode ?? 0), out, err }; }
  finally { console.log = log; process.stderr.write = write; process.env = saved; process.exitCode = 0; }
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

async function closedBase(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return base;
}

test("parseLoginBase keeps an http(s) origin and path", () => {
  assert.equal(parseLoginBase(`${DEFAULT_LOGIN_BASE_URL}/`), DEFAULT_LOGIN_BASE_URL);
  assert.throws(() => parseLoginBase("javascript:alert(1)"), /http or https/);
  assert.throws(() => parseLoginBase("https://user:pass@accounts.agentmbx.com/api/auth"), /username or password/);
  assert.throws(() => parseLoginBase("https://accounts.agentmbx.com/api/auth?x=1"), /query or hash/);
});

test("SSH never launches a browser", async () => {
  assert.equal(sshSession({ SSH_CONNECTION: "1 2 3 4" }), true);
  assert.equal(sshSession({ SSH_TTY: "/dev/pts/1" }), true);
  assert.equal(sshSession({}), false);
  assert.equal(await openVerificationPage("http://127.0.0.1/device", { SSH_CONNECTION: "1" }), false);
});

test("device flow prints the code and fingerprint, opens the page, and slows down", async () => {
  const auth = await fakeAuth({
    polls: [{ error: "authorization_pending" }, { error: "slow_down" }, { error: "slow_down" }, { access_token: TOKEN, token_type: "Bearer" }],
  });
  try {
    const run = harness();
    const outcome = await runLogin({ baseUrl: auth.base, host: "macbook", fingerprint: FP, openBrowser: true }, run.io);
    assert.equal(outcome.ok, true);
    assert.deepEqual(run.opened, [`http://verify.example/device?user_code=${USER}`]);
    const text = run.lines.join("\n");
    for (const line of [
      `User code: ${USER}`,
      `Host: macbook  key: ${FP}`,
      `Open this URL: http://verify.example/device?user_code=${USER}`,
      "Compare this host key with the approval page before you approve.",
      "Opened the verification page.",
      "Signed in.",
      `Host key: ${FP}`,
      "No credential was stored.",
    ]) assert.ok(text.includes(line), line);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes(DEVICE), false);
    // interval 5; authorization_pending keeps it; each slow_down adds 5 seconds (RFC 8628 §3.5).
    assert.deepEqual(run.sleeps, [5000, 5000, 10_000, 15_000]);
    const [code, ...polls] = auth.requests();
    assert.ok(code);
    const codeBody = new URLSearchParams(code.body);
    assert.equal(code.url, DEVICE_CODE_PATH);
    assert.match(code.type, /^application\/x-www-form-urlencoded/);
    assert.equal(codeBody.get("client_id"), LOGIN_CLIENT_ID);
    assert.equal(codeBody.get("host"), "macbook");
    assert.equal(codeBody.get("host_fingerprint"), FP);
    assert.equal(polls.length, 4);
    for (const poll of polls) {
      const body = new URLSearchParams(poll.body);
      assert.equal(poll.url, DEVICE_TOKEN_PATH);
      assert.equal(body.get("grant_type"), DEVICE_GRANT_TYPE);
      assert.equal(body.get("device_code"), DEVICE);
      assert.equal(body.get("client_id"), LOGIN_CLIENT_ID);
      assert.equal(body.get("host_fingerprint"), null);
      assert.equal(body.get("access_token"), null);
    }
  } finally { await auth.close(); }
});

test("denial, expiry, a dropped poll, and a dead server print the next step", async () => {
  const denied = await fakeAuth({ polls: [{ error: "access_denied" }] });
  try {
    const run = harness({ open: async () => false });
    const outcome = await runLogin({ baseUrl: denied.base, host: "macbook", fingerprint: FP, openBrowser: true }, run.io);
    assert.equal(outcome.ok, false);
    assert.equal(run.opened.length, 0);
    assert.ok(run.lines.includes("Could not open a browser. Open the URL above and enter the user code."));
    assert.ok(run.lines.includes("Sign-in was denied."));
    assert.ok(run.lines.includes("Run `agentmbx login` again if you still want to sign this host in."));
  } finally { await denied.close(); }

  const expired = await fakeAuth({ polls: [{ error: "expired_token" }] });
  try {
    const run = harness();
    const outcome = await runLogin({ baseUrl: expired.base, host: "macbook", fingerprint: FP, openBrowser: false }, run.io);
    assert.equal(outcome.ok, false);
    assert.ok(run.lines.includes("No browser on this machine. Open the URL above and enter the user code."));
    assert.ok(run.lines.includes("This sign-in code expired."));
    assert.ok(run.lines.includes("Run `agentmbx login` again to get a new code."));
  } finally { await expired.close(); }

  const dropped = await fakeAuth({ polls: ["drop"] });
  try {
    const run = harness();
    const outcome = await runLogin({ baseUrl: dropped.base, host: "macbook", fingerprint: FP, openBrowser: false }, run.io);
    assert.equal(outcome.ok, false);
    assert.ok(run.lines.includes(`User code: ${USER}`));
    assert.ok(run.lines.includes("Lost the connection to the sign-in server while waiting for approval."));
    assert.ok(run.lines.includes("Check the address and your network, then run `agentmbx login` again."));
  } finally { await dropped.close(); }

  const dead = await closedBase();
  const down = harness();
  const failure = await runLogin({ baseUrl: dead, host: "macbook", fingerprint: FP, openBrowser: true }, down.io);
  assert.equal(failure.ok, false);
  assert.equal(down.opened.length, 0);
  assert.equal(down.lines.some((l) => l.startsWith("User code:")), false);
  assert.ok(down.lines.includes(`Could not reach the sign-in server at ${dead}.`));
  assert.ok(down.lines.includes("Check the address and your network, then run `agentmbx login` again."));
});

test("a short-lived code stops on the local deadline, and SSH prints the URL", async () => {
  let t = 0;
  const auth = await fakeAuth({
    device: deviceBody({ expires_in: 10, interval: 5 }),
    polls: [{ error: "authorization_pending" }, { access_token: TOKEN }],
  });
  try {
    const run = harness({
      now: () => t,
      sleep: async (ms) => { run.sleeps.push(ms); t += ms; },
    });
    const outcome = await runLogin({ baseUrl: auth.base, host: "macbook", fingerprint: FP, openBrowser: false }, run.io);
    assert.equal(outcome.ok, false);
    assert.deepEqual(run.sleeps, [5000, 5000]);
    assert.equal(auth.requests().filter((r) => r.url === DEVICE_TOKEN_PATH).length, 1);
    assert.ok(run.lines.includes("This sign-in code expired."));
    assert.equal(run.lines.join("\n").includes(TOKEN), false);
  } finally { await auth.close(); }

  const page = deviceBody();
  delete page.verification_uri_complete;
  const ssh = await fakeAuth({ device: page, polls: [{ access_token: TOKEN }] });
  try {
    const run = harness({ isSsh: () => true });
    const outcome = await runLogin({ baseUrl: ssh.base, host: "macbook", fingerprint: FP, openBrowser: true }, run.io);
    assert.equal(outcome.ok, true);
    assert.deepEqual(run.opened, []);
    assert.ok(run.lines.includes("Open this URL: http://verify.example/device"));
    assert.ok(run.lines.includes("No browser on this machine. Open the URL above and enter the user code."));
    assert.equal(run.lines.includes("Opened the verification page."), false);
  } finally { await ssh.close(); }
});

test("a bad device response and the default accounts base do not open a page", async () => {
  const junk = await fakeAuth({ device: { verification_uri: "javascript:alert(1)", user_code: USER }, polls: [] });
  try {
    const run = harness();
    const outcome = await runLogin({ baseUrl: junk.base, host: "macbook", fingerprint: FP, openBrowser: true }, run.io);
    assert.equal(outcome.ok, false);
    assert.deepEqual(run.opened, []);
    assert.ok(run.lines.includes(`The sign-in server at ${junk.base} did not return a device code.`));
    assert.ok(run.lines.includes("Check --base-url and run `agentmbx login` again."));
  } finally { await junk.close(); }

  let posted = "";
  const run = harness({
    post: async (url): Promise<LoginPostResult> => { posted = url; return { kind: "network", message: "stop" }; },
  });
  const outcome = await runLogin({ baseUrl: DEFAULT_LOGIN_BASE_URL, host: "macbook", fingerprint: FP, openBrowser: true }, run.io);
  assert.equal(outcome.ok, false);
  assert.equal(posted, `${DEFAULT_LOGIN_BASE_URL}${DEVICE_CODE_PATH}`);
  assert.deepEqual(run.opened, []);
  assert.ok(run.lines.includes(`Could not reach the sign-in server at ${DEFAULT_LOGIN_BASE_URL}.`));
});

test("agentmbx login exchanges the device session and fails closed", async () => {
  const hits: { url: string; body: string; authorization: string }[] = [];
  const storedEnrolment = {
    host_id: "host_test_1",
    client_id: LOGIN_CLIENT_ID,
    token_endpoint: "http://127.0.0.1/token",
    jwks_uri: "http://127.0.0.1/jwks",
    resources: { api: "http://127.0.0.1/api", relay: "http://127.0.0.1/relay" },
  };
  const auth = await fakeAuth({
    device: deviceBody({ interval: 1 }),
    polls: [{ access_token: TOKEN, token_type: "Bearer" }, { access_token: TOKEN, token_type: "Bearer" }],
    onJson: (req) => {
      hits.push(req);
      if (req.authorization !== `Bearer ${TOKEN}`) return { error: "invalid_token" };
      if (req.url === ENROL_CHALLENGE_PATH) return { nonce: "nonce-cloud-pop-01", expires_in: 60 };
      if (req.url === ENROL_PATH) return { ...storedEnrolment, sync_url: "https://sync.example/v1", note: "dropped-sync-secret" };
      if (req.url === REVOKE_SESSION_PATH) return {};
      return undefined;
    },
  });
  const home = mkdtempSync(join(tmpdir(), "mbx-login-"));
  try {
    const node = new MbxNode(home);
    const host = node.host;
    const fp = fingerprint(node.key.publicKey);
    node.close();
    const ok = await cli({ MBX_HOME: home }, ["login", "--base-url", auth.base, "--no-browser"]);
    assert.equal(ok.code, 0, ok.err);
    assert.ok(ok.out.includes(`User code: ${USER}`));
    assert.ok(ok.out.includes(`Host: ${host}  key: ${fp}`));
    assert.ok(ok.out.includes(`Open this URL: http://verify.example/device?user_code=${USER}`));
    assert.ok(ok.out.includes("No browser on this machine. Open the URL above and enter the user code."));
    assert.ok(ok.out.includes("Signed in."));
    assert.ok(ok.out.includes("Session revoked."));
    assert.ok(ok.out.includes("No bearer secret was stored."));
    assert.equal(ok.out.includes("No credential was stored."), false);
    assert.equal(ok.out.includes(TOKEN), false);
    assert.equal(ok.out.includes(DEVICE), false);
    assert.equal(treeHas(home, TOKEN), false);
    assert.equal(treeHas(home, DEVICE), false);
    assert.equal(treeHas(home, "dropped-sync-secret"), false);
    const cloud = JSON.parse(readFileSync(join(home, CLOUD_KEY_FILE), "utf8")) as { publicKey: string; privateKey: string };
    assert.ok(ok.out.includes(`Cloud key: ${fingerprint(cloud.publicKey)}`));
    assert.equal(ok.out.includes(cloud.privateKey), false);
    assert.equal(statSync(join(home, CLOUD_KEY_FILE)).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, CLOUD_ENROLMENT_FILE)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(home, CLOUD_ENROLMENT_FILE), "utf8")), storedEnrolment);

    const sshHome = mkdtempSync(join(tmpdir(), "mbx-login-ssh-"));
    const ssh = await cli({ MBX_HOME: sshHome, SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 2" }, ["login", "--base-url", auth.base]);
    assert.equal(ssh.code, 0, ssh.err);
    assert.ok(ssh.out.includes("No browser on this machine. Open the URL above and enter the user code."));
    assert.equal(ssh.out.includes("Opened the verification page."), false);
    assert.equal(ssh.out.includes(TOKEN), false);
    assert.equal(treeHas(sshHome, TOKEN), false);
    assert.equal(treeHas(sshHome, "dropped-sync-secret"), false);
    assert.deepEqual(JSON.parse(readFileSync(join(sshHome, CLOUD_ENROLMENT_FILE), "utf8")), storedEnrolment);

    const enrols = hits.filter((hit) => hit.url === ENROL_PATH);
    assert.equal(hits.filter((hit) => hit.url === ENROL_CHALLENGE_PATH).length, 2);
    assert.equal(enrols.length, 2);
    assert.equal(hits.filter((hit) => hit.url === REVOKE_SESSION_PATH).length, 2);
    for (const hit of enrols) {
      const body = JSON.parse(hit.body) as { host_pub: string; nonce: string; proof: string; certificate: CloudCertificate };
      assert.equal(hit.authorization, `Bearer ${TOKEN}`);
      assert.equal(hit.body.includes(TOKEN), false);
      assert.equal(body.nonce, "nonce-cloud-pop-01");
      assert.equal(body.certificate.payload.aud, auth.base);
      assert.equal("account_id" in body.certificate.payload, false);
      assert.equal(verifyData(body.host_pub, canonical(body.certificate.payload), body.certificate.sig), true);
      assert.equal(verifyData(body.certificate.payload.cloud_pub, cloudPopMessage({
        nonce: body.nonce,
        hostPublicKey: body.host_pub,
        cloudPublicKey: body.certificate.payload.cloud_pub,
        aud: body.certificate.payload.aud,
      }), body.proof), true);
    }
    for (const hit of hits.filter((h) => h.url === REVOKE_SESSION_PATH)) {
      assert.equal(hit.authorization, `Bearer ${TOKEN}`);
      assert.equal(hit.body, "{}");
      assert.equal(hit.body.includes(TOKEN), false);
    }
  } finally { await auth.close(); }

  const deny = await fakeAuth({ device: deviceBody({ interval: 1 }), polls: [{ error: "access_denied" }] });
  try {
    const home = mkdtempSync(join(tmpdir(), "mbx-login-deny-"));
    const result = await cli({ MBX_HOME: home }, ["login", "--base-url", deny.base, "--no-browser"]);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes("Sign-in was denied."));
    assert.ok(result.out.includes("Run `agentmbx login` again if you still want to sign this host in."));
    assert.equal(treeHas(home, TOKEN), false);
  } finally { await deny.close(); }

  const dead = await closedBase();
  const downHome = mkdtempSync(join(tmpdir(), "mbx-login-down-"));
  const down = await cli({ MBX_HOME: downHome }, ["login", "--base-url", dead, "--no-browser"]);
  assert.equal(down.code, 1);
  assert.ok(down.out.includes(`Could not reach the sign-in server at ${dead}.`));
  assert.ok(down.out.includes("Check the address and your network, then run `agentmbx login` again."));

  const fresh = join(tmpdir(), `mbx-login-unused-${Date.now()}`);
  const bad = await cli({ MBX_HOME: fresh }, ["login", "--base-url", "https://user:pass@accounts.agentmbx.com/api/auth"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /username or password/);
  assert.equal(existsSync(fresh), false);
  const positional = await cli({ MBX_HOME: fresh }, ["login", "https://accounts.agentmbx.com"]);
  assert.equal(positional.code, 2);
  assert.match(positional.err, /positional/);
  const help = await cli({ MBX_HOME: fresh }, ["login", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /user code/);
  assert.match(help.out, /host-key fingerprint/);
  assert.match(help.out, /accounts\.agentmbx\.com\/api\/auth/);
  assert.equal(existsSync(fresh), false);
});
