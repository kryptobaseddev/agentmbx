// Self-healing skill (S1): the agentmbx skill always matches the running AgentMBX with nobody managing it. Our own copy
// is refreshed; an edited copy, a removed skill and one installed with `npx skills` are left alone. The same guide is
// served over MCP as a resource and a prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runSetup, selfHealSkill, skillDest, skillFiles, skillState } from "../src/setup.ts";

const bundled = skillFiles()["SKILL.md"];
const OLD = "---\nname: agentmbx\ndescription: old\n---\n\n# AgentMBX (old)\n";
function home(t: { after: (fn: () => void) => void }) {
  const h = mkdtempSync(join(tmpdir(), "mbx-skill-"));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
}
const put = (h: string, content: string, marker?: unknown) => {
  const d = skillDest(h); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "SKILL.md"), content);
  if (marker !== undefined) writeFileSync(join(d, ".agentmbx-skill.json"), JSON.stringify(marker));
};
const skillMd = (h: string) => readFileSync(join(skillDest(h), "SKILL.md"), "utf8");
const heal = (h: string) => selfHealSkill(h, {}); // no dev guard in these cases

test("a removed skill stays removed; a copy an older AgentMBX wrote is refreshed with a marker and a backup", (t) => {
  const h = home(t);
  assert.equal(heal(h), "missing"); assert.equal(existsSync(skillDest(h)), false);
  put(h, OLD); // pre-marker copy written by an older setup
  assert.equal(skillState(h).state, "outdated");
  assert.equal(heal(h), "current");
  assert.equal(skillMd(h), bundled);
  assert.equal(readFileSync(join(skillDest(h), "SKILL.md.bak"), "utf8"), OLD);
  assert.match(readFileSync(join(skillDest(h), ".agentmbx-skill.json"), "utf8"), /"hash"/);
  assert.equal(skillState(h).state, "current"); assert.equal(heal(h), "current");
});

test("our unchanged copy from an older version refreshes; an edited one and a foreign one are left alone", async (t) => {
  const { createHash } = await import("node:crypto");
  const hash = (c: string) => createHash("sha256").update(JSON.stringify([["SKILL.md", c]])).digest("hex");
  const h1 = home(t);
  put(h1, OLD, { version: "0.5.0", hash: hash(OLD) });
  assert.equal(heal(h1), "current"); assert.equal(skillMd(h1), bundled);
  const h2 = home(t);
  put(h2, OLD + "\nmy own note\n", { version: "0.5.0", hash: hash(OLD) });
  assert.equal(skillState(h2).state, "modified");
  assert.equal(heal(h2), "modified"); assert.match(skillMd(h2), /my own note/);
  const h3 = home(t);
  put(h3, "---\nname: something-else\n---\n");
  assert.equal(heal(h3), "modified"); assert.match(skillMd(h3), /something-else/);
  // `agentmbx setup --only skill` still replaces an edited copy when asked to, and stamps the marker
  runSetup({ home: h2, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false }, { mode: "install", only: ["skill"] });
  assert.equal(skillMd(h2), bundled); assert.equal(skillState(h2).state, "current");
});

test("a skill installed with npx skills is that tool's to update; dev runs never touch the real home", (t) => {
  const h = home(t);
  put(h, OLD);
  mkdirSync(join(h, ".agents"), { recursive: true });
  writeFileSync(join(h, ".agents/.skill-lock.json"), JSON.stringify({ version: 3, skills: { agentmbx: { source: "kryptobaseddev/agentmbx", sourceType: "github" } } }));
  assert.equal(skillState(h).state, "skills-cli"); assert.match(skillState(h).detail, /npx skills update agentmbx/);
  assert.equal(heal(h), "skills-cli"); assert.equal(skillMd(h), OLD);
  const h2 = home(t);
  put(h2, OLD);
  assert.equal(selfHealSkill(h2, { AGENTMBX_DEV: "1" }), "current", "dev guard reports and does nothing");
  assert.equal(skillMd(h2), OLD);
  assert.equal(selfHealSkill(h2, { AGENTMBX_DEV: "1", AGENTMBX_SKILL_SELFHEAL: "1" }), "current");
  assert.equal(skillMd(h2), bundled);
});

test("the MCP server serves the version-matched guide as a resource and a prompt", async (t) => {
  const mhome = mkdtempSync(join(tmpdir(), "mbx-guide-"));
  const c = new Client({ name: "guide-test", version: "1" });
  t.after(async () => { await c.close(); rmSync(mhome, { recursive: true, force: true }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: mhome, MBX_CLI: "claude", MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const res = await c.listResources();
  assert.ok(res.resources.some((r) => r.uri === "mbx://guide" && r.mimeType === "text/markdown"));
  const read = await c.readResource({ uri: "mbx://guide" });
  const text = (read.contents[0] as { text: string }).text;
  assert.match(text, /^# AgentMBX/); assert.doesNotMatch(text, /^---/, "frontmatter stripped");
  // T464: the guide a session reads on startup gates mbx_inbox on holding an identity, and says what an unbound inbox returns
  const startup = text.slice(text.indexOf("## Startup and resume"), text.indexOf("If you were told you missed messages")).replace(/\s+/g, " ");
  assert.match(startup, /If it shows `"agent": null`, this session has none yet: follow its `next` field .*before any other mailbox tool\. Once it shows your identity, call `mbx_inbox`/);
  assert.doesNotMatch(startup, /, then `mbx_inbox` for pending work/);
  assert.match(text.replace(/\s+/g, " "), /`mbx_inbox` answers `\{agent: null, unbound: true, messages: \[\], next\}` instead of mail/);
  const prompts = await c.listPrompts();
  assert.ok(prompts.prompts.some((p) => p.name === "mbx_guide"));
  const p = await c.getPrompt({ name: "mbx_guide" });
  assert.equal((p.messages[0].content as { text: string }).text, text);
});

test("concurrent refreshes leave a whole skill and no temp files behind", async (t) => {
  const h = home(t);
  put(h, OLD);
  const { spawn } = await import("node:child_process");
  const script = `import { selfHealSkill } from ${JSON.stringify(join(import.meta.dirname, "../src/setup.ts"))}; selfHealSkill(${JSON.stringify(h)}, {});`;
  const runs = Array.from({ length: 6 }, () => new Promise<number>((res) => spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }).on("exit", (c) => res(c ?? 1))));
  // a reader during the race only ever sees the old or the new file
  for (let i = 0; i < 50; i++) { const c = skillMd(h); assert.ok(c === OLD || c === bundled, "never a partial file"); await new Promise((r) => setTimeout(r, 2)); }
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0, 0, 0]);
  assert.equal(skillMd(h), bundled); assert.equal(skillState(h).state, "current");
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(skillDest(h)).filter((f) => f.endsWith(".tmp")), []);
});
