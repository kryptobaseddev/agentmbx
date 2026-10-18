// `agentmbx login` device authorization (T256, RFC 8628).
// T251 (the cloud endpoint) is not deployed. `--base-url` names the server, and the
// paths are better-auth's device plugin: POST {base}/device/code and POST {base}/device/token.
// With a mailbox home and host key (the CLI), the approved session is exchanged for a
// host-key-bound enrolment and revoked (T257). The access token is never stored.
// Without those, a successful poll reports success and stores nothing.

import { spawn } from "node:child_process";
import type { KeyPair } from "./crypto.ts";
import { exchangeDeviceSession, postJson } from "./cloud-key.ts";

export const DEFAULT_LOGIN_BASE_URL = "https://accounts.agentmbx.com/api/auth";
export const LOGIN_CLIENT_ID = "agentmbx-cli";
export const DEVICE_CODE_PATH = "/device/code";
export const DEVICE_TOKEN_PATH = "/device/token";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const USAGE = "USAGE_ERROR";

export type LoginPostResult =
  | { kind: "json"; status: number; body: unknown; retryAfter?: string }
  | { kind: "network"; message: string };

export interface LoginIO {
  post(url: string, body: Record<string, string>): Promise<LoginPostResult>;
  /** JSON POST for the T257 exchange. The device token travels in a header and is not logged. */
  postJson(url: string, body: unknown, headers: Record<string, string>): Promise<LoginPostResult>;
  open(url: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  isSsh(): boolean;
}

export interface LoginOptions {
  baseUrl: string;
  host: string;
  /** Host-key fingerprint (`fingerprint(publicKey)`), never the key itself. */
  fingerprint: string;
  /** When false, print the URL and do not try to open a browser (`--no-browser`). */
  openBrowser: boolean;
  clientId?: string;
  /** Mailbox home. Together with hostKey, exchanges and revokes the device session. */
  home?: string;
  /** Host signing key. The private half signs only the cloud-key certificate. */
  hostKey?: KeyPair;
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

function usage(message: string): never {
  throw Object.assign(new Error(message), { code: USAGE });
}

/** http(s) origin plus path, with no userinfo, query, or hash. */
export function parseLoginBase(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { usage("--base-url must be an http or https URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") usage("--base-url must be an http or https URL");
  if (url.username || url.password) usage("--base-url must not include a username or password");
  if (url.search || url.hash) usage("--base-url must not include a query or hash");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** SSH has no local browser. Printing the URL is the flow (RFC 8628 §3.3). */
export function sshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

/** Open the verification page. Returns false when there is no browser, including over SSH. */
export async function openVerificationPage(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (sshSession(env)) return false;
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

async function readLimited(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Prefer Retry-After, then X-Retry-After. Anything too long to be a delay is ignored. */
function retryAfterHeader(res: Response): string | undefined {
  for (const name of ["retry-after", "x-retry-after"]) {
    const value = res.headers.get(name);
    if (value && value.length <= 64) return value;
  }
  return undefined;
}

function jsonResult(status: number, body: unknown, retryAfter: string | undefined): LoginPostResult {
  return retryAfter === undefined
    ? { kind: "json", status, body }
    : { kind: "json", status, body, retryAfter };
}

/** RFC 8628 form POST. Redirects are not followed. The body is capped so a token response cannot be huge. */
export async function postForm(url: string, body: Record<string, string>): Promise<LoginPostResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const retryAfter = retryAfterHeader(res);
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      return jsonResult(res.status, null, retryAfter);
    }
    const text = await readLimited(res, 65_536);
    if (text === null || !text) return jsonResult(res.status, null, retryAfter);
    try { return jsonResult(res.status, JSON.parse(text) as unknown, retryAfter); }
    catch { return jsonResult(res.status, null, retryAfter); }
  } catch (e) {
    return { kind: "network", message: e instanceof Error ? e.message : "network error" };
  }
}

export function defaultLoginIO(): LoginIO {
  return {
    post: postForm,
    postJson,
    open: (url) => openVerificationPage(url),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    isSsh: () => sshSession(),
  };
}

function oneLine(value: string, label: string): string {
  if (!/^[\x20-\x7E]{1,200}$/.test(value)) usage(`${label} must be a single line of printable text`);
  return value;
}

function httpPage(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

function oauthError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && /^[a-z_]{1,64}$/.test(error) ? error : null;
}

function accessToken(body: unknown): boolean {
  return readAccessToken(body) !== null;
}

/** Header-safe device token. A value that could break a header is refused, not logged. */
function readAccessToken(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const token = (body as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || !/^[\x21-\x7E]{1,8192}$/.test(token)) return null;
  return token;
}

function parseDevice(body: unknown): DeviceCode | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  if (typeof row.device_code !== "string" || !/^[\x21-\x7E]{8,512}$/.test(row.device_code)) return null;
  if (typeof row.user_code !== "string" || !/^[A-Za-z0-9-]{4,64}$/.test(row.user_code)) return null;
  const verification_uri = httpPage(row.verification_uri);
  if (!verification_uri) return null;
  const complete = row.verification_uri_complete === undefined ? undefined : httpPage(row.verification_uri_complete);
  if (row.verification_uri_complete !== undefined && !complete) return null;
  const expires = typeof row.expires_in === "number" ? row.expires_in : Number(row.expires_in);
  if (!Number.isInteger(expires) || expires < 1 || expires > 86_400) return null;
  let interval = 5;
  if (row.interval !== undefined) {
    const parsed = typeof row.interval === "number" ? row.interval : Number(row.interval);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 3600) interval = parsed;
  }
  return {
    device_code: row.device_code,
    user_code: row.user_code,
    verification_uri,
    ...(complete ? { verification_uri_complete: complete } : {}),
    expires_in: expires,
    interval,
  };
}

function unreachable(io: LoginIO, base: string): void {
  io.log(`Could not reach the sign-in server at ${base}.`);
  io.log("Check the address and your network, then run `agentmbx login` again.");
}

function expired(io: LoginIO): void {
  io.log("This sign-in code expired.");
  io.log("Run `agentmbx login` again to get a new code.");
}

/**
 * Seconds to wait after 429 or 503. A positive delay that still fits in the code's life is used;
 * anything else (missing, non-numeric, huge) waits interval+5, the same step as slow_down.
 */
function rateLimitSeconds(header: string | undefined, remainingMs: number, interval: number): number {
  const parsed = header === undefined ? Number.NaN : Number(header.trim());
  const remainingSec = remainingMs / 1000;
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= remainingSec) return parsed;
  return interval + 5;
}

