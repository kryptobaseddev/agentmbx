// mbx.status/v2 (T404): the one status model every renderer consumes — the Claude mod (band/pane) and the
// OpenCode sidebar read it through the T407 loopback endpoint, the CLI emits it (T406), and the cloud repo
// imports THIS module at a pinned tag as the contract. The daemon computes it; adapters render and hold
// zero business logic. Versioned additively: v1 renderers (statusline adapters) keep working untouched.
//
// The shape matches plugins/claude/fixtures/v2-*.json on feat/t401-claude-mod — that is the consumer
// contract. Fields the daemon cannot source honestly yet are null (cloud.account until the T402 sync
// client links an account; devices[].last_presence until presence tracking lands), never invented.
export const STATUS_V2_SCHEMA = "mbx.status/v2";
// ---- mbx.agents/v1 (T496): the live agent roster `mbx_agents` returns ----------------------------------------------
// One row per persona. `state` comes from verified holder process evidence on this host (the same function a claim
// uses), never from last_seen; a row from a paired host is `remote` and unverified. Rows carry no unread or message
// counts (T308 AC2: no surface shows another identity's counts). Additive changes keep the schema string; a removed
// or retyped field means a new version.
export const AGENTS_V1_SCHEMA = "mbx.agents/v1";
/** live: a verified session holds it. idle: held by a shared-process conversation quiet for 10 min (claimable).
 *  unknown: a holder exists but its process could not be verified right now. offline: nothing holds it.
 *  remote: listed by a paired host; this host cannot verify it. */
export const AGENT_STATES = ["live", "idle", "unknown", "offline", "remote"];
const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v) => v === null || typeof v === "string";
const boolOrNull = (v) => v === null || typeof v === "boolean";
const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
/** Check a value against mbx.agents/v1. Returns the problems found, empty when it conforms. Extra keys are allowed
 *  (additive versioning); a missing or retyped key is not. No dependencies, so any importer can run it. */
export function validateAgentsV1(x) {
    const bad = [];
    if (!isRec(x))
        return ["not an object"];
    if (x.schema !== AGENTS_V1_SCHEMA)
        bad.push(`schema is not ${AGENTS_V1_SCHEMA}`);
    if (typeof x.host !== "string" || !x.host)
        bad.push("host is not a non-empty string");
    if (typeof x.observed_at !== "string" || Number.isNaN(Date.parse(x.observed_at)))
        bad.push("observed_at is not a timestamp");
    const s = x.scope;
    if (!isRec(s))
        bad.push("scope is not an object");
    else {
        if (!strOrNull(s.project) || s.project === undefined)
            bad.push("scope.project is not a string or null");
        if (typeof s.all_projects !== "boolean")
            bad.push("scope.all_projects is not a boolean");
        if (typeof s.include_hidden !== "boolean")
            bad.push("scope.include_hidden is not a boolean");
        if (!Number.isInteger(s.hidden) || s.hidden < 0)
            bad.push("scope.hidden is not a non-negative integer");
    }
    if (x.lead !== null && !(isRec(x.lead) && typeof x.lead.address === "string" && typeof x.lead.exp === "string"))
        bad.push("lead is not null or {address, exp}");
    if (!Array.isArray(x.agents)) {
        bad.push("agents is not an array");
        return bad;
    }
    x.agents.forEach((r, i) => {
        const at = `agents[${i}]`;
        if (!isRec(r)) {
            bad.push(`${at} is not an object`);
            return;
        }
        for (const k of ["name", "host", "address", "reason"])
            if (typeof r[k] !== "string" || !r[k])
                bad.push(`${at}.${k} is not a non-empty string`);
        if (!AGENT_STATES.includes(r.state))
            bad.push(`${at}.state is not one of ${AGENT_STATES.join("|")}`);
        for (const k of ["role", "description", "harness", "cli", "last_seen"])
            if (!strOrNull(r[k]) || r[k] === undefined)
                bad.push(`${at}.${k} is not a string or null`);
        for (const k of ["registered", "retired"])
            if (!boolOrNull(r[k]) || r[k] === undefined)
                bad.push(`${at}.${k} is not a boolean or null`);
        for (const k of ["projects", "lead_of"])
            if (!strList(r[k]))
                bad.push(`${at}.${k} is not a list of strings`);
        if (typeof r.self !== "boolean")
            bad.push(`${at}.self is not a boolean`);
        if (typeof r.seen_here !== "boolean")
            bad.push(`${at}.seen_here is not a boolean`);
        for (const k of ["task", "lane"])
            if (r[k] !== undefined && !strOrNull(r[k]))
                bad.push(`${at}.${k} is not a string or null`);
        if (r.project_keys !== undefined && !strList(r.project_keys))
            bad.push(`${at}.project_keys is not a list of strings`);
        if (r.harness !== null && r.state !== "live" && r.state !== "idle")
            bad.push(`${at}.harness is set but the persona is not live or idle`);
    });
    return bad;
}
