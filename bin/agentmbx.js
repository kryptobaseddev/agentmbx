#!/usr/bin/env node
// AgentMBX launcher. Installed packages run the compiled dist/; a git checkout runs src/*.ts directly
// (Node >= 24 strips types), so development needs no build step.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sep } from "node:path";
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });
const dist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const src = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// A dev checkout runs src/*.ts directly (Node >= 24 strips types), so development needs no build step —
// but only when the checkout actually ships src/ and is not an installed package: the npm tarball ships
// src/ too, and Node refuses to strip types under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
const installed = fileURLToPath(import.meta.url).split(sep).includes("node_modules");
const devSrc = !!process.env.AGENTMBX_DEV && !installed && existsSync(src);
const { main } = await import(existsSync(dist) && !devSrc ? "../dist/cli.js" : "../src/cli.ts");
await main();
