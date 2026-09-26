// Version and install kind. The single-executable build (scripts/build-sea.mjs) injects the version as a
// compile-time constant; unbundled (dev checkout or npm install) it is read from package.json next to src/ or dist/.
import { readFileSync } from "node:fs";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
let cached;
export function version() {
    if (typeof __AGENTMBX_VERSION__ !== "undefined")
        return __AGENTMBX_VERSION__;
    if (cached)
        return cached;
    try {
        cached = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
    }
    catch {
        cached = "0.0.0";
    }
    return cached;
}
/** sea = standalone binary (install.sh), npm = global npm install (compiled dist/), dev = git checkout running src/*.ts. */
export function installKind() {
    try {
        if (isSea())
            return "sea";
    }
    catch { /* runtime without node:sea */ }
    if (typeof __AGENTMBX_VERSION__ !== "undefined")
        return "sea";
    return import.meta.url.endsWith(".ts") ? "dev" : "npm";
}
