# ADR-037: Project mailbox, role personas and the CLEO project key

## Status

**Accepted decisions, proposed text.** The four decisions below are the owner's, taken on 2026-10-09 (T489). This wording is waiting for the lead's review. Implementation is tracked under T489.

## Date

2026-10-10

## Related

T489 (epic), T491 (shipped), T492, T493, T494, T495, T500; docs/IDENTITY.md §3.1–§3.3; docs/POLICY.md; docs/THREAT-MODEL.md (R9, T308 AC2); council research doc `council-lead-root-inbox-autonomy-20261009`.

## Context

The project root mailbox `agentmbx` sat unread for nine days, holding an alert and a `needs_reply` message (T491). Two facts of the code at the time combined to cause it:

1. `agentName()` defaulted a session's name to the project folder basename, so the first session started in `~/projects/agentmbx` named itself `agentmbx`, and an old Kimi session came to own the project root mailbox (T492). Current `main` calls `agentName()` only when the owner set `MBX_AGENT` (`src/mcp.ts:514`); a session without it stays unbound until it claims or registers an identity.
2. The bare project name had no meaning to routing beyond "a mailbox that may exist". The owner-designated lead is resolved only for the literal tokens `lead` and `role:lead` (`src/lead-record.ts:105`, `:116-132`). `route()` delivers any other name as an ordinary mailbox (`src/node.ts:598-625`), and the receipt reported mail for a mailbox nobody held as `offline`, with no escalation (`src/receipts.ts`).

`<project>` therefore meant two things: a default *agent* name and the *project* key that `activeLead` looks up. The question put to the council was whether the owner-designated lead should receive mail addressed to the bare project name, and by which mechanism.

## Decision

The owner adopted the following on 2026-10-09.

1. **A project mailbox.** Mail to the bare project name `<project>` is stored once, in a durable mailbox owned by the project, not by any identity. The owner-designated lead reads it while it holds a live lease; it appears as a labelled section of the lead's inbox and one ack clears it. When the lead changes, the new lead sees the unread mail with no forward. A session that is not the lead sees neither its bodies nor its counts (T308 AC2). This is a corrected form of the council's option B. Implementation: T493.
2. **No silent acceptance.** A send to `lead`, `role:lead` or `<project>` whose holder is not live returns `queued-no-holder` with a warning. Urgent mail (`alert`, `needs_reply`) escalates to the owner HUD and to doctor's stranded list. This is shipped for `lead` and `role:lead` (T491; `src/receipts.ts:70-76`); the bare project name joins it in T493. The held state comes from a short, holder-renewed lease bound to the lead name, not from the 30-day lead record, which carries no liveness.
3. **Role personas, never CLI-named, never project-only.** A mailbox is a role persona on a project, `<project>-<role>` (`agentmbx-lead`, `agentmbx-builder`, `agentmbx-reviewer`). Any harness may claim it, one at a time, and the persona keeps its mail, role and project history across harnesses. The name carries neither the CLI nor only the project. In the owner's words: "the agent inbox name is more than just the project and definitely not the cli". The bare project name is reserved for the project mailbox; register and claim refuse it, while existing mailboxes stay readable and claimable (T492). Legacy basename mailboxes migrate into the project mailbox (T494); unread mail of dead or retired mailboxes drains to it (T495).
4. **The project key is the CLEO project id.** What the project mailbox is keyed by, and what a card's `project` field carries (docs/IDENTITY.md §6), is the id in `.cleo/project-id`: a write-once, committed UUID that every checkout, clone and device of a CLEO project shares. The folder basename is a display alias only. When a folder has no CLEO project, the key falls back to the folder path (T493). Renaming or moving the folder keeps the mailbox.

The council plan's working name for the mailbox id is `@project:<key>`; the exact id format is T493's to settle and is not part of this decision.

## Rejected options

- **Lead-as-inbox: rewrite the bare project name to the lead's personal address at send time** (the pattern `resolveLeadRecipients` applies to `lead`, `src/lead-record.ts:116-132`). Rejected for four reasons.
  - The rewrite binds the mail to whoever was lead *when it was sent*. If the lead changes before the mail is read, it stays in the old lead's mailbox.
  - The signed lead record has a 30-day default TTL (180-day maximum) and no liveness (`src/lead-record.ts:11-12`). A lead whose harness crashed or filled its context stays the lead for the rest of the TTL, so the mail waits behind the owner's signature. This is the nine-day incident again, with authority attached. The flaw is already live on `lead` and `role:lead`; T491 closed the silent part of it.
  - The same send changes meaning when the record expires, is revoked, or names a remote host that leaves `approved`: it would flip between "the lead" and "whatever mailbox has that name", and the rewrite fails hard with `NO_LEAD` where a bare name never fails.
  - Combined with relaxed `outward`, a send-time sink makes the lead the single funnel for injected content.
- **A separate root inbox that the lead also receives as a copy.** Rejected: two copies mean two ack states and two owners for one item, and a lead that "also sees" another identity's mailbox puts T308 AC2 cross-identity isolation at risk. The durable box in this option is the correct part and is adopted (decision 1); the copy is dropped.
- **`role:lead` routing only.** Rejected as the sole mechanism. A generic `role:<role>` reaches only live sessions with that registered role (`src/node.ts:581-586`), so mail sent during a vacancy reaches nobody, and the bare name stays unbound, which leaves the naming collision that caused the incident. `role:lead` keeps working, but as an additional address that resolves to the lead (`src/lead-record.ts:105`), not as the project's address.
- **Default session names `<project>-<cli>`**, numbered on collision (the council's recommendation to the owner). Superseded by the owner: a harness in the name makes the address change when the harness does, and every sender and every grant that names the persona breaks. Decision 3 replaces it.
- **The folder basename as the project key.** Rejected: the same repository has a different folder name on every host and after every rename or clone; a key that follows the folder loses the mailbox when the folder moves. The CLEO id is portable and already committed.

## Consequences

- **What stays as it is.** Isolation between identities (T308 AC2), the one-hour external-content taint, owner-signed authority as the root (lead designation, policies, pairing, cross-project forward), host binding for remote leads, and irreversible `outward` (merge, release, deploy, delete, secrets, spend) are unchanged by this ADR.
- **What changes.** Routing gains a project-owned destination that is not an identity. Two meanings of `<project>` become one. `mbx_inbox` for the lead gains a labelled section. `identity prune` forwards instead of keeping mailboxes that hold unread mail. A lead may forward inside its own project without Touch ID; a cross-project forward still needs the owner signature (T495).
- **Cost.** One more mailbox kind in `src/store.ts` and `src/node.ts`, a migration for legacy basename mailboxes, and a lease on the project mailbox that the lead must keep renewing. The council made the lease renewal's cost across all six harnesses its main open risk.
- **Order.** T491 (shipped) → T492 (names) → T493 (the mailbox) → T494, T495 (migration and draining). Until T493 ships, mail to a bare project name is an ordinary mailbox send; `docs/IDENTITY.md` §3.1 marks which selectors are built and which are planned.
- **Known gap.** Today the lead record, `identity_projects` and the cross-host match key (`projectKey`, `src/registry.ts:59`, a normalised git origin) are all keyed by folder path or git origin. No code reads `.cleo/project-id` yet. T493 owns the project mailbox's key; re-keying the lead record, `identity_projects` and the cross-host match key is not assigned to a task yet.
