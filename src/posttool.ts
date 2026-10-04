// T342: post-tool hook fast-path markers. Claude's PostToolUse hook fires per tool call; the
// bundled sh wrapper (skill/scripts/claude-posttool.sh) must decide "nothing changed" without
// starting node. The daemon (and any process that mutates mailbox state) bumps a per-session
// marker on every event that could change the hook's decision — a local delivery (the unacked-id
// set grows) and a claude bind (the session→agent mapping may change). Shrinks (acks) never need a
// bump: a smaller unacked set cannot make an unseen id appear, and a skipped call is identical to
// the full path's "no new ids" silence. The full node path records the marker value it processed
// in a sibling `.last` file; the wrapper runs node only when marker ≠ last.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const posttoolDir = (home: string): string => join(home, "posttool");
export const posttoolMarkerPath = (home: string, cli: string, sessionId: string): string =>
  join(posttoolDir(home), `${cli}-${sessionId}.marker`);
export const posttoolLastPath = (home: string, cli: string, sessionId: string): string =>
  join(posttoolDir(home), `${cli}-${sessionId}.last`);

const CLI_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

let seq = 0; // monotonic per process: two bumps in the same millisecond still change the content

const writePrivate = (path: string, content: string): void => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path); // atomic on POSIX: the wrapper never reads a half-written value
};

/** Bump the fast-path marker for one bound session. No-op for ids that fail writer-side validation. */
export function bumpPostToolMarker(home: string, cli: string, sessionId: string): void {
  if (!CLI_RE.test(cli) || !SID_RE.test(sessionId)) return;
  try {
    mkdirSync(posttoolDir(home), { recursive: true, mode: 0o700 });
    writePrivate(posttoolMarkerPath(home, cli, sessionId), `${Date.now()}-${seq++}`);
  } catch { /* advisory: a missed bump only costs one node-path run, never a wrong decision */ }
}

/** Bump markers for every claude session bound to `agent` (a delivery can arrive while the agent
 *  holds several sessions; each session's hook must notice). */
export function bumpPostToolMarkersForAgent(db: DatabaseSync, home: string, agent: string): void {
  try {
    const rows = db.prepare("SELECT session_id FROM sessions WHERE agent=? AND cli='claude' AND session_id NOT LIKE 'mcp-%'")
      .all(agent) as { session_id: string }[];
    for (const row of rows) bumpPostToolMarker(home, "claude", row.session_id);
  } catch { /* advisory, same as above */ }
}

/** The marker value the full hook path last processed; the wrapper compares this against the marker. */
export function readPostToolMarker(home: string, cli: string, sessionId: string): string | null {
  try { return readFileSync(posttoolMarkerPath(home, cli, sessionId), "utf8"); } catch { return null; }
}

export function writePostToolLast(home: string, cli: string, sessionId: string, marker: string): void {
  try {
    mkdirSync(posttoolDir(home), { recursive: true, mode: 0o700 });
    writePrivate(posttoolLastPath(home, cli, sessionId), marker);
  } catch { /* advisory: a missing .last just means the next call runs the full path */ }
}

/** Daemon-tick sweep: markers outlive their sessions (release, /clear, reaper). Delete files whose
 *  session is not currently bound so stale pairs can never skip a future binding's hook. Scratch
 *  stdin files from the wrapper's fall-through are per-session too and go with them. */
export function sweepPostToolMarkers(home: string, bound: Set<string>): void {
  let files: string[];
  try { files = readdirSync(posttoolDir(home)); } catch { return; }
  for (const file of files) {
    const m = /^([a-z0-9][a-z0-9-]{0,39})-([A-Za-z0-9_-]{1,128})\.(marker|last|stdin)$/.exec(file); // .stdin: scratch files from the pre-heredoc wrapper (review medium 3); none are written anymore
    if (!m) continue;
    if (bound.has(`${m[1]}-${m[2]}`)) continue;
    try { unlinkSync(join(posttoolDir(home), file)); } catch { /* gone: fine */ }
  }
}

export const posttoolFileCount = (home: string): number => {
  try { return readdirSync(posttoolDir(home)).length; } catch { return 0; }
};
// Tests read mtimes to prove a bump actually rewrote the file.
export const posttoolMtime = (home: string, cli: string, sessionId: string): number | null => {
  try { return statSync(posttoolMarkerPath(home, cli, sessionId)).mtimeMs; } catch { return null; }
};
