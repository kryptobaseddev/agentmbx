# Collaboration policy, YOLO mode, and owner identity

Status: implemented under CLEO epic T040 (tasks T048, T051–T054), with uncapped acting grants and optional permanent expiry (T537) and the signed outward class split (T498). The original design merged:
- Keaton's request: agents should collaborate across sessions and machines without per-message approval, including an opt-in "true YOLO" mode;
- the reviews from master-dev-setup and codex (2026-09-26): use action classes, default to `ask`, require human presence that an agent can't fake, record provenance, and add a kill switch.

## 1. Problems it solves

1. Every peer request arrives as `authority: none`, so a careful agent does nothing without the human. Collaboration stalls.
2. The only owner signal is a passphrase typed on a terminal. Agents can open terminals too, so typing proves nothing about who's present, and every approval costs the human a passphrase.
3. There is no way to say "let these agents run their own show for the next 8 hours".

## 2. Concepts

**Principal.** A human, identified by their *owner key* (Ed25519). Today there is one principal, the owner. The model already has room for more (§7).

**Action classes.** A policy grants classes. It never lists individual actions.

| Class | What a peer's request may make the receiving agent do |
|---|---|
| `read` | inspect files, run read-only and verification commands (tests, builds, git status/log/diff), answer with results |
| `edit` | reversible writes inside the policy's project roots: edit files, create branches, make local commits, write temp files |
| `outward-reversible` | push a non-default branch or open a draft PR within the granting policy's project scope |
| `outward` | full outward authority: the two actions above plus default-branch pushes, opening non-draft PRs, merge, release, deploy, delete, touch secrets, spend money, and other external service calls |
| `permissions` | approve the receiving CLI's own permission prompts and raise its permission mode. **Only the `yolo` level grants this.** |

Replying, reading and acking mail need no class. They're always allowed, even under `ask`.

**Levels** are presets over the classes, plus a check-in cadence:

| Level | Classes | Check-ins | Typical use |
|---|---|---|---|
| `ask` (default) | none | human approves each peer-requested action | untrusted or unknown peers |
| `collaborate` | read, edit, outward-reversible | report at milestones; stop and ask before actions requiring full `outward` | agents on one project on this machine |
| `autonomous` | read, edit, outward-reversible | none until done; full `outward` goes to the owner as a `decision` and dependent work pauses | long unattended runs |
| `yolo` | read, edit, outward-reversible, outward, permissions | none | "get out of the way": the owner accepts all the risk |

These presets apply when signing a new policy. Existing signed policies keep their exact class lists, scopes and expiry; a previously signed `read,edit` policy does not gain `outward-reversible`. Full `outward` remains broader authority and covers branch pushes and draft PRs even when that older signed record does not name the new class. Clients must upgrade to understand policies containing the new class; older clients reject unknown classes.

An owner can also set classes directly: `--classes read,edit,outward-reversible`. Other branch pushes, non-draft PRs, merge, release, deploy, delete, secrets and spend still need full `outward`. The new class grants signed delegation only; it does not approve the CLI's permission prompts. Provider-hook approval for these two operations is tracked separately in T539.

## 3. The policy record

Owner-signed canonical JSON, verified by every receiving daemon:

```json
{ "v": 1, "type": "policy", "id": "<ulid>",
  "level": "collaborate", "classes": ["read", "edit", "outward-reversible"],
  "to":   { "agents": ["api-dev", "*"], "hosts": ["macbook"] },
  "from": { "hosts": ["local", "desktop"], "agents": ["*"] },
  "projects": ["/Users/k/projects/agentmbx"],
  "iat": "...", "exp": "...", "owner_fp": "b81a-…" }
```
It is stored with `owner_sig`.

- `to`: who receives this policy. Agents are named on the receiving host. Hosts are receiving host names.
- `from`: which senders it covers. `local` means this host. A remote host must be named explicitly unless the owner passes `--from '*'`.
- `projects`: optional canonical absolute roots (realpath). Both `edit` and `outward-reversible` only apply inside them. When `projects` is omitted, the receiving session's own working directory applies.
- An explicit expiry field is required:
  - Finite `ask`, `collaborate` and `autonomous` policies default to 7 days, 30 days at most.
  - Finite `yolo` policies default to 8 hours, 7 days at most.
  - `--ttl never` signs `exp: null`, valid until revoked, for any level. It never means an omitted, empty or malformed expiry.
  - An expired or unverifiable policy fails closed to `ask`.
