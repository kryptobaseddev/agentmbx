// Kimi desktop (Kimi.app) discovery and control (T033). The app runs every agent conversation inside one "daimon" process
// with a private Kimi Code home, so ~/.kimi-code config never reaches it: AgentMBX installs a native Kimi plugin there
// (MCP server + hooks). The daimon serves JSON-RPC 2.0 over a loopback WebSocket (protocol "control.v1"); its URL, pid and
// bearer token are in agents/main/runner.state.json. The token grants full control of the app: it is read per use and
// never stored or logged. Conversations are addressed by conversationKey; hooks see the kernel session id.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
export const kimiDesktopDir = () => process.env.MBX_KIMI_DESKTOP_DAIMON
    || (platform() === "darwin" ? join(homedir(), "Library/Application Support/kimi-desktop/daimon-share/daimon")
        : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kimi-desktop/daimon-share/daimon"));
const alive = (pid) => { try {
    process.kill(pid, 0);
    return true;
}
catch {
    return false;
} };
/** The running desktop daimon, optionally only when it is process `pid` (the parent recorded on a session row). */
export function kimiDesktop(pid, dir = kimiDesktopDir(), isAlive = alive) {
    try {
        const ep = JSON.parse(readFileSync(join(dir, "agents/main/runner.state.json"), "utf8"))?.control?.endpoint;
        if (typeof ep?.url !== "string" || !/^ws:\/\/127\.0\.0\.1:\d+\//.test(ep.url) || !Number.isSafeInteger(ep.pid) || typeof ep.auth?.token !== "string")
            return null;
        if ((pid !== undefined && ep.pid !== pid) || !isAlive(ep.pid))
            return null;
        return { url: ep.url, token: ep.auth.token, pid: ep.pid, dir };
    }
    catch {
        return null;
    }
}
export class RpcError extends Error {
    code;
    constructor(message, code) { super(message); this.code = code; }
}
/**
 * Run JSON-RPC calls in order over one control connection. `sent` reports when the last call's frame left this process:
 * after that, a failure cannot tell whether the call ran (the wake contract's "unknown").
 */
export async function desktopRpc(d, calls, opts = {}) {
    const Ws = globalThis.WebSocket;
    if (!Ws)
        throw new Error("this Node has no WebSocket client");
    const ws = new Ws(d.url, { headers: { Authorization: `Bearer ${d.token}` } });
    return await new Promise((resolve, reject) => {
        const results = [];
        const timer = setTimeout(() => { ws.close(); reject(new Error("kimi desktop control timed out")); }, opts.timeoutMs ?? 8_000);
        const finish = (e) => { clearTimeout(timer); try {
            ws.close();
        }
        catch { /* closed */ } if (e)
            reject(e);
        else
            resolve(results); };
        const next = () => {
            const i = results.length;
            if (i === calls.length)
                return finish();
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: calls[i][0], params: calls[i][1] }));
            if (i === calls.length - 1)
                opts.sent?.();
        };
        ws.onopen = next;
        ws.onerror = () => finish(new Error("kimi desktop control connection failed"));
        ws.onmessage = (ev) => {
            let m;
            try {
                m = JSON.parse(String(ev.data));
            }
            catch {
                return;
            }
            if (m.id !== results.length + 1)
                return; // notifications and stray frames
            if (m.error)
                return finish(new RpcError(m.error.message ?? "rpc error", m.error.code ?? 0));
            results.push(m.result);
            next();
        };
    });
}
/** The desktop plugin that gives each desktop conversation the mbx MCP server and the AgentMBX hooks. */
/** `agentmbx` is the shell-quoted command that runs the CLI (setup's shJoin of its command). */
export function writeDesktopPlugin(dir, agentmbx, version) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    // Plugin MCP commands must be PATH names or plugin-relative paths: a wrapper execs the installed CLI.
    const wrapper = join(dir, "bin/agentmbx");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${agentmbx} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const hook = (event, sub) => ({ event, command: `${agentmbx} hook ${sub} --cli kimi`, timeout: 10 });
    writeFileSync(join(dir, "kimi.plugin.json"), JSON.stringify({
        name: "agentmbx", version, description: "AgentMBX mailbox: mbx MCP tools and session hooks (managed by agentmbx setup)",
        mcpServers: { mbx: { command: "./bin/agentmbx", args: ["mcp"], env: { MBX_CLI: "kimi" } } },
        hooks: [hook("SessionStart", "session-start"), hook("UserPromptSubmit", "prompt"), hook("Stop", "stop")],
    }, null, 2) + "\n");
    return dir;
}
/** Install (or update) the plugin into the running desktop app and reload its sessions. Needs the app running. */
export async function installDesktopPlugin(d, dir) {
    if (!existsSync(join(dir, "kimi.plugin.json")))
        throw new Error(`no plugin at ${dir}`);
    const [r] = await desktopRpc(d, [["kimiPlugin.installPlugin", { source: dir }]]);
    await desktopRpc(d, [["kimiPlugin.reloadActiveSessions", {}]]).catch(() => undefined); // older apps: new conversations only
    if (r?.hasErrors)
        throw new Error("the desktop app reported errors in the AgentMBX plugin");
    return { mcp: r?.mcpServerCount ?? 0, hooks: r?.hookCount ?? 0 };
}
/** Remove the plugin from the running desktop app. */
export async function removeDesktopPlugin(d) {
    await desktopRpc(d, [["kimiPlugin.removePlugin", { id: "agentmbx" }]]);
}
