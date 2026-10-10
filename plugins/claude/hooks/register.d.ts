// Types for the Claude mod hooks module (plugins/claude/hooks/register.js). The module stays
// pure JS for the mods sandbox (no build step inside the plugin); this declaration file mirrors
// its JSDoc so `tsc --noEmit` types the tests. Keep it in sync with the JSDoc signatures.
export function resolveSessionId(env: Record<string, string | undefined>): string | null;
export function statusRequestUrl(sessionId: string): string;
export function renderStatus(sessionId: string | null, snapshot: unknown): string;
export function statusLineText(snapshot: unknown): string | null;
export function bandText(sessionId: string | null, snapshot: unknown): string;
export function renderSections(snapshot: unknown): string[] | null;
export function currentSnapshot(sessionId: string | null): unknown;
export function readStatus(opts: {
  sessionId: string | null;
  fetchImpl?: (url: string) => Promise<{ ok?: boolean; status?: number; text?: unknown }>;
}): Promise<{ text: string; snapshot: unknown; raw: string | null }>;
export function statusText(
  env: Record<string, string | undefined>,
  deps?: {
    fetchImpl?: (url: string) => Promise<{ ok?: boolean; status?: number; text?: unknown }>;
    now?: number;
  },
): Promise<string>;
export function loadStatus($: {
  session?: { id: () => Promise<unknown> };
  env: { get: (name: string) => Promise<unknown> };
  clock: { now: () => Promise<number> };
  http: { fetch: (url: string) => Promise<{ ok?: boolean; status?: number; text?: unknown }> };
}): Promise<{ band: string; sections: string[]; snapshot: unknown }>;
export function resetStatusCache(): void;
export function resetStatusState(): void;
export function register(on: (event: string, matcherOrHook: unknown, hook?: unknown) => unknown): void;
