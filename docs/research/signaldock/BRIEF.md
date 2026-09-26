# SignalDock salvage: team brief

Saga **T073** "SignalDock: the commercial AgentMBX Cloud". Discovery epic **T074** (CLEO project: `~/projects/agentmbx`; run `cleo` commands from there).
Coordinator: `agentmbx@macbook` (Claude). Owner: Keaton.

## The framing (owner decision, 2026-09-26)

- **AgentMBX** (`~/projects/agentmbx`) is the standalone, open, local-first kernel and protocol: signed envelopes, owner-signed policies, device records and revocations, one daemon per host, and MCP, CLI and hooks for every agent CLI. It works with no cloud at all.
- **SignalDock** (`~/projects/signaldock`) becomes the **commercial product built on top of that protocol**. It has four parts:
  - the untrusted cloud relay, for cross-network delivery;
  - the account plane: owners, orgs, devices and billing;
  - a signed agent-card directory;
  - the owner web app (inbox, agents, policies, devices, audit), plus the marketing sites.
- **Salvage what's good:** the fast Rust/Axum backend, the working delivery pipeline (poll, SSE, webhooks, acks, dead-letter) and the design, UI and UX.
- **Drop the old authority model:** server-held authority, unscoped `sk_live_` bearer keys and unauthenticated registration. In the new model the relay never decides who may do what. Each receiver verifies owner-signed records.

## Read first

- `~/projects/agentmbx/docs/SPEC.md`, `docs/POLICY.md`, `docs/IDENTITY.md` (§0 kernel and protocol), `docs/AGENT-CARD.md`, `docs/PORTABILITY.md`.
- `~/projects/agentmbx/docs/research/IDENTITY-SOURCES.md` (SignalDock, CLEO and Better Auth ground truth).
- `~/projects/agentmbx/.cleo/council-runs/20260926T203615Z-bd8c2ac3/verdict.md` (council verdict).
- `~/projects/agentmbx/docs/research/SIGNALDOCK-SALVAGE.md`, the finished single-agent audit (235 lines, cited). Build on it and challenge it; in particular its claim that no more than 10% of the Rust backend is reusable as a relay.

## Lanes (each lane = one CLEO task under T074)

| Task | Lane | Owner | Report (in `~/projects/agentmbx/docs/research/signaldock/`) |
|---|---|---|---|
| T075 | A: Rust backend salvage | Codex | `A-backend.md` + `A-tasks.json` |
| T076 | B: Web UI / UX salvage | Kimi | `B-frontend.md` + `B-tasks.json` |
| T077 | C: Protocol and data-model mapping | Codex | `C-protocol.md` + `C-tasks.json` |
| T078 | D: Security, ops and migration | Kimi | `D-security-ops.md` + `D-tasks.json` |
| T079 | Lead synthesis and CLEO plan | Claude | `SYNTHESIS.md`, then file the epics under T073 |

Run `cleo show <task> --full` for your acceptance criteria.

**Report shape:**
- Inventory → a verdict per component (KEEP / ADAPT / DROP), with a reason and a size (small, medium or large).
- Then risks, then open owner decisions (each with 2–4 options).

**`X-tasks.json`** is a JSON array in CLEO add-batch shape:
- `type` is `epic`, or `task` nested in the epic via a `children` note in the description;
- each item has `title`, `description` and `acceptance` (an array of strings), plus a `depends` note in the description.
- The lead files these. Lanes do not run `cleo add`.

## Rules

1. **SignalDock is read-only.**
   - Don't edit, commit, push or deploy anything in `~/projects/signaldock`.
   - Build and test output under `target/` or `node_modules/` is fine.
   - Write only your report files in agentmbx `docs/research/signaldock/`.
2. **Never open, print, copy or quote secret material:**
   - `clawmsgr-*.json`, `agent-registry-report.json`, `.env*`, any `sk_live_` value, Railway or other tokens, and anything in git history that holds them.
   - You may say that a secret exists, and where. Never its value.
3. **No outward actions:** no calls that mutate the live APIs (api.signaldock.io, api.clawmsgr.com). Read-only GETs of public health or status pages are fine.
4. **Coordinate over AgentMBX:**
   - Start by setting your name with the mbx whoami tool: `sd-backend`, `sd-frontend`, `sd-protocol`, `sd-secops` or `sd-lead`.
   - Send progress and questions to `sd-lead`, cc `agentmbx`.
   - When your report is done, send `sd-lead` and `agentmbx` a short summary with the file path. Mark your CLEO task active with `cleo start <id>`, but don't complete it; the lead verifies it.
5. **Owner decisions go to `agentmbx`** (the coordinator asks Keaton). Don't block on them: record the options and continue.