/**
 * Run the device flow. Prints the user code, the host-key fingerprint, and the verification URL.
 * Opens the page when a browser is available. Polls until approval, denial, expiry, or a network failure.
 * The access token is not returned or logged. With home and hostKey it is exchanged and revoked.
 */
export async function runLogin(opts: LoginOptions, io: LoginIO): Promise<{ ok: boolean }> {
  const base = parseLoginBase(opts.baseUrl);
  const host = oneLine(opts.host, "host");
  const fp = oneLine(opts.fingerprint, "host key fingerprint");
  const clientId = oneLine(opts.clientId ?? LOGIN_CLIENT_ID, "client id");
  const issued = await io.post(`${base}${DEVICE_CODE_PATH}`, {
    client_id: clientId,
    host,
    host_fingerprint: fp,
  });
  if (issued.kind === "network") { unreachable(io, base); return { ok: false }; }
  const device = issued.status === 200 ? parseDevice(issued.body) : null;
  if (!device) {
    io.log(`The sign-in server at ${base} did not return a device code.`);
    io.log("Check --base-url and run `agentmbx login` again.");
    return { ok: false };
  }
  const page = device.verification_uri_complete ?? device.verification_uri;
  io.log(`User code: ${device.user_code}`);
  io.log(`Host: ${host}  key: ${fp}`);
  io.log(`Open this URL: ${page}`);
  io.log("Compare this host key with the approval page before you approve.");
  if (!opts.openBrowser || io.isSsh()) io.log("No browser on this machine. Open the URL above and enter the user code.");
  else if (await io.open(page)) io.log("Opened the verification page.");
  else io.log("Could not open a browser. Open the URL above and enter the user code.");

  // RFC 8628 §3.5: slow_down adds 5 seconds to the interval. The token is not stored.
  // 429/503 use one pause (the retry header, or interval+5), then the same +5 for later polls.
  let interval = device.interval;
  let pause = interval;
  const deadline = io.now() + device.expires_in * 1000;
  for (;;) {
    await io.sleep(pause * 1000);
    if (io.now() >= deadline) { expired(io); return { ok: false }; }
    const polled = await io.post(`${base}${DEVICE_TOKEN_PATH}`, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: device.device_code,
      client_id: clientId,
    });
    if (polled.kind === "network") {
      io.log("Lost the connection to the sign-in server while waiting for approval.");
      io.log("Check the address and your network, then run `agentmbx login` again.");
      return { ok: false };
    }
    const error = oauthError(polled.body);
    if (error === "authorization_pending") { pause = interval; continue; }
    if (error === "slow_down") { interval += 5; pause = interval; continue; }
    if (error === "access_denied") {
      io.log("Sign-in was denied.");
      io.log("Run `agentmbx login` again if you still want to sign this host in.");
      return { ok: false };
    }
    if (error === "expired_token") { expired(io); return { ok: false }; }
    if (error) {
      io.log(`Sign-in stopped: ${error}.`);
      io.log("Run `agentmbx login` again.");
      return { ok: false };
    }
    if (polled.status === 429 || polled.status === 503) {
      const remaining = deadline - io.now();
      const wait = rateLimitSeconds(polled.retryAfter, remaining, interval);
      if (wait * 1000 > remaining) { expired(io); return { ok: false }; }
      pause = wait;
      interval += 5;
      continue;
    }
    if (polled.status === 200 && accessToken(polled.body)) {
      const token = readAccessToken(polled.body);
      if (opts.home && opts.hostKey && token) {
        return exchangeDeviceSession({
          home: opts.home,
          hostKey: opts.hostKey,
          hostName: host,
          audience: base,
          deviceToken: token,
        }, { postJson: io.postJson, now: () => io.now(), log: (line) => io.log(line) });
      }
      // No host key was supplied: report success and keep nothing.
      io.log("Signed in.");
      io.log(`Host key: ${fp}`);
      io.log("No credential was stored.");
      return { ok: true };
    }
    io.log(`The sign-in server at ${base} sent an unexpected token response.`);
    io.log("Check --base-url and run `agentmbx login` again.");
    return { ok: false };
  }
}
