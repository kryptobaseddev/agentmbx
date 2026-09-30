// Host key rotation (T030). The old host key signs the new host and enc keys, and the new key countersigns (proof of
// possession). Peers verify the record against the key they pinned at pairing, so pairings survive without re-pairing.
// Retired host public keys keep verifying mail stored before the rotation. Retired enc private keys keep opening mail
// that was sealed in flight. Files are private (0600) and replaced atomically.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, generateKeyPair, signData, verifyData, type KeyPair } from "./crypto.ts";
import { generateEncKeyPair } from "./body-encryption.ts";

export interface RotationRecord { v: 1; type: "host-rotation"; host: string; old_pub: string; new_pub: string; new_enc_pub: string; iat: string }
export interface SignedRotation { rec: RotationRecord; old_sig: string; new_sig: string }
export interface RetiredKeys { host: { publicKey: string; retired_at: string }[]; enc: (KeyPair & { retired_at: string })[] }
/** Every rotation this host made, and per peer how many of them it has accepted. */
export interface RotationLog { records: SignedRotation[]; delivered: Record<string, number> }

const readJson = <T>(path: string, empty: T): T => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : empty;
const writePrivate = (path: string, value: unknown) => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
};

export const retiredKeys = (home: string) => readJson<RetiredKeys>(join(home, "retired-keys.json"), { host: [], enc: [] });
export const rotationLog = (home: string) => readJson<RotationLog>(join(home, "rotations.json"), { records: [], delivered: {} });
export const saveRotationLog = (home: string, log: RotationLog) => writePrivate(join(home, "rotations.json"), log);

/** Null when `s` validly rotates the host key a peer pinned as `pinned`. */
export function checkRotation(s: SignedRotation, pinned: string): string | null {
  const r = s?.rec;
  if (r?.v !== 1 || r.type !== "host-rotation" || typeof r.host !== "string" || typeof r.iat !== "string" || typeof r.old_pub !== "string"
    || typeof r.new_pub !== "string" || typeof r.new_enc_pub !== "string" || typeof s.old_sig !== "string" || typeof s.new_sig !== "string") return "not a rotation record";
  if (r.old_pub !== pinned) return "rotation does not start from the pinned host key";
  if (r.new_pub === r.old_pub) return "rotation keeps the same host key";
  const payload = canonical(r);
  if (!verifyData(r.old_pub, payload, s.old_sig)) return "rotation is not signed by the pinned host key";
  if (!verifyData(r.new_pub, payload, s.new_sig)) return "rotation is not signed by the new host key";
  return null;
}

/**
 * Replace this host's signing and enc keys. The new keys are staged first and the signed record logged before
 * anything is swapped, so a crash leaves either the old keys or a completable rotation (finishRotation).
 */
export function rotateKeys(home: string, host: string, cur: KeyPair, curEnc: KeyPair, now = new Date()): SignedRotation {
  const next = generateKeyPair(), nextEnc = generateEncKeyPair();
  const rec: RotationRecord = { v: 1, type: "host-rotation", host, old_pub: cur.publicKey, new_pub: next.publicKey, new_enc_pub: nextEnc.publicKey, iat: now.toISOString() };
  const payload = canonical(rec);
  const signed: SignedRotation = { rec, old_sig: signData(cur.privateKey, payload), new_sig: signData(next.privateKey, payload) };
  writePrivate(join(home, "host.key.next"), next);
  writePrivate(join(home, "enc.key.next"), nextEnc);
  const log = rotationLog(home);
  log.records.push(signed);
  saveRotationLog(home, log);
  finishRotation(home);
  return signed;
}

/** Complete a logged rotation: retire the current keys, then swap in each staged key (idempotent after a crash). */
export function finishRotation(home: string): boolean {
  const staged = { host: join(home, "host.key.next"), enc: join(home, "enc.key.next") };
  if (!existsSync(staged.host) && !existsSync(staged.enc)) return false;
  const last = rotationLog(home).records.at(-1)?.rec;
  const want = { host: last?.new_pub, enc: last?.new_enc_pub };
  const retired = retiredKeys(home);
  for (const kind of ["host", "enc"] as const) {
    if (!existsSync(staged[kind])) continue;
    const next = readJson<KeyPair>(staged[kind], null as never);
    if (next.publicKey !== want[kind]) return false; // never logged: the old keys stay
    const cur = readJson<KeyPair>(join(home, `${kind}.key`), null as never);
    if (kind === "host" && !retired.host.some((k) => k.publicKey === cur.publicKey)) retired.host.push({ publicKey: cur.publicKey, retired_at: last!.iat });
    if (kind === "enc" && !retired.enc.some((k) => k.publicKey === cur.publicKey)) retired.enc.push({ ...cur, retired_at: last!.iat });
  }
  writePrivate(join(home, "retired-keys.json"), retired);
  for (const kind of ["host", "enc"] as const) if (existsSync(staged[kind])) renameSync(staged[kind], join(home, `${kind}.key`));
  return true;
}