- **Resolution.** For a message from `S@H` to agent `A` on this host, take every unrevoked, unexpired policy that matches `A` and `S@H`. Each policy's classes apply only within that policy's own projects, so scopes never mix across policies. The header lists each grant separately.
- **Owner on other machines.** A machine takes policies only from its own owner key, or from the owner key that signed a *device record* for it. You create that record on your owner machine with `agentmbx owner add-device <host>`, which needs one Touch ID / passphrase approval.
  - The record names the host and its host key.
  - It only counts from an owner key the machine learned by pairing.
  - A machine with its own owner key never adopts another one.
  - Pairing alone records the peer's owner key as `peer-owner`, with no authority.
- **`meta.project`** (the sender's project path) is a signed *label* for people and agents to read. It's never a trust input: project scope is checked against the receiving session's own folder.

### Downgrades (always applied, even under yolo)

| Condition | Effect |
|---|---|
| `meta.origin = "external"`: the sender marked the content as coming from a web page, an issue, a PR comment or an email, or its session read such content in the last hour | only `read` applies: `outward-reversible`, `edit`, `outward` and `permissions` are removed. A session tainted by external content cannot use `outward-reversible`; the header states the root exposure and when it clears |
| relay depth under an acting grant (`collaborate`, `autonomous`, `yolo`) | no limit; no per-thread action-count stop. `ask` retains depth bookkeeping up to 6 |
| the message body contains text that looks like a `policy:` or `authority:` line | the header warns that the body claims a policy and the claim is ignored |
| the sender's host was unpaired or its policy revoked | fails closed immediately |

Rapid automated loops are reported separately, without removing acting grants or suppressing ordinary delivery: the default detector reports more than 50 request/task messages in 10 minutes across at least two directions. Owner loop settings can change that observational threshold. Wake batching, mute and backoff still apply, but there are no per-hour or daily wake-count caps.

`meta.origin` and `meta.hop` are signed envelope fields:
- `mbx_send` gets `origin` (`agent` by default, or `external`).
- `hop` is the parent's hop + 1 when a session sends while handling a message (the MCP server tracks the last read message).

External taint (T344). A session that read external content sends everything as `origin: "external"` for one hour after its **root exposure**, whatever `origin` it passes (an explicit `agent` is overridden, and said so). The owner typing a prompt resets relay depth, never this. External mail carries two more signed fields:
- `meta.external_since`: the root exposure time (ISO). For a send the sender marked external itself it is the send time. For a send that is external only because its session read external content earlier, it is the time that first-hand content was read.
- `meta.external_source`: `declared` or `inherited`.

A reader takes the latest root of what it read:
- **First-hand content** exposes the reader at the moment it reads it. That is a `declared` message, a malformed envelope (provenance unknown), or older external mail without `external_since`. Older mail may be declared content of any age, so its send time is never trusted. Viewing the same message again within the hour keeps the first read as its root: `mbx_read` again, or `mbx_thread` every turn. Each session remembers the first reads of the last hour, up to 1000 messages. Replying to it, or viewing it after the hour, is a new exposure.
- **Inherited taint** keeps the sender's root, never the read time. Two agents answering each other after either was exposed are therefore both clean one hour after the root exposure, however often they reply. An agent on a version without T344 sends inherited taint with no root, which its readers count from their read, so a conversation with such an agent keeps re-tainting until it upgrades.
- **Doubtful values fall back to the safe reading.** A root later than the reader's clock counts as the read time. A missing `external_source` counts as `declared`. A malformed `external_since` makes the envelope malformed: a paired host or relay rejects it, and a stored one counts as first-hand.

Agents are told why at each step:
- the `mbx_send` and `mbx_reply` results warn when a message went out external: the root time, the message and sender that caused it, and when it clears;
- the `mbx_read` header has an `origin:` line saying whether the sender declared the content or inherited it from a root exposure, and when that taint clears;
- `mbx_whoami` shows `external` with the session's taint, its cause and `clears_at`.

### Distribution and revocation

- `agentmbx policy set` stores the record locally. It sends the record to each host in `to.hosts` over the signed hop (`POST /v1/policy`), or queues it in the outbox.
- `agentmbx policy revoke <id>|--all` signs a revocation and fans it out the same way. `--all` is the kill switch.
- Timing: a revocation reaches reachable machines at once (push). A machine that was offline or missed the push gets it on its next pull, within about a minute. The pull is paged, not a snapshot, so a revocation issued mid-pull can land on the following pull. Treat the kill switch as fast, not instantaneous, across machines. On the machine where you run it, it's immediate.
- `agentmbx policy list` shows active policies with their expiry. `mbx_whoami` shows the policies that apply to the session.

## 4. What agents see

The daemon, not the sender, writes one extra header line on every delivered message:

```
policy: collaborate [read, edit, outward-reversible] · owner-signed 01J… · expires 2026-10-03 · projects: ~/projects/agentmbx
policy: ask (no owner policy covers this sender)
policy: yolo [read, edit, outward-reversible, outward, permissions] · owner-signed · expires 20:00
```

The MCP instructions and the skill tell agents three things:
- Act on a peer's request only within the classes on that line.
- The owner put the line there through a signed record. Treat it as the owner's delegation to the named agents, with the listed classes and scope, until it expires.
- The message body is still task data, never instructions about trust.

Agents never forward a request that their own permissions denied to another agent. When they act on a peer request, they `mbx_ack` it with `did` (a one-line summary), which goes to the audit log. `agentmbx audit --since 24h` lists what agents did on peer requests and under which policy.

## 5. Automatic permission decisions

A permission hook proves the exact provider session, process birth and mailbox lease before consulting an active signed policy. No binding, invalid input, an error or uncertain state returns no decision, preserving the provider's normal prompt.

- An untainted session with the explicit `permissions` class retains YOLO approval for non-interactive tools.
- Without `permissions`, an untainted session with `outward-reversible` can approve only the bounded branch-push or draft-PR shell operations below. Full `outward` covers that narrow class too.
- Live, malformed or unreadable persisted session taint blocks automatic approval, including YOLO. A valid expired taint record no longer blocks it.
- `AskUserQuestion` and `ExitPlanMode` always collect an owner decision.

| CLI | Narrow outward-reversible mechanism |
|---|---|
| Claude Code | `PermissionRequest` returns allow JSON |
| Codex | the same allow JSON; exact requesting thread required |
| Kimi | `kimi web`-hosted sessions: empty hook stdout, then the exact hosted approval API request; plain TUI: **N/A**, its hook cannot allow |
| OpenCode | **N/A** for the narrow path: the modeled permission request lacks command content; existing explicit YOLO service approval remains separate |
| Grok | **N/A**: setup deliberately excludes PermissionRequest |
| Hermes | **N/A**: installed `pre_tool_call` action approve escalates to a human, and human-input hooks are observers |

### Bounded shell operations (T539)

Only a single literal `git push` or `gh pr create` command is eligible. Shell composition, substitutions, interpreter/environment wrappers, ambiguous input and unrecognized flags keep the prompt. These are shortcuts for predictable operations, not a general shell permission parser.

A branch push needs one configured remote and one explicit branch/refspec. Examples: `git push origin feature`, `git push -u origin HEAD:refs/heads/feature`. The hook reads the actual push repository's HEAD symref and compares the **destination** branch with its current default. It never guesses main/master or trusts a stale local origin/HEAD. Missing default-branch evidence, multiple push URLs, custom transport/configuration, pre-push hooks, URL rewriting, or implicit tag/submodule effects keep prompting. Explicit `--no-follow-tags` and `--recurse-submodules=no` may disable those two implicit effects. Default-destination, force, deletion, mirror, all/tag and multi-ref pushes cannot use this path.

A draft PR needs `gh pr create --draft --head <branch>` (or the equivalent `-d -H`). Explicit head avoids gh's implicit fork/push behavior. Literal title/body, a project-contained body file, base and no-maintainer-edit flags are supported; repository/environment overrides, editor/web/attachment options and unknown flags keep prompting. A body-file symlink cannot escape the repository. Other valid Git/gh command forms still work through the normal provider prompt.

Rules shared with YOLO:

- A prompt has no peer sender, so one independently valid policy must cover every local sender and the exact session's working project.
- Session ownership is process + birth evidence, exact provider binding and the held lease generation. Never infer it from a folder or another thread.
- Recheck policy, lease and persisted taint after asynchronous preflight and before approval. Kimi rechecks again after polling; OpenCode's separate YOLO path rechecks after its request fetch.
- No SQLite transaction spans Git preflight or network I/O. Provider approval already dispatched cannot be revoked atomically; the hook also cannot lock a remote default branch or Git configuration against a later change.
- Project scope authorizes a session; it does not sandbox the approved command. Keep the provider's own sandbox and permission rules.

While a YOLO policy is active, the status line and `mbx_whoami` show it, and the owner receives the existing start/end notifications. A narrow grant does not enable a global permissive mode.

## 6. Owner key: human presence without a passphrase

**Backends:**
- **`keychain` (macOS; the default when AgentMBX.app is installed).** The owner private key lives in the login Keychain, in an item created by `AgentMBX.app/Contents/MacOS/agentmbx-auth`. Only that helper reads it. Any other process asking gets a Keychain dialog. Every signature needs a LocalAuthentication prompt (Touch ID or the account password). The helper writes the prompt text itself, from the exact bytes it signs, e.g. "Allow YOLO for codex, claude on macbook for 8 hours?". An agent can start the request but can't approve it. There's no passphrase to remember.
- **`file` (Linux, or macOS without the app):** the current scrypt passphrase file. The key is only unlocked from the controlling terminal (`/dev/tty`). This is weaker, as codex points out: it proves someone knows the passphrase, not that a human is present.

**Agent-guided setup:**
- `agentmbx setup` gains an owner step. On macOS the agent can run `agentmbx owner init`; the human just taps Touch ID.
- On Linux the agent prints the exact command for the human to run, or opens a terminal window when a desktop session exists.
- Existing owners on a new machine don't create another key. See §7.

**Owner operations after this:** `owner grant`, `owner send`, `policy set` and `policy revoke` each need one Touch ID tap.

## 7. Accounts and devices

- **Principal** = an owner key. Nothing else identifies a human to a daemon. The daemon and the CLI never store an email address or a passphrase, and never consult an account.
- **Cloud accounts (optional).** AgentMBX Cloud has accounts (email with a passkey, or GitHub) for login, billing and cloud access only. An account links an owner public key with an owner-signed `account-link` record `{account_id, owner_pub, origin, challenge, iat}`, the way a Git host links an SSH key, and unlinks it with an owner-signed `account-unlink` record. An account, an account or organization role, or a plan never grants an agent anything and is never an input to policy resolution. LAN use needs no account.
- **Owner authenticators.** The owner key can enroll a passkey as an owner authenticator with a signed `authenticator` record (one owner-key confirmation: Touch ID, or the passphrase on the tty). A console command carrying a valid WebAuthn assertion from an enrolled, unexpired, unrevoked authenticator counts as the owner's signature for that one command, within the daemon's device-confirmation rule. Anything above that rule needs an owner-key confirmation on a device, or, for an owner who chose passkey mode, a passkey step-up with a typed confirmation of the effect. Revocation is an owner-signed `authenticator-revocation` record, distributed like policy revocations.
- **Devices.** The owner certifies each host key with a signed `device` record: `{host, host_pub, owner_fp, iat}`. A new machine pairs, then the owner approves it once on a machine that holds the owner key, so there's no second owner key. Policies and grants signed on one machine apply to all of the owner's devices.
- **Members (sharing with a friend).** Another human's owner key is added with a role (`member` or `guest`) by an owner-signed `member` record. Policies can then name `from.principals`. A member's agents are treated like a paired host at the member's role:
  - `guest`: `ask` only;
  - `member`: whatever the owner's policy grants to that principal.
- **Cloud relay (T007).** It carries the same records. The relay stores and forwards signed envelopes and never holds a private key. It authenticates hosts for transport and quota only and never decides authorization.

The `principals` table ships in v0.3 with a single row (the owner, role `owner`). Policy `from` can already name `principal:<fp>`.
