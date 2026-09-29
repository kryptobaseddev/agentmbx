// Adapter boundary registry (T067): node core asks here whether a kimi session is hosted by a kimi web
// server; the kimi-web adapter registers the real check when it is loaded. Deny by default so core never
// needs the adapter, and tests that load the adapter (directly or via wake.ts) get real behavior.
let check = () => false;
export const setKimiHostedCheck = (fn) => { check = fn; };
export const kimiHostedCheck = (pid) => check(pid);
