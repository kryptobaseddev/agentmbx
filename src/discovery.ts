// LAN discovery: advertise this host as _agentmbx._tcp over mDNS/DNS-SD and browse for other hosts.
// Discovery only finds addresses. Trust never comes from mDNS: it comes from the pairing token and the host keys
// pinned at pairing. When multicast is blocked, everything still works with explicit addresses.
import makeMdns from "multicast-dns";
import { networkInterfaces } from "node:os";

export const SERVICE = "_agentmbx._tcp.local";
const SERVICES_META = "_services._dns-sd._udp.local";
const TTL = 120;

export interface Advert { host: string; fp: string; v: string }
export interface Seen extends Advert { ip: string; port: number; addr: string }

/** DNS-SD TXT strings: v (protocol version), host (AgentMBX host name), fp (host key fingerprint). */
export function encodeTxt(a: Advert): Buffer[] {
  return [`v=${a.v}`, `host=${a.host}`, `fp=${a.fp}`].map((s) => Buffer.from(s, "utf8"));
}

/** Parse TXT data (Buffer, string or an array of them). First occurrence of a key wins, keys are case-insensitive. */
export function decodeTxt(data: unknown): Partial<Advert> {
  const out: Record<string, string> = {};
  for (const it of Array.isArray(data) ? data : [data]) {
    const s = Buffer.isBuffer(it) ? it.toString("utf8") : typeof it === "string" ? it : "";
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const k = s.slice(0, i).toLowerCase();
    if (!(k in out)) out[k] = s.slice(i + 1);
  }
  return { host: out.host, fp: out.fp, v: out.v };
}

/** Non-internal IPv4 addresses of this machine (LAN addresses to print and advertise). */
export function lanIPv4(): string[] {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
}

const lc = (s: unknown) => String(s ?? "").toLowerCase();

/** Answer DNS-SD queries for this host until stop(). Bind errors (multicast blocked, port taken) go to onError and
 *  never throw: discovery is optional. reuseAddr lets us share UDP 5353 with mDNSResponder (macOS) or avahi (Linux). */
export function advertise(a: Advert & { port: number }, onError: (e: Error) => void = () => {}): { stop: () => Promise<void> } {
  const m = makeMdns({ reuseAddr: true, loopback: true });
  const instance = `${a.host}.${SERVICE}`, target = `${a.host}-agentmbx.local`;
  const records = (ttl: number) => [
    { name: SERVICE, type: "PTR" as const, ttl, data: instance },
    { name: instance, type: "SRV" as const, ttl, data: { port: a.port, target, priority: 0, weight: 0 } },
    { name: instance, type: "TXT" as const, ttl, data: encodeTxt(a) },
    ...lanIPv4().map((ip) => ({ name: target, type: "A" as const, ttl, data: ip })),
  ];
  const names = new Set([SERVICE, instance, target].map(lc));
  m.on("error", onError);
  m.on("warning", onError);
  m.on("query", (q) => {
    const qs = q.questions ?? [];
    if (qs.some((x) => lc(x.name) === SERVICES_META)) m.respond({ answers: [{ name: SERVICES_META, type: "PTR", ttl: TTL, data: SERVICE }] });
    if (qs.some((x) => names.has(lc(x.name)))) m.respond({ answers: records(TTL) });
  });
  const announce = () => m.respond({ answers: records(TTL) });
  announce();
  const again = setTimeout(announce, 1_000); again.unref();
  return {
    stop: () => new Promise<void>((resolve) => {
      clearTimeout(again);
      try { m.respond({ answers: records(0) }, () => m.destroy(() => resolve())); } catch { resolve(); }
    }),
  };
}

/** Ask the LAN for _agentmbx._tcp hosts and collect answers for `timeoutMs`. Returns [] when multicast is unavailable. */
export function browse(timeoutMs = 3_000): Promise<Seen[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Seen>();
    let m: ReturnType<typeof makeMdns>;
    try { m = makeMdns({ reuseAddr: true, loopback: true }); } catch { return resolve([]); }
    m.on("error", () => {});
    m.on("warning", () => {});
    m.on("response", (res, rinfo) => {
      const all = [...(res.answers ?? []), ...(res.additionals ?? [])];
      for (const ptr of all) {
        if (ptr.type !== "PTR" || lc(ptr.name) !== SERVICE) continue;
        const inst = lc(ptr.data);
        const srv = all.find((r) => r.type === "SRV" && lc(r.name) === inst);
        const txt = all.find((r) => r.type === "TXT" && lc(r.name) === inst);
        if (!srv || srv.type !== "SRV" || !txt || ptr.ttl === 0) continue;
        const t = decodeTxt((txt as { data?: unknown }).data);
        if (!t.host) continue;
        const ips = all.filter((r) => r.type === "A" && lc(r.name) === lc(srv.data.target)).map((r) => String((r as { data?: unknown }).data));
        const ip = ips.includes(rinfo.address) ? rinfo.address : (ips[0] ?? rinfo.address);
        found.set(t.host, { host: t.host, fp: t.fp ?? "", v: t.v ?? "", ip, port: srv.data.port, addr: `${ip}:${srv.data.port}` });
      }
    });
    const ask = () => { try { m.query({ questions: [{ name: SERVICE, type: "PTR" }] }); } catch { /* socket gone */ } };
    ask();
    const t1 = setTimeout(ask, Math.min(1_000, timeoutMs / 2));
    setTimeout(() => { clearTimeout(t1); try { m.destroy(); } catch { /* already closed */ } resolve([...found.values()]); }, timeoutMs);
  });
}
