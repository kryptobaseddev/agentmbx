// mbx.status/v2 — the single status contract (saga T396, task T404).
//
// ONE model, computed ONCE by the daemon (T405 wires src/hud.ts to emit it), rendered by N thin
// adapters: statusline adapters (v1-compatible lines), the OpenCode 2 sidebar plugin (T399), the
// Claude Mod (T401) and the MBX cloud console (T402 imports this module at its pinned tag).
//
// Hard rules encoded here (lead, 2026-10-05):
//  - T308-AC2: a field scoped to a session can NEVER surface another identity's data; unresolved
//    means unbound/unknown, never a guess (no shared-directory fallback).
//  - v1 back-compat: every v1 field maps forward unchanged; v1 .line renderers keep working.
//  - T313: renderers do ONE file read per render; no SQL in any render path — only the daemon
//    computes, adapters import these types and render.
//  - T366: alert-only surfaces render empty when there is nothing to show.
//  - T393: the project section carries the owner-signed project-lead record.
export const STATUS_SCHEMA = "mbx.status/v2";
