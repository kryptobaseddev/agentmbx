# AgentMBX comparison and follow-up roadmap

## Scope

Assessed 2026-09-30 against AgentMBX main 764db004dcce11aef346fddcd7ad01ea4126ebf3 and published v0.4.1. This is documentation/source-based comparison, not competitor runtime benchmarking or a security audit. Recommendations are proposals, not implemented capabilities or owner-approved architecture decisions.

## Findings

AgentMBX is a local daemon and CLI with SQLite storage, ten MCP tools, provider adapters, setup/hooks, signed messaging and owner policy, plus a bundled workflow skill. The supplied description's nine-tool list omits mbx_identity. SQLite stores mail; session cryptography is not a storage backend. Instruction/data separation is a trust rule and does not prove prompt-injection immunity. Source owner grants support configurable duration; twelve hours should not be advertised as a universal maximum.

Agent Bus MCP is the closest functional reference. Its README documents named topics, stable peers, server-side cursors, searchable durable history and a local Web UI. It explicitly calls multi-host messaging and auth/tenancy weaker fits. Borrow resumable replay and history navigation, preserving AgentMBX lease and authority checks. Source: https://github.com/alessandrobologna/agent-bus-mcp

AgentChatBus documents a local runtime console, VS Code integration, capability declarations, rate limits and threaded collaboration. Its README describes a standards-compliant A2A gateway as future work, not an already shipped guarantee. Borrow visibility into agents, threads and failure state; avoid copying an entire coordinator into the mailbox. Source: https://github.com/Killea/AgentChatBus

A2A is an interoperability protocol for agent applications, rather than a replacement local mailbox runtime. Explore discovery/task/message mapping after AgentMBX's own protocol and signed-card work is stable; do not let external capability declarations confer local owner authority. Source: https://github.com/a2aproject/A2A

AutoGen is a framework for building multi-agent applications and now declares maintenance mode, recommending Microsoft Agent Framework. It is not a drop-in bridge between already-running CLI sessions. Source: https://github.com/microsoft/autogen

CrewAI, ApuChat and the ACP overview were not fully revalidated in this pass: their supplied documentation endpoints failed to fetch. Treat the pasted feature/security claims as unverified; do not use them as acceptance evidence. This plan does not claim an exhaustive market survey.

## Recommendations

First: T118 delivery and connector diagnostics. Distinguish installed version, daemon version and running MCP build, exact holder evidence, release/claim receipts, and queued retries. Delivered/notified/read/acked do not all mean work completed. Link protocol semantics to T064 and provider receipt validation to T091.

Second: T117 bounded replay cursors independent of ack. Resume history without rescanning the whole mailbox or accidentally marking work complete. Specify stable ordering, mailbox scope, concurrent arrivals, retention, restart and provider changes. Coordinate T064 before wire changes.

Third: T119 reproducible performance baselines. Measure query cost, process inspection, heartbeat/control polling and wake storms before selecting batching, indexes or backoff. Preserve unknown-holder protection; do not shorten lease timeout to hide missing closure evidence. Link test-loop reliability to T113.

Later: T120 local owner history/recovery view. Start read-only and local, with bounded queries and redaction. Reuse the T076 SignalDock frontend audit where applicable; that cloud audit is related work, not evidence that a local UI already exists.

Reuse existing backlog: T068 signed cards/directory for discovery; T069 role/project selectors and T084 named groups for topics; T064 versioned protocol for external interoperability. An A2A adapter remains deferred until there is a concrete consumer and stable authorization mapping. Keep CLEO as task truth rather than adding a second orchestration framework.

## Verification and limits

v0.4.1 is merged, tagged and published; all four platform release jobs passed. Published macOS signature/checksums/codesign and standalone MCP smoke checks passed. axiom-circle was recovered in its same existing Codex thread with mail preserved. T115 records commit, tests and typecheck evidence.

The main working tree was clean before publishing this research. Historical branches/worktrees and recovery bundles remain deliberately preserved; they have not been globally audited or deleted. Fedora remains offline with queued mail preserved. CLEO briefing reports missing symbol graph coverage and legacy project-identity metadata; these are not proofs of runtime malfunction and are not silently repaired here. No claim of repository-wide zero issues is made.

## Execution

T116 is the umbrella plan; T117-T120 are pending, scoped follow-ups with acceptance criteria. Start with diagnostics and cursor design; benchmark before optimization; UI follows the diagnostic contract. This document organizes research only. It does not authorize or promise implementation of every recommendation in the 0.4.1 release.