# Agent cards: compact names, rich identity (design proposal)

Status: proposal for CLEO T059. Nothing here is built. Targets v0.4 (local cards) and v0.5 (cross-owner contacts over the cloud relay, docs/POLICY.md §7).
Scope: naming, the card record, how it is signed and published, cross-owner contact exchange, security, migration.

## 0. Summary of decisions

1. **Names stay short.** The handle is still `[a-z0-9-]{2,40}` picked as today (folder, then `-<cli>`, then `-2…`). Role, intent, project and CLI live in the card, never in the name.
2. **Every agent has a signed card.** The host key signs it (the host already signs for its agents). Its trust chain is card → host key → device record → owner key. Each card does not need its own owner signature.
3. **Every card field is labelled `self`, `host` or `owner`.** Routing may use `self` fields. Authority and policy never do.
4. **AgentMBX uses its own card format. A2A is an export.** The native card uses the same canonical JSON and Ed25519 signature as envelopes. `agentmbx card export --a2a` projects it to an A2A 1.0 `AgentCard` with a JWS signature.
5. **Cross-owner contact starts with a contact card, not with pairing hosts.** A one-time invite (short code, QR or link) exchanges owner keys through the relay. The new contact is `guest` (`ask` only) until the owner signs a `member` record.
6. **Selectors (`role:`, `project:`, `cli:`, `skill:`) only fan out inside one owner's devices.** Cross-owner mail always names an explicit agent.

## 1. Research: what exists and what applies

