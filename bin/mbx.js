#!/usr/bin/env node
// Launcher: Node >= 24 runs the TypeScript sources directly (type stripping), so there is no build step.
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });
const { main } = await import("../src/cli.ts");
await main();
