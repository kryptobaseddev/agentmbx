// T525: reading a piped payload on stdin for the CLI entry points that take one (provider hooks, `statusline`, `send`).
//
// `process.stdin.isTTY` instantiates the stdin stream, and libuv then puts a pipe in non-blocking mode. A following
// `readFileSync(0)` throws EAGAIN as soon as the writer has more than the pipe buffer (64 KiB) in flight, so a large payload
// read as "" and the hook silently did nothing. Hermes's pre_llm_call payload carries the whole conversation history, which is
// past 64 KiB from the second turn on. Both helpers below leave the stdin stream alone and survive a non-blocking fd 0.
import { readSync } from "node:fs";
import { isatty } from "node:tty";
/** True when fd 0 is a terminal. Unlike `process.stdin.isTTY` this never instantiates the stdin stream (see above). */
export const stdinIsTTY = () => isatty(0);
const CHUNK_BYTES = 64 * 1024;
/** How long fd 0 may stay empty without reaching EOF before the read is given up: a writer that is merely slow keeps going. */
export const STDIN_IDLE_MS = 5_000;
/**
 * Everything on fd 0 up to EOF, decoded as UTF-8; "" when it cannot be read in full (closed fd, read error, a writer that
 * stalls for `idleMs` without closing). All or nothing: a truncated body or JSON object is never returned as if complete.
 * EAGAIN (a non-blocking pipe with nothing buffered yet) is retried in 5 ms steps. Bytes are joined before decoding so a
 * multi-byte character split across chunks survives.
 */
export function readStdin(fd = 0, idleMs = STDIN_IDLE_MS) {
    const chunks = [], buffer = Buffer.allocUnsafe(CHUNK_BYTES), sleeper = new Int32Array(new SharedArrayBuffer(4));
    let lastProgress = Date.now();
    for (;;) {
        let n;
        try {
            n = readSync(fd, buffer, 0, buffer.length, null);
        }
        catch (error) {
            const code = error.code;
            if (code === "EOF")
                break; // Windows reports the end of a pipe as an error
            if (code !== "EAGAIN" || Date.now() - lastProgress > idleMs)
                return "";
            Atomics.wait(sleeper, 0, 0, 5);
            continue;
        }
        if (n === 0)
            break;
        chunks.push(Buffer.from(buffer.subarray(0, n)));
        lastProgress = Date.now();
    }
    return Buffer.concat(chunks).toString("utf8");
}
