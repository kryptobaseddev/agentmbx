// T525: reading a large piped payload on stdin. `process.stdin.isTTY` puts a pipe into non-blocking mode and a following
// `readFileSync(0)` then throws EAGAIN above the 64 KiB pipe buffer, so Hermes's conversation-sized hook payloads read as "".
// Each case runs the helper in a child process whose stdin is a pipe written asynchronously, the way Hermes's Python
// `subprocess.communicate()` writes it; the in-process `spawnSync(input)` the older hook tests use hides the failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STDIN_TS = pathToFileURL(resolve("src/stdin.ts")).href;

type Mode = "helper" | "touch-first" | "touch-first-short-idle";
const SCRIPTS: Record<Mode, string> = {
  helper: `import { readStdin, stdinIsTTY } from ${JSON.stringify(STDIN_TS)};
    const tty = stdinIsTTY(); const body = readStdin(); console.log(JSON.stringify({ tty, length: body.length, tail: body.slice(-3) }));`,
  // The exact shape that failed: the stdin stream is instantiated first (what `process.stdin.isTTY` does), then fd 0 is read.
  "touch-first": `import { readStdin } from ${JSON.stringify(STDIN_TS)};
    const tty = process.stdin.isTTY; const body = readStdin(); console.log(JSON.stringify({ tty: !!tty, length: body.length, tail: body.slice(-3) }));`,
  "touch-first-short-idle": `import { readStdin } from ${JSON.stringify(STDIN_TS)};
    const tty = process.stdin.isTTY; const started = Date.now(); const body = readStdin(0, 300);
    console.log(JSON.stringify({ tty: !!tty, length: body.length, waited: Date.now() - started }));`,
};

/** Run a child that reads stdin; `feed` writes to its stdin pipe and returns when the child's input should end (or never ends it). */
function run(mode: Mode, feed: (stdin: NodeJS.WritableStream) => Promise<"end" | "hold">): Promise<{ tty: boolean; length: number; tail?: string; waited?: number }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", SCRIPTS[mode]], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => (out += d)); child.stderr.on("data", d => (err += d));
    child.stdin.on("error", () => {}); // a child that stops reading early must not crash the test
    const timer = setTimeout(() => { child.kill(); fail(new Error(`child did not finish: ${err}`)); }, 20_000);
    child.on("close", code => { clearTimeout(timer); if (code !== 0) return fail(new Error(`exit ${code}: ${err}`)); done(JSON.parse(out)); });
    feed(child.stdin).then(how => { if (how === "end") child.stdin.end(); }, fail);
  });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

for (const size of [1_000, 65_536, 70_000, 300_000, 2_000_000]) for (const mode of ["helper", "touch-first"] as const)
  test(`stdin: a ${size} B payload arrives whole (${mode})`, async () => {
    const payload = "a".repeat(size - 3) + "xyz";
    const r = await run(mode, async stdin => { stdin.write(payload); return "end"; });
    assert.deepEqual([r.tty, r.length, r.tail], [false, size, "xyz"]);
  });

test("stdin: multi-byte characters survive being split across read chunks", async () => {
  const text = "é".repeat(100_000) + "日本語"; // 2 and 3 byte characters straddle every 64 KiB boundary
  const r = await run("touch-first", async stdin => { stdin.write(text); return "end"; });
  assert.deepEqual([r.length, r.tail], [text.length, "日本語"]);
});

test("stdin: a writer that is slower than the reader is waited for (EAGAIN is retried, not read as empty)", async () => {
  const head = "h".repeat(100_000), tail = "t".repeat(100_000 - 3) + "end";
  const r = await run("touch-first", async stdin => { stdin.write(head); await sleep(300); stdin.write(tail); return "end"; });
  assert.equal(r.length, 200_000); assert.equal(r.tail, "end");
});

test("stdin: nothing written and the pipe closed is the empty string", async () => {
  const r = await run("touch-first", async () => "end");
  assert.deepEqual([r.tty, r.length], [false, 0]);
});

test("stdin: a writer that stalls without closing gives \"\" after the idle limit, never a truncated payload", async () => {
  const r = await run("touch-first-short-idle", async stdin => {
    stdin.write("{\"partial\":"); // no EOF follows: the child must give up on its own, then the pipe is closed below
    await sleep(2_500); return "end";
  });
  assert.equal(r.length, 0, "an incomplete payload is dropped whole");
  assert.ok(r.waited! >= 250 && r.waited! < 2_400, `gave up after the idle limit (${r.waited} ms)`);
});