| Source | What it defines | Use here |
|---|---|---|
| A2A 1.0 `AgentCard` ([spec](https://a2a-protocol.org/latest/specification/), [md](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)) | `name`, `description`, `version`, `provider{organization,url}`, `supportedInterfaces[{url, protocolBinding, protocolVersion, tenant}]`, `capabilities{streaming, pushNotifications, extensions, extendedAgentCard}`, `skills[{id, name, description, tags, examples, inputModes, outputModes}]`, `securitySchemes`/`security`, `defaultInputModes`/`defaultOutputModes`, `iconUrl`, `documentationUrl`, `signatures[]` | **Adopt the field names** wherever the meaning matches (§3 table). The A2A task/streaming model does not apply, because mbx is a mailbox. |
| A2A discovery | `https://{domain}/.well-known/agent-card.json`, plus `GetExtendedAgentCard` for authenticated clients | A public well-known card suits web agents, not a LAN daemon (it would leak who runs what). Our version: a redacted card for peers, the full card only for the owner's own devices (the same idea as A2A's extended card). |
| A2A card signing (§8.4) | JWS (RFC 7515) over the RFC 8785 (JCS) canonical card without `signatures`. The protected header carries `alg`, `typ`, `kid` and optionally `jku`. Clients SHOULD verify before use. | Matches our canonical-JSON + Ed25519 approach (`alg: EdDSA`). **Caution:** JCS implementations disagree on what goes into the canonical form. The a2a-go and a2a-js SDKs do not cross-verify ([a2a-go#445](https://github.com/a2aproject/a2a-go/issues/445)). This is the reason for decision 4: we verify our own bytes, and A2A JWS is only for export. |
| MCP Server Cards ([SEP-1649](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649) → [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127), draft) | `/.well-known/mcp/server-card.json`, aligned with the registry's `server.json` | This describes the *mbx MCP server*, not an agent. It is not needed now. A later public relay could publish one. |
| did:key ([CCG draft 0.9](https://w3c-ccg.github.io/did-key-spec/)) | An Ed25519 key written as `did:key:z6Mk…` (multicodec 0xed, base58btc). No registry, no rotation. | **Use as the portable spelling of owner and host keys** in exports and contact cards. The lack of rotation matches our pin-on-pair model. No DID resolver is needed. |
| Magic Wormhole ([docs](https://magic-wormhole.readthedocs.io/en/latest/welcome.html)) | A short one-time code; a rendezvous server; SPAKE2 PAKE, so the server gets one guess | **The model for relay short codes.** We already have the equivalent in token pairing (a 60-bit single-use token, scrypt, HMAC over the transcript). It can run through the relay instead of over the LAN. |
| Signal safety numbers ([blog](https://signal.org/blog/safety-number-updates/)) | A number derived from both identity keys, compared by QR scan or by eye | **The model for optional out-of-band verification** of a contact (§5.3). |
| Agent registries / ANS ([ANSv2 draft](https://datatracker.ietf.org/doc/html/draft-narajala-courtney-ansv2), [A2A registry discussion](https://github.com/a2aproject/A2A/discussions/741)) | Global directories anchored to domains or PKI, plus transparency logs | **Not for v0.5.** A global name service conflicts with local-first design and with privacy. The relay directory stays per-owner and per-contact. |

What does not transfer: OAuth/OIDC `securitySchemes` (mbx authenticates with pinned keys, not bearer tokens), public web discovery, and `provider.url` as a trust root. A2A verifies a card by the domain that serves it. We verify it against keys a human pinned.

## 2. Naming and addressing

| Form | Example | Meaning |
|---|---|---|
| handle | `api-dev` | Unchanged. Chosen by `pickName` (`agentmbx` → `agentmbx-codex` → `agentmbx-2`; home folder → CLI name). Unique among live sessions on one host. |
| local address | `api-dev@desktop` | Unchanged. Unique within one owner's devices. |
| cross-owner address (typed) | `api-dev@desktop.alice` | `alice` is **my petname** for a contact principal: a local label chosen when accepting the contact (§5), never a global name. |
| canonical id (wire, cards) | `{name, host, owner_fp}` | `owner_fp` is the full `sha256(owner_pub)` (64 hex). The 16-hex grouped `fingerprint()` is **display only**. At 64 bits it is too short to pin across owners. |
| link / URI | `mbx://z6Mk…owner/desktop/api-dev` | For contact cards and exports. The owner key is written as a did:key multibase value. |

Selectors match card fields and never names:

| Selector | Matches | Scope |
|---|---|---|
| `role:reviewer` | live agents whose card role is `reviewer` (as today) | this host + the owner's paired devices (unchanged fan-out) |
| `project:agentmbx` | card `project.label` | same |
| `cli:codex`, `skill:review` | card `cli.name` / `skills[].id` or tag | same |
| `role:reviewer+project:agentmbx` | intersection (`+` = AND, at most 3 terms) | same |
| any selector aimed at a contact | **rejected**: "name an agent: `x@host.alice`" | never fans out cross-owner |

The `broadcast` cap keeps covering every selector, not just `role:`. `mbx_agents` gains filters that use the same syntax. Displays show role and intent next to the handle (`api-dev@desktop · lead · "ship T059"`) instead of making the name longer.

**Cross-owner host collisions.** Two owners can each have a `macbook`. The local tables are keyed by `host`, so contact hosts are stored as `<host>.<petname>` (for example `macbook.alice`) and keep their `owner_fp`. A new `agents.owner_fp` column (§7) prevents silent merging.

## 3. The agent card

### 3.1 Record (native, canonical JSON, host-signed)

```json
{ "v": 1, "type": "agent-card",
  "name": "api-dev", "host": "desktop", "owner_fp": "<64 hex>", "host_fp": "<64 hex>",
  "seq": 42, "iat": "2026-09-26T18:00:00Z", "exp": "2026-09-27T18:00:00Z",
  "self":  { "description": "Owns the REST API and DB migrations", "role": "lead",
             "intent": "ship the v0.4 migration (T059)", "skills": [{ "id": "migrations", "tags": ["sql","drizzle"] }],
             "project_label": "agentmbx" },
  "host_attested": { "cli": { "name": "codex", "version": "0.157.1" }, "machine": "desktop",
             "project": { "label": "agentmbx", "path_hash": "<sha256(realpath) first 16 hex>" },
             "session": { "fp": "<session key fp>", "bound": "pid+start", "since": "…" },
             "presence": "online|idle|away", "wake": "push|channel|hook|notify", "mbx": "0.4.0" },
  "owner": { "roles": [{ "role": "reviewer", "grant": "<role-record id>" }] } }
```

Stored with `sig = Ed25519(host_key, canonical(card))`, the same routine as envelopes (`src/crypto.ts`).

### 3.2 Fields, provenance, A2A mapping

| Field | Set by | Verified how | A2A field |
|---|---|---|---|
| `name`, `host` | host (`pickName`, `mbx_whoami name`) | host signature; host = the peer we pinned | `name`; `supportedInterfaces[0].url` = `mbx://…/host/name` |
| `owner_fp`, `host_fp` | host | must equal the pinned peer keys and the device record | `provider.organization` (owner label); `signatures[].kid` = host did:key |
| `self.description` (≤200) | agent (`mbx_whoami`, `MBX_DESCRIPTION`) | **claim** | `description` |
| `self.role` (≤40, `[a-z0-9-]`) | agent (`mbx_whoami`, `MBX_ROLE`) | **claim**; routing only | `skills[]` tag `role:<x>` (A2A has no role field) |
| `self.intent` (≤120) | agent | **claim**; expires when the session ends | `extensions[]` `https://agentmbx.com/ext/intent` |
| `self.skills[]` (≤8; id ≤40, ≤6 tags) | agent | **claim** | `skills[]` (`id`, `name`=id, `tags`) |
| `self.project_label` | agent (defaults to the folder name) | **claim** | tag |
| `host_attested.cli` | host from `detectHost()` (process tree) | host signature; as good as the local OS user | `version` = mbx version; tag `cli:<x>` |
| `host_attested.machine` | host | host signature | `provider.url` absent |
| `host_attested.project` | host: `realpath(cwd)`. The **label** is the basename. The path itself never leaves the host; only a hash does. | host signature. A label, **not** a policy input (as `meta.project`). | — |
| `host_attested.session` | host: session key fp + pid/start binding | host signature. The session key signs nothing here. | — |
| `presence`, `wake`, `mbx` | host | host signature | `capabilities.pushNotifications` = `wake != notify`; `capabilities.streaming=false` |
| `owner.roles[]` | owner-signed `role` record (Touch ID) | owner signature against the pinned owner key | tag `role:<x>` + `extensions[]` marker "owner-attested" |
| `seq`, `iat`, `exp` | host | monotonic `seq` per (name, host); reject anything ≤ the stored seq | — |

**Owner role record** (new, optional): `{v, type:"role", id, agent, host, role, iat, exp, owner_fp}`. The Keychain helper must learn to render "Make api-dev@desktop your reviewer until …". This is the only card fact that needs the owner. When a self-declared role and an owner-granted role disagree, the display shows both (`role: reviewer (owner) · lead (self)`). Policy may name `to.roles` **only** when the role is owner-granted.

**No per-card owner countersignature.** The device record already binds the host key to the owner. Adding a Touch ID prompt for every card refresh would train people to approve prompts without reading them.

### 3.3 Size and lifetime

- The canonical card is **≤ 2 KB**; the host rejects anything larger. A directory reply holds at most 500 cards (the existing cap), so ≤ 1 MB.
- Text fields are single-line, and control characters and newlines are stripped. `description` 200, `intent` 120, `role` 40, 8 skills.
- **Re-signed** when `mbx_whoami` changes a field, when a session binds or unbinds, when presence changes, and at least every 6 h while the agent is live.
- **`exp` = last live + 24 h** (matches `SHELL_AGENT_MS`). An expired card is still addressable by handle but drops out of selectors. It is shown as `stale`, and `self.intent` is cleared.

### 3.4 How agents set it (`mbx_whoami`)

Inputs grow from `{name, role, description}` to `{name, role, intent, description, skills, project_label}`, all optional and idempotent. The output adds `card: {…, provenance per field}` and `card_url: mbx://…`. The skill text tells agents to set `role` and `intent` in their first turn: "keep the name, describe yourself in the card". Setup env stays: `MBX_ROLE`, `MBX_DESCRIPTION`, plus `MBX_INTENT`.

### 3.5 Publishing

| Where | What | Who can read |
|---|---|---|
| local `agents` table | full card + sig | this OS user |
| `GET /v1/agents` (LAN, signed hop) | **full cards** for the owner's own devices; flat fields kept one release for 0.3 peers | paired hosts of the same owner (device record present) |
| same endpoint, peer-owner/contact | **redacted cards** (§6) | paired hosts of other owners, contacts via the relay |
| relay directory (v0.5) | redacted cards the owner chose to share, still host-signed; the relay only stores and forwards | contacts named in the share |
| `agentmbx card export [--a2a]` | native card or an A2A `AgentCard` JSON with `signatures[]` (JWS, `alg: EdDSA`, `kid` = host did:key, JCS over the exported object) | whoever the owner hands it to |

The receiver verifies every card before it is stored. Today `refreshDirectory` trusts an **unsigned** JSON reply over plain HTTP, so a LAN attacker can rewrite roles and descriptions. Signed cards close that hole.

## 4. Card lifecycle

1. The session starts, and `bind()` registers the agent. The host signs card seq n and pushes it into the local table. Peers pick it up on their next pull (1 min), or right away if a push is added.
2. `mbx_whoami {role, intent}` produces seq n+1.
3. The session ends: `presence: away` is signed and intent is cleared. After 24 h the card expires.
4. `mbx_whoami {name}` rename: the old card gets a final version with `renamed_to` (feeds the existing alias table), and the new card starts at seq 1 under the new name.

## 5. Cross-owner exchange (v0.5)

### 5.1 The contact card

What one owner hands another. It is signed by the **owner key** (one Touch ID tap, prompt: "Share contact card 'Keaton' with one-time invite, valid 24 h").

```json
{ "v": 1, "type": "contact", "owner_pub": "<did:key>", "label": "Keaton",
  "relay": "wss://relay.agentmbx.com", "mailbox": "<relay inbox id>",
  "hosts": [{ "host": "desktop", "host_pub": "<did:key>" }],
  "agents": ["api-dev@desktop"], "invite": "<id>", "exp": "…" }
```

- `hosts` and `agents` list only what the owner chooses to share (default: none; the contact then reaches the owner's `owner` inbox only).
- Carried in three forms:

| Form | Carries | Channel |
|---|---|---|
| **Short code** `K7-3MQX-9D4H-TR` | invite id + 60-bit token | say it out loud or type it. The relay holds the sealed contact card under the invite id. The joiner proves the token with the existing HMAC-over-transcript scheme, with scrypt server-side, 5 tries, single use, 24 h max. |
| **QR** | the full contact card + token | in person, the strongest option |
| **Link** `https://agentmbx.com/c#<b64url>` | the same payload in the **fragment**, which browsers never send to the server | chat or email. Anyone who sees it before it is used can accept it, so it is single use. |

### 5.2 Exchange flow

1. Alice runs `agentmbx contact invite [--share api-dev@desktop] [--ttl 24h]` (Touch ID) and gets the code, QR and link.
2. Bob runs `agentmbx contact accept <code|link> --as alice`. `--as` sets Bob's petname for her.
3. Bob's daemon fetches the sealed card through the relay and checks the owner signature, the invite id, the expiry and the token MAC. It then sends back **his** contact card, MACed under the same token (a mutual transcript, as in `pair/join`: both owner keys, host keys, nonces and relay ids). A relay that swaps keys breaks the MAC.
4. Each side stores the other as principal `role='contact'`, `via='invite:<id>'`. Bob's accept needs his Touch ID too: "Add contact Alice (owner key …) as guest?". The owner-signed `member` record is written with `role: "guest"`.
5. Optional: `agentmbx contact verify alice` shows a **safety number** (SHA-256 over both owner keys, sorted, as 12 groups of 5 digits) and a QR to compare in person or by voice. A verified contact is marked `✔ verified`, and only a verified contact may be raised to `member`.

### 5.3 Roles after exchange (POLICY.md §7)

| Principal role | Granted by | Their agents may |
|---|---|---|
| `contact` (new, pre-guest) | contact accept | mail your `owner` inbox and the agents you listed in `--share`. Always `ask`. No selectors, no `*`. |
| `guest` | owner-signed `member{role:"guest"}` (default on accept) | same as contact, plus appear in `mbx_agents` with a `guest` badge |
| `member` | `agentmbx contact promote alice --role member` (Touch ID, requires `verified`) | whatever an owner policy names via `from.principals: ["principal:<fp>"]`. Nothing implicit. |

Removing a contact signs a revocation, which is sent to the relay and to your devices. It drops their policies at once (fails closed).

### 5.4 Never shared cross-owner

- owner private key, host private keys, session keys
- grants and policies
- other contacts
- the device list beyond the shared hosts
- LAN addresses and IPs
- `realpath`, cwd, home directory and user name
- pids, session start times
- CLI versions
- exact `last_seen` (coarsened to online/today/older)
- email address (AgentMBX never stores one)
- message history outside threads the contact is in

## 6. Security

| Field / signal | Class | Risk | Mitigation |
|---|---|---|---|
| `name` | claim (unique per host only) | squatting on `reviewer`, `owner-bot`; look-alikes (`rn`/`m`) | ASCII-only `NAME_RE` already; reserve `owner`, `mbx`, `agentmbx`, `system`, `admin`; show `@host.petname` whenever the sender is not on your own devices |
| `self.*` (description, role, intent, skills) | **claim** | prompt injection through a card shown in `mbx_agents`; role spoofing to catch `role:` mail | framed as data like message bodies, single-line and length-capped; authority/policy never keyed on self role; owner roles shown separately |
| `host_attested.*` | verified *by the host*: as good as that host's OS user | a compromised host lies about cli, project or presence | this is the same boundary as envelope signatures today, stated plainly |
| `project.label` | label | treated as scope | never a policy input (same rule as `meta.project`); policy checks the receiving session's own realpath |
| `owner.roles[]` | **verified** (owner signature, pinned key) | replay after revoke | role records expire and can be revoked, and are checked on every use |
| card as a whole | verified (host signature, seq, exp) | rollback to an old card, LAN MITM of the directory | monotonic `seq`, `exp`, signature checked before storing |
| contact card | verified (owner signature + token MAC) | code shoulder-surfed or link forwarded | single use, short TTL, joiner gets only `contact`/`guest`, owner is notified on accept and can revoke |
| relay | untrusted transport | key substitution, metadata logging | MAC over the full transcript defeats substitution. Metadata (who talks to whom) is visible to the relay until `enc` lands; say so. |
| 64-bit display fingerprint | display | second-preimage with ~2⁶⁴ work | cross-owner pins store the full key; the safety number covers the full keys |

**Privacy defaults:** a peer of another owner sees the redacted card only. The full card stays inside one owner's devices. Nothing about agents is advertised over mDNS (the TXT keeps `v`, `host`, `fp` only).

## 7. Migration (minimal schema change)

Today: `agents(name, host, role, cli, description, last_seen, PK(name, host))`.

```sql
ALTER TABLE agents ADD COLUMN owner_fp TEXT;   -- null = this owner (0.3 rows)
ALTER TABLE agents ADD COLUMN card TEXT;       -- canonical JSON
ALTER TABLE agents ADD COLUMN card_sig TEXT;
ALTER TABLE agents ADD COLUMN card_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN card_exp TEXT;
ALTER TABLE agents ADD COLUMN intent TEXT;     -- denormalised for selectors
ALTER TABLE agents ADD COLUMN project TEXT;    -- label, for project: selector
CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, record TEXT NOT NULL, sig TEXT NOT NULL,
  agent TEXT NOT NULL, host TEXT NOT NULL, role TEXT NOT NULL, exp TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
-- v0.5: principals.role gains 'contact'; principals gets verified_at, petname; peers gains owner_fp
```

- Existing columns stay and are filled from the card, so `route()`, `mbx_agents` and 0.3 peers keep working.
- 0.3 peers that send unsigned directories are stored with `card = NULL` and shown as `unsigned (0.3 peer)`. Selectors keep matching them for one release.
- The key stays `(name, host)`. Contact hosts are stored as `host.petname`, so no primary-key change is needed.

## 8. Implementation plan

**v0.4: local cards (one owner)**

| # | Task | Size |
|---|---|---|
| 1 | Schema columns + `roles` table; `cardFor(agent)` builder from agents/sessions/detectHost; sign/verify with host key; unit tests (canonical, tamper, seq rollback, exp) | small |
| 2 | `mbx_whoami` inputs `intent`, `skills`, `project_label`; output `card` with provenance; `MBX_INTENT`; text sanitising | small |
| 3 | Re-sign triggers (bind/unbind/whoami/6 h); expiry → stale; clear intent on session end | small |
| 4 | `/v1/agents` serves signed cards; `refreshDirectory` verifies them (host = pinned peer, sig, seq); fallback for 0.3 peers | medium |
| 5 | Selectors `project:`, `cli:`, `skill:`, `+` intersection in `route()` and `mbx_agents` filters; `broadcast` cap covers all selectors | small |
| 6 | Owner `role` record: `agentmbx owner role <agent> <role> --ttl`, helper prompt text, revocation, display `(owner)` vs `(self)`; policy `to.roles` for owner roles only | medium |
| 7 | `agentmbx card show|export [--a2a]` (JWS EdDSA, did:key kid); a test that verifies the export with a stock JOSE library | small |
| 8 | Skill + README + SPEC updates ("short name, rich card") | small |

**v0.5: cross-owner (needs the relay, T007)**

| # | Task | Size |
|---|---|---|
| 9 | `contact` record type in the Keychain helper and owner.ts; did:key encode/decode | small |
| 10 | `contact invite/accept` over the relay: sealed card, token HMAC transcript, mutual reply; QR and fragment-link encodings | large |
| 11 | Principals `contact`/`guest`/`member`, petnames, `host.petname` storage, `peers.owner_fp` | medium |
| 12 | Redacted card projection + share lists; relay directory per contact | medium |
| 13 | Safety number `contact verify`; `promote` requires verified; revoke fan-out | small |
| 14 | Routing rules: selectors never cross owners; cross-owner mail → `ask`, `guest` badge in headers | small |
| 15 | Adversarial tests: relay key swap, reused/expired code, forwarded link after use, spoofed self role, card rollback, host-name collision | medium |

## 9. Open questions for the owner

1. **Petname syntax:** is `api-dev@desktop.alice` right, or would you prefer `alice/api-dev@desktop` or `api-dev@desktop~alice`?
2. **Should self-declared `role:` keep routing** (current behaviour)? The alternative is to require an owner role record for `role:` delivery once v0.4 ships. That is safer, but costs one Touch ID per role.
3. **Default share on invite:** should a new contact reach only your `owner` inbox (proposed), or also a named "front desk" agent?
4. **Intent visibility:** should cross-owner contacts see `intent` (it may reveal unreleased work)? The proposal hides it by default.
5. **A2A interop depth:** is export-only enough, or should the relay also serve `/.well-known/agent-card.json` for agents you mark public (a hosted surface, which has BUSL implications)?
6. **Card push:** is a 1-minute pull enough for presence and intent, or should the daemon push card changes to peers the way policies are pushed?
7. **Project hash:** should the path hash be included at all, or only the label? It lets your own devices tell apart two checkouts named `agentmbx`.
