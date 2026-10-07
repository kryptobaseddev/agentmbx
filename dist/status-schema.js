// mbx.status/v2 (T404): the one status model every renderer consumes — the Claude mod (band/pane) and the
// OpenCode sidebar read it through the T407 loopback endpoint, the CLI emits it (T406), and the cloud repo
// imports THIS module at a pinned tag as the contract. The daemon computes it; adapters render and hold
// zero business logic. Versioned additively: v1 renderers (statusline adapters) keep working untouched.
//
// The shape matches plugins/claude/fixtures/v2-*.json on feat/t401-claude-mod — that is the consumer
// contract. Fields the daemon cannot source honestly yet are null (cloud.account until the T402 sync
// client links an account; devices[].last_presence until presence tracking lands), never invented.
export const STATUS_V2_SCHEMA = "mbx.status/v2";
