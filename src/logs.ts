import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";

export const MCP_ERROR_LOG_BYTES = 256 * 1024;

/** Prefix every physical line, including partial writes and multiline stacks, without changing stream callbacks. */
export function timestampDaemonOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    let lineStart = true;
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk);
      const parts: Buffer[] = [];
      for (let start = 0; start < bytes.length;) {
        if (lineStart) parts.push(Buffer.from(`${new Date().toISOString()} `));
        const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline + 1;
        parts.push(bytes.subarray(start, end)); lineStart = newline >= 0; start = end;
      }
      return write.call(stream, Buffer.concat(parts), undefined, typeof encoding === "function" ? encoding : callback);
    }) as typeof stream.write;
  }
  process.on("uncaughtException", error => { console.error(error); process.exit(1); });
}

/** Startup diagnostics must work before a store exists and must never replace the original failure. */
export function recordMcpStartupError(home: string, cli: string, error: unknown) {
  let fd: number | undefined;
  try {
    const line = `${new Date().toISOString()} ${JSON.stringify({ pid: process.pid, cli: cli.slice(0, 80),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) })}\n`;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    fd = openSync(join(home, "mcp-errors.log"), constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    if (!fstatSync(fd).isFile()) return;
    fchmodSync(fd, 0o600);
    if (fstatSync(fd).size + Buffer.byteLength(line) > MCP_ERROR_LOG_BYTES) ftruncateSync(fd, 0);
    writeSync(fd, line);
    // Concurrent appenders can cross the cap after the initial size check.
    while (fstatSync(fd).size > MCP_ERROR_LOG_BYTES) { ftruncateSync(fd, 0); writeSync(fd, line); }
  } catch { /* Unwritable diagnostics cannot mask a startup error. */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Original error wins. */ } }
}

/** Read a bounded tail; historical, malformed and future entries are not current startup failures. */
export function recentMcpStartupErrors(home: string, now = Date.now()): string[] {
  let fd: number;
  try { fd = openSync(join(home, "mcp-errors.log"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    const offset = Math.max(0, stat.size - MCP_ERROR_LOG_BYTES), bytes = Buffer.alloc(Math.min(stat.size, MCP_ERROR_LOG_BYTES));
    const read = readSync(fd, bytes, 0, bytes.length, offset);
    let content = bytes.subarray(0, read).toString("utf8");
    if (offset) content = content.slice(content.indexOf("\n") + 1);
    return content.split("\n").flatMap(line => {
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.+)$/.exec(line);
      if (!match) return [];
      const at = Date.parse(match[1]);
      if (!Number.isFinite(at) || new Date(at).toISOString() !== match[1] || at < now - 24 * 3600_000 || at > now) return [];
      try {
        const entry = JSON.parse(match[2]);
        return Number.isSafeInteger(entry.pid) && entry.pid > 0 && typeof entry.cli === "string" && entry.cli.length <= 80
          && typeof entry.error === "string" && entry.error.length <= 2048 ? [{ at, line }] : [];
      } catch { return []; }
    }).sort((a, b) => a.at - b.at).slice(-5).map(entry => entry.line);
  } finally { closeSync(fd); }
}
