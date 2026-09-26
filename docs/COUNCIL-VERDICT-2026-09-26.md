# Council Verdict — Is the mbx v3 spec the right minimal-but-solid foundation for cross-CLI, cross-LAN agent messaging with a real trust boundary and an owner-authority master agent, and what must change before building it today?

## Phase 3 — Chairman's verdict

### Gate summary
| Advisor | G1 Rigor | G2 Evidence | G3 Frame | G4 Actionability | Weight |
|---|---|---|---|---|---|
| Contrarian       | PASS | FAIL | PASS | PASS | high |
| First Principles | PASS | PASS | PASS | PASS | full |
| Expansionist     | PASS | FAIL | PASS | PASS | high |
| Outsider         | PASS | PASS | PASS | PASS | full |
| Executor         | FAIL | PASS | PASS | PASS | high |

### Recommendation
Build v3 today, but not as written. First rewrite the trust section so that owner authority is bound to a key whose custody matches the claim, and so that the retry, pairing and labelling statements stop contradicting each other. The transport, store, envelope and wake-adapter architecture stands.

### Why this, not the alternatives
- **The architecture holds.** First Principles rebuilt it from zero (store-and-forward, host keys, SAS pairing, a human-present owner key, wake as a separate layer) and it matches the spec, 4/4. Nobody argued for going back to v2 or for adopting mbx_agent_mail. The question is therefore "what changes", not "whether".
- **Grant binding.** The convergent defect is binding the grant to a label (Contrarian, First Principles, Outsider). First Principles offered two remedies:
  1. Scope the label honestly to the host.
  2. Bind to a key whose custody matches the claim.

  Remedy 2 is chosen: the grant's subject becomes an ephemeral per-session key that exists only in the master session's MCP server memory. This removes Contrarian's co-resident-session laundering. Honest host scoping alone would leave "any process as Keaton on the MacBook" holding owner voice for 30 days. The grant also gets a short default expiry, per First Principles atom 2.
- **Retry vs. timestamp window.** Contrarian and First Principles both flagged this. The Executor's peer review correctly says the spec is silent on whether a retry re-signs, rather than definitely broken. Resolved in First Principles' favour: freshness moves to the signed hop, and envelopes dedupe on id permanently. That makes the question moot.
- **The Keychain spike.** It was contested: the Executor wants it; the Outsider's peer review found that it deletes the item before step 3 and never checks whether the key ends up in agent memory. Resolved by removing the dependency rather than testing it. The owner key becomes a passphrase-encrypted file that can be unlocked only through an interactive TTY prompt. That is identical on macOS and Linux and does not rest on unverified Keychain ACL behaviour.
- **Expansionist's ledger.** First Principles' peer review flagged that per-agent attribution was overclaimed. It is adopted at the level the design supports (host, plus session for the master) and costs only a reference format now.

### What each advisor got right (carried forward)
- **Contrarian's fatal flaw to mitigate:** any co-resident session that names itself `mac-dev` would send with a verified owner grant for up to 30 days. Contrarian's other flaw is wake loops that burn tokens with no brake.
- **First Principles' atomic truth worth protecting:** authority is only as strong as the weakest key that can exercise it. Freshness belongs on the hop, and dedupe must outlive retries.
- **Expansionist's upside to pursue (or defer):**
  - Pursue now: the `mbx:<id>@<host>` reference format.
  - Defer: signed export for CLEO, a single household owner root, and `mbx wake` as a doorbell verb.
- **Outsider's pattern flag:** the spec was written as an agent trust boundary while delivering a host trust boundary. Capabilities were labels with no enforcement.
- **Executor's action (validated or modified):** test the load-bearing trust assumption before building on it. Modified: replace the untested Keychain assumption, then prove the new trust rules with failing tests first.

### Conditions on the recommendation
Build only after these spec changes are made:
1. **Grants bind to per-session keys.** The grant's `sub` is the master session's ephemeral key fingerprint (plus a label). Every owner-authority envelope carries a session signature. Default expiry 12 h, max 7 d. The grant dies with the session.
2. **Capabilities are enforced by the receiving server.** A cap→allowed-action table; an out-of-scope message is delivered with `authority: none` plus a warning.
3. **The owner key is a passphrase-encrypted file** that unlocks only on an interactive TTY. No Keychain dependency in v1.
4. **Replay protection is permanent id dedupe.** Freshness (±5 min) is only on the signed HTTP hop headers. Retries never re-sign the envelope.
5. **The SAS covers host names, both host keys, both owner keys, and nonces.**
6. **Labels are truthful:**
   - `local (same user on this host)` vs. `verified (paired host X)`
   - "exactly-once storage, at-least-once notification"
7. **Wake brake:**
   - Only `request`, `task`, `decision` and `alert`, `needs_reply`, or `@mentions` wake an agent.
   - A cap on automatic wakes per thread per hour and per agent per day. Beyond the caps, messages are stored silently.
8. **Scope cut for today:**
   - No live v2 bridge (import only).
   - Hermes and kimi-web adapters are documented as later.
   - Claude wake is claimed only if tested for real with the channel flag.

### Next 60-minute action
Rewrite SPEC.md's trust section per conditions 1–7. Then write failing tests that must pass before any daemon code:
- a grant used by a non-master session is rejected;
- an envelope retried after 11 minutes is accepted exactly once;
- swapping an owner key changes the SAS;
- a message that exceeds its caps arrives with `authority: none`.

### Confidence
Medium-high. The architecture was independently reconstructed and all trust fixes are local. Confidence rises once the four tests pass and one real cross-machine delivery succeeds. It falls if per-process memory isolation on macOS (a same-user process reading another process's session key) proves weaker than assumed.

### Open questions for the owner
- Is a 12 h default grant lifetime (you re-grant with your passphrase each workday) acceptable, or do you want longer?
- Should owner-authority messages to Fedora agents be allowed to target any agent there, or only agents that have opted in?
