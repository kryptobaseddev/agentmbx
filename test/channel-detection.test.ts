import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMbxChannel } from "../src/mcp.ts";

for (const flag of ["--channels", "--dangerously-load-development-channels"]) {
  test(`${flag}: exact mbx server, multiple entries and equals syntax`, () => {
    assert.ok(hasMbxChannel(`claude ${flag} server:mbx`));
    assert.ok(hasMbxChannel(`claude ${flag} plugin:other@market server:mbx server:another -- prompt`));
    assert.ok(hasMbxChannel(`claude ${flag}=server:mbx -- prompt`));
    assert.ok(hasMbxChannel(`claude ${flag}=server:other server:mbx`));
    assert.equal(hasMbxChannel(`claude ${flag} server:mbx-other`), false);
    assert.equal(hasMbxChannel(`claude ${flag} server:notmbx`), false);
    assert.equal(hasMbxChannel(`claude ${flag} plugin:mbx@market`), false);
    assert.equal(hasMbxChannel(`claude -- ${flag} server:mbx`), false);
    assert.equal(hasMbxChannel(`claude ${flag} server:other -- server:mbx`), false);
    assert.equal(hasMbxChannel(`claude ${flag} server:other --model sonnet server:mbx`), false);
  });
}
test("only full channel flag names count", () => {
  for (const args of ["claude development-channels server:mbx", "claude --no-channels server:mbx", "claude --channels-other server:mbx", "claude server:mbx", "claude --channels"])
    assert.equal(hasMbxChannel(args), false);
});
