// T643: the OpenCode plugin holds an unbound session's start note, and a session counts as unbound while it has no post-tool marker
// (bindSession writes one on every bind). Fixtures whose stubbed session-start answers for a bound session use this to leave the
// marker that the real hook's bind would have written.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point MBX_HOME at `home` (a temp dir if omitted) with a post-tool marker for each OpenCode session. Returns the restore. */
export function boundAtStart(sids: readonly string[], home?: string): () => void {
  const dir = home ?? mkdtempSync(join(tmpdir(), "mbx-bound-start-"));
  mkdirSync(join(dir, "posttool"), { recursive: true });
  for (const sid of sids) writeFileSync(join(dir, "posttool", `opencode-${sid}.marker`), "bound-at-start");
  const prev = process.env.MBX_HOME;
  process.env.MBX_HOME = dir;
  return () => {
    if (prev === undefined) delete process.env.MBX_HOME; else process.env.MBX_HOME = prev;
    if (!home) rmSync(dir, { recursive: true, force: true });
  };
}
