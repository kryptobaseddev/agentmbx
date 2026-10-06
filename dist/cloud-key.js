// Per-host cloud key and the device-session exchange (T257).
// The cloud server is not deployed. `agentmbx login` speaks this shape to `--base-url`,
// and the tests cover it with a fake server.
//
// The host key signs one certificate. The cloud key signs one nonce proof. Neither key
// is a bearer. The certificate omits account_id: the device session already names the
// account, and a server-supplied account id is not signed. `aud` is the configured login base.
//
// POST {base}/v1/host/enrolments/challenge   Authorization: Bearer <device token>
//   {"host_name","host_pub","cloud_pub"} -> {"nonce","expires_in"}
// POST {base}/v1/host/enrolments             Authorization: Bearer <device token>
//   {"host_name","host_pub","certificate":{"payload","sig"},"nonce","proof"}
//   payload is {v:1, type:"cloud-key", host_pub, cloud_pub, aud, iat}
//   sig is the host key over canonical(payload)
//   proof is the cloud key over
//   `agentmbx-cloud-pop-v1\n${nonce}\n${host_pub}\n${cloud_pub}\n${aud}`
//   stored response: {host_id, client_id, token_endpoint, jwks_uri, resources:{api,relay}}
// POST {base}/revoke-session                 Authorization: Bearer <device token>, body {}
//
// The device token is never written. access_token and refresh_token are never written.
// The enrolment file is written only after revoke succeeds.
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, fingerprint, generateKeyPair, keyPairFromPrivate, signData, } from "./crypto.js";
import { privatePath } from "./private-files.js";
export const CLOUD_KEY_FILE = "cloud.key";
export const CLOUD_ENROLMENT_FILE = "cloud-enrolment.json";
export const ENROL_CHALLENGE_PATH = "/v1/host/enrolments/challenge";
export const ENROL_PATH = "/v1/host/enrolments";
export const REVOKE_SESSION_PATH = "/revoke-session";
export const CLOUD_POP_PREFIX = "agentmbx-cloud-pop-v1";
const HEADER_SAFE = /^[\x21-\x7E]{1,8192}$/;
/** Load the cloud key, or create it mode 0600. A corrupt file or a symlink is left untouched. */
export function loadOrCreateCloudKey(home) {
    const path = join(home, CLOUD_KEY_FILE);
    const existing = statFile(path);
    if (existing === "symlink")
        throw new Error("cloud key path is a symlink");
    if (existing === "other")
        throw new Error("cloud key path is not a regular file");
    if (existing === "file") {
        const key = parseCloudKey(readFileSync(path, "utf8"));
        privatePath(path, 0o600);
        return key;
    }
    const key = generateKeyPair();
    writeFileSync(path, JSON.stringify(key) + "\n", { mode: 0o600, flag: "wx" });
    privatePath(path, 0o600);
    return key;
}
/** Host-key certificate. `aud` is the client's login base, not a server-supplied URL. */
export function cloudCertificate(args) {
    const payload = {
        v: 1,
        type: "cloud-key",
        host_pub: args.hostKey.publicKey,
        cloud_pub: args.cloudPublicKey,
        aud: args.aud,
        iat: args.iat,
    };
    return { payload, sig: signData(args.hostKey.privateKey, canonical(payload)) };
}
/** Domain string the cloud key signs. The server checks this same byte string. */
export function cloudPopMessage(args) {
    return `${CLOUD_POP_PREFIX}\n${args.nonce}\n${args.hostPublicKey}\n${args.cloudPublicKey}\n${args.aud}`;
}
async function readCapped(res, max) {
    const reader = res.body?.getReader();
    if (!reader)
        return "";
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done)
                break;
            size += part.value.byteLength;
            if (size > max) {
                await reader.cancel();
                return null;
            }
            chunks.push(part.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
}
/** JSON POST. Redirects are not followed. Headers are not logged. */
export async function postJson(url, body, headers = {}) {
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", ...headers },
            body: JSON.stringify(body),
            redirect: "manual",
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
        });
        if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel();
            return { kind: "json", status: res.status, body: null };
        }
        const text = await readCapped(res, 65_536);
        if (text === null || !text)
            return { kind: "json", status: res.status, body: null };
        try {
            return { kind: "json", status: res.status, body: JSON.parse(text) };
        }
        catch {
            return { kind: "json", status: res.status, body: null };
        }
    }
    catch (e) {
        return { kind: "network", message: e instanceof Error ? e.message : "network error" };
    }
}
/**
 * Trade a device-flow session for an allowlisted enrolment.
 * Creates the cloud key first. Revokes on every path that holds a usable token.
 * Writes the enrolment file only after revoke succeeds.
 */
