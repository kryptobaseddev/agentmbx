import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEVEL_MAX_HOP } from "../src/policy.ts";

test("the skill relay-depth limits agree with policy enforcement", () => {
  const skill = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  const limits = Object.entries(LEVEL_MAX_HOP)
    .map(([level, limit]) => `${level} ${Number.isFinite(limit) ? limit : "no limit"}`).join(", ");
  assert.ok(skill.includes(`(${limits}; the policy line shows it).`), `skill must document: ${limits}`);
});
