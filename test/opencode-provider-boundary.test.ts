import { test } from "node:test";
import assert from "node:assert/strict";
import { opencodeProviderPid } from "../src/opencode-provider.ts";

const walk = (commands: Map<number, string>, table: Map<number, { ppid: number }>, pid = 10) =>
  opencodeProviderPid(pid, table, p => commands.get(p) ?? "");

test("opencode provider walk stops at a cross-directory node or bun parent", () => {
  const table = new Map([[10, { ppid: 20 }], [20, { ppid: 30 }], [30, { ppid: 1 }]]);
  const same = new Map([
    [10, "/opt/homebrew/bin/node"],
    [20, "/opt/homebrew/bin/bun"],
    [30, "/opt/homebrew/bin/opencode"],
  ]);
  assert.equal(walk(same, table), 30);

  const cross = new Map([
    [10, "/opt/homebrew/bin/node"],
    [20, "/usr/local/bin/node"],
    [30, "/usr/local/bin/opencode"],
  ]);
  assert.equal(walk(cross, table), null);
  cross.set(20, "/usr/local/bin/bun");
  assert.equal(walk(cross, table), null);

  const win = new Map([
    [10, "/tools/a/node.exe"],
    [20, "/tools/b/bun.exe"],
    [30, "/tools/b/opencode"],
  ]);
  assert.equal(walk(win, table), null);

  const short = new Map([[10, { ppid: 20 }], [20, { ppid: 1 }]]);
  const serve = new Map([
    [10, "/opt/homebrew/bin/node"],
    [20, "/Applications/OpenCode.app/opencode"],
  ]);
  assert.equal(walk(serve, short), 20);

  // A compiled binary is recognized by the name opencode, not by being a Node runtime.
  const compiled = new Map([[10, "/tmp/build/opencode"], [20, "/usr/bin/node"]]);
  assert.equal(walk(compiled, short), 10);
});
