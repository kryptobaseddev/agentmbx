#!/usr/bin/env node
// AgentMBX launcher. Installed packages run the compiled dist/; a git checkout runs src/*.ts directly
// (Node >= 24 strips types), so development needs no build step.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });
const dist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const src = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// A dev checkout runs src/*.ts directly (Node >= 24 strips types), so development needs no build step —
// but only when the checkout actually ships src/; an installed tree with AGENTMBX_DEV set must still run dist.
const { main } = await import(existsSync(dist) && (!process.env.AGENTMBX_DEV || !existsSync(src)) ? "../dist/cli.js" : "../src/cli.ts");
await main();