export async function exchangeDeviceSession(opts, io) {
    if (typeof opts.deviceToken !== "string" || !HEADER_SAFE.test(opts.deviceToken)) {
        io.log("The sign-in server sent an unexpected token response.");
        return { ok: false };
    }
    const audience = loginAudience(opts.audience);
    const auth = { authorization: `Bearer ${opts.deviceToken}` };
    // Never send the device token at a URL that failed the audience check.
    const revoke = () => audience ? postRevoke(audience, auth, io) : Promise.resolve(false);
    const fail = async (line) => {
        io.log(line);
        if (!(await revoke())) {
            io.log("The sign-in session could not be revoked. No enrolment was stored. Run `agentmbx login` again.");
        }
        return { ok: false };
    };
    if (!audience)
        return fail("The sign-in address cannot be bound to the cloud key.");
    let host;
    try {
        host = checkedHostKey(opts.hostKey);
    }
    catch {
        return fail("The host key could not sign the cloud-key certificate.");
    }
    let cloud;
    try {
        cloud = loadOrCreateCloudKey(opts.home);
    }
    catch {
        return fail("The cloud key on this machine could not be used. It was not replaced.");
    }
    const challenged = await io.postJson(`${audience}${ENROL_CHALLENGE_PATH}`, {
        host_name: opts.hostName,
        host_pub: host.publicKey,
        cloud_pub: cloud.publicKey,
    }, auth);
    if (challenged.kind === "network")
        return fail("Could not reach the sign-in server to exchange this session.");
    if (carriesBearer(challenged.body))
        return fail("The sign-in server returned a bearer token. It was not stored.");
    const nonce = challenged.status === 200 ? parseNonce(challenged.body) : null;
    if (!nonce)
        return fail("The sign-in server did not return a nonce.");
    const iat = Math.floor(io.now() / 1000);
    if (!Number.isSafeInteger(iat) || iat < 0)
        return fail("The local clock could not stamp the cloud-key certificate.");
    const certificate = cloudCertificate({ hostKey: host, cloudPublicKey: cloud.publicKey, aud: audience, iat });
    const proof = signData(cloud.privateKey, cloudPopMessage({
        nonce,
        hostPublicKey: host.publicKey,
        cloudPublicKey: cloud.publicKey,
        aud: audience,
    }));
    const enrolled = await io.postJson(`${audience}${ENROL_PATH}`, {
        host_name: opts.hostName,
        host_pub: host.publicKey,
        certificate,
        nonce,
        proof,
    }, auth);
    if (enrolled.kind === "network")
        return fail("Could not reach the sign-in server to exchange this session.");
    if (carriesBearer(enrolled.body))
        return fail("The sign-in server returned a bearer token. It was not stored.");
    const enrolment = enrolled.status === 200 ? parseEnrolment(enrolled.body) : null;
    if (!enrolment)
        return fail("The sign-in server did not accept this host.");
    if (!(await revoke())) {
        io.log("The sign-in session could not be revoked. No enrolment was stored. Run `agentmbx login` again.");
        return { ok: false };
    }
    try {
        writeEnrolment(opts.home, enrolment, opts.deviceToken);
    }
    catch {
        io.log("The enrolment record could not be stored. The sign-in session was revoked.");
        return { ok: false };
    }
    io.log("Signed in.");
    io.log(`Cloud key: ${fingerprint(cloud.publicKey)}`);
    io.log("Session revoked.");
    io.log("No bearer secret was stored.");
    return { ok: true };
}
function checkedHostKey(key) {
    if (!key || typeof key.publicKey !== "string" || typeof key.privateKey !== "string") {
        throw new Error("cloud key file is corrupt");
    }
    const derived = keyPairFromPrivate(key.privateKey);
    if (derived.publicKey !== key.publicKey)
        throw new Error("host key does not match its public key");
    return { publicKey: key.publicKey, privateKey: key.privateKey };
}
async function postRevoke(base, headers, io) {
    const audience = loginAudience(base);
    if (!audience)
        return false;
    const result = await io.postJson(`${audience}${REVOKE_SESSION_PATH}`, {}, headers);
    if (result.kind === "network")
        return false;
    return result.status >= 200 && result.status < 300;
}
function loginAudience(raw) {
    if (typeof raw !== "string")
        return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return null;
        if (url.username || url.password || url.search || url.hash)
            return null;
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }
    catch {
        return null;
    }
}
function parseCloudKey(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error("cloud key file is corrupt");
    }
    if (!parsed || typeof parsed !== "object")
        throw new Error("cloud key file is corrupt");
    const row = parsed;
    if (typeof row.publicKey !== "string" || typeof row.privateKey !== "string")
        throw new Error("cloud key file is corrupt");
    let derived;
    try {
        derived = keyPairFromPrivate(row.privateKey);
    }
    catch {
        throw new Error("cloud key file is corrupt");
    }
    if (derived.publicKey !== row.publicKey)
        throw new Error("cloud key file is corrupt");
    return { publicKey: row.publicKey, privateKey: row.privateKey };
}
function statFile(path) {
    try {
        const st = lstatSync(path);
        if (st.isSymbolicLink())
            return "symlink";
        if (st.isFile())
            return "file";
        return "other";
    }
    catch (e) {
        if (e.code === "ENOENT")
            return "missing";
        throw e;
    }
}
function carriesBearer(body) {
    if (!body || typeof body !== "object")
        return false;
    const row = body;
    return (typeof row.access_token === "string" && row.access_token.length > 0)
        || (typeof row.refresh_token === "string" && row.refresh_token.length > 0);
}
function parseNonce(body) {
    if (!body || typeof body !== "object" || Array.isArray(body))
        return null;
    const row = body;
    if (typeof row.nonce !== "string" || !/^[\x21-\x7E]{16,256}$/.test(row.nonce))
        return null;
    if (row.expires_in !== undefined) {
        const expires = typeof row.expires_in === "number" ? row.expires_in : Number(row.expires_in);
        if (!Number.isInteger(expires) || expires < 1 || expires > 600)
            return null;
    }
    return row.nonce;
}
function httpUrl(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 2048)
        return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return null;
        if (url.username || url.password)
            return null;
        return url.toString();
    }
    catch {
        return null;
    }
}
function tokenId(value) {
    if (typeof value !== "string" || !/^[\x21-\x7E]{1,200}$/.test(value))
        return null;
    return value;
}
function parseEnrolment(body) {
    if (!body || typeof body !== "object" || Array.isArray(body))
        return null;
    const row = body;
    const host_id = tokenId(row.host_id);
    const client_id = tokenId(row.client_id);
    const token_endpoint = httpUrl(row.token_endpoint);
    const jwks_uri = httpUrl(row.jwks_uri);
    if (!host_id || !client_id || !token_endpoint || !jwks_uri)
        return null;
    if (!row.resources || typeof row.resources !== "object" || Array.isArray(row.resources))
        return null;
    const resources = row.resources;
    const api = httpUrl(resources.api);
    const relay = httpUrl(resources.relay);
    if (!api || !relay)
        return null;
    return { host_id, client_id, token_endpoint, jwks_uri, resources: { api, relay } };
}
function writeEnrolment(home, enrolment, deviceToken) {
    const path = join(home, CLOUD_ENROLMENT_FILE);
    const kind = statFile(path);
    if (kind === "symlink")
        throw new Error("enrolment path is a symlink");
    if (kind === "other")
        throw new Error("enrolment path is not a regular file");
    const serialized = JSON.stringify(enrolment) + "\n";
    if (serialized.includes(deviceToken) || serialized.includes("access_token") || serialized.includes("refresh_token")) {
        throw new Error("enrolment record is not safe to store");
    }
    writeFileSync(path, serialized, { mode: 0o600 });
    try {
        privatePath(path, 0o600);
    }
    catch (e) {
        try {
            unlinkSync(path);
        }
        catch { /* the private mode could not be kept */ }
        throw e;
    }
}
