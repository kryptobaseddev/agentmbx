import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { basename } from "node:path";
import { agentName } from "../src/mcp.ts";

function withAgent(value: string | undefined, fn: () => void): void {
  const previous = process.env.MBX_AGENT;
  if (value === undefined) delete process.env.MBX_AGENT;
  else process.env.MBX_AGENT = value;
  try { fn(); }
  finally {
    if (previous === undefined) delete process.env.MBX_AGENT;
    else process.env.MBX_AGENT = previous;
  }
}

test("T329 home and root do not invent a harness name", () => {
  withAgent(undefined, () => {
    assert.equal(agentName(homedir()), null);
    assert.equal(agentName("/"), null);
    assert.notEqual(agentName(homedir()), "grok");
    assert.notEqual(agentName(homedir()), basename(homedir()).toLowerCase());
  });
});

test("T329 a project folder is the project name", () => {
  withAgent(undefined, () => {
    assert.equal(agentName("/tmp/agentmbx-proj"), "agentmbx-proj");
  });
});

test("T329 MBX_AGENT keeps an existing harness-named mailbox", () => {
  withAgent("grok", () => {
    assert.equal(agentName(homedir()), "grok");
    assert.equal(agentName("/tmp/agentmbx-proj"), "grok");
  });
  withAgent("agentmbx-grok", () => {
    assert.equal(agentName(homedir()), "agentmbx-grok");
  });
});
