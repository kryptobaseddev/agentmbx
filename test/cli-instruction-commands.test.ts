// T638: the MCP instructions name CLI verbs. `agentmbx reply` is not a command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { INSTRUCTIONS } from "../src/mcp.ts";

const named = (text: string): string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_])agentmbx ([a-z][a-z0-9-]*)((?:\/[a-z][a-z0-9-]*)*)/g)) {
    found.add(match[1]);
    for (const part of match[2].split("/")) if (part) found.add(part);
  }
  return [...found];
};

test("every agentmbx subcommand named in the MCP instructions exists in the CLI (T638)", () => {
  const help = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), "help"], {
    encoding: "utf8", env: { ...process.env, AGENTMBX_DEV: "1" },
  });
  assert.equal(help.status, 0, help.stderr);
  const commands = new Set([...help.stdout.matchAll(/(?:^|\s)agentmbx ([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  assert.ok(commands.has("send") && commands.has("inbox") && commands.has("mcp"));
  assert.equal(commands.has("reply"), false);

  const names = named(INSTRUCTIONS);
  assert.deepEqual(names.filter((name) => !commands.has(name)), []);
  for (const name of ["inbox", "read", "ack", "send"]) assert.ok(names.includes(name), name);
  assert.equal(names.includes("reply"), false);
  assert.match(INSTRUCTIONS, /send --reply-to/);

  const skill = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  for (const text of [INSTRUCTIONS, skill, source]) {
    assert.doesNotMatch(text, /inbox\/read\/reply/);
    assert.doesNotMatch(text, /agentmbx reply\b/);
  }
  assert.match(skill, /inbox\/read\/ack\/send --as/);
  assert.match(skill, /send --reply-to/);
});
