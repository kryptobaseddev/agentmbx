#!/usr/bin/env node
// AgentMBX launcher. Installed packages run the compiled dist/; a git checkout runs src/*.ts directly
// (Node >= 24 strips types), so development needs no build step.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });
const dist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { main } = await import(existsSync(dist) && !process.env.AGENTMBX_DEV ? "../dist/cli.js" : "../src/cli.ts");
await main();
