// The live agent roster behind `mbx_agents` (T496). One answer to "who can I reach, and are they really there?":
//   - state comes from verified holder process evidence, the same function a claim uses (listIdentityStatus ->
//     identityAvailability), never from last_seen;
//   - each row says its role, the harness that holds it, its projects and which projects it leads;
//   - the default view is the session's project plus the leads of other projects, plus any live or idle persona whose
//     verified session works in this folder (`seen_here`: visibility only, never a membership write, T538);
//     project "*" lists every project;
//   - retired and generated names are left out unless a session holds them (or all:true).
// Rows are built from an explicit field list. IdentityStatus carries unread and message counts; they never reach a
// roster row (T308 AC2). A row from a paired host is `remote` and unverified: its liveness is that host's to say.
import { basename } from "node:path";
import { listIdentityStatus } from "./identity-status.js";
import { activeLeads, projectLeadView } from "./lead-record.js";
import { cwdInProject } from "./probe.js";
import { AGENTS_V1_SCHEMA } from "./status-schema.js";
const STATE_ORDER = { live: 0, idle: 1, unknown: 2, offline: 3, remote: 4 };
/** held -> live, idle -> idle, unknown -> unknown; available, legacy and conflict -> offline (a conflict needs the owner). */
const stateOf = (s) => s === "held" ? "live" : s === "idle" ? "idle" : s === "unknown" ? "unknown" : "offline";
const scopeError = (project) => Object.assign(new Error(project
    ? `a session lists its own project (${project}) or "*"`
    : `this session works in no project folder (home or /): only project "*" can be listed`), { code: "PROJECT_SCOPE" });
export function buildRoster(node, o = {}) {
    const now = o.now ?? Date.now();
    if (o.ask !== undefined && o.ask !== "*" && o.ask !== o.project)
        throw scopeError(o.project);
    const everyProject = o.ask === "*";
    const status = listIdentityStatus(node.home, { now, includeRetired: true, ...(o.caller ? { caller: o.caller } : {}),
        ...(o.inspect ? { inspect: o.inspect } : {}), ...(o.processTable ? { processTable: o.processTable } : {}) });
    const directory = node.agents();
    const here = new Map(directory.filter((a) => a.host === node.host).map((a) => [a.name, a]));
    const leads = activeLeads(node, new Date(now));
    const ledBy = (name, host) => leads.filter((l) => l.agent === name && l.host === host).map((l) => l.project).sort();
    // The cwd of a holder's live session binding row, the same evidence `agentmbx probe` uses for "works in this project" (T445).
    const sessionCwd = (h) => {
        const r = node.store.db.prepare("SELECT cwd FROM sessions WHERE cli=? AND session_id=? ORDER BY updated_at DESC LIMIT 1")
            .get(h.cli, h.session_id);
        return r?.cwd ?? null;
    };
    const rows = status.identities.map((i) => {
        const a = here.get(i.name), held = i.state === "held" || i.state === "idle";
        // Visibility only (T538 stands): a live or idle holder whose verified session binding works in this folder is shown even
        // though it is not a member. Nothing is written to identity_projects, and an offline persona that once ran here is not shown.
        const seenHere = !!o.project && held && !!i.holder && !(!!o.self && o.self === i.name) && !i.projects.includes(o.project)
            && cwdInProject(sessionCwd(i.holder), o.project);
        return {
            name: i.name, host: node.host, address: `${i.name}@${node.host}`,
            state: stateOf(i.state), reason: i.reason,
            role: i.role ?? a?.role ?? null, description: i.description ?? a?.description ?? null,
            registered: i.registered, retired: i.retired,
            harness: held && i.holder ? i.holder.cli : null, cli: a?.cli ?? null,
            projects: [...i.projects].sort(), lead_of: ledBy(i.name, node.host),
            self: !!o.self && o.self === i.name, seen_here: seenHere, last_seen: a?.last_seen ?? i.last_activity,
        };
    });
    const remoteRow = (name, host, a) => ({
        name, host, address: `${name}@${host}`, state: "remote",
        reason: `listed by paired host ${host}; this host cannot verify whether it is running`,
        role: a?.role ?? null, description: a?.description ?? null, registered: null, retired: null,
        harness: null, cli: a?.cli ?? null, projects: [], lead_of: ledBy(name, host), self: false, seen_here: false, last_seen: a?.last_seen ?? null,
    });
    for (const a of directory)
        if (a.host !== node.host)
            rows.push(remoteRow(a.name, a.host, a));
    // A designated lead is always listed, even when its mailbox has no row yet or lives on a host we only know by its record.
    for (const l of leads) {
        if (rows.some((r) => r.name === l.agent && r.host === l.host))
            continue;
        if (l.host !== node.host) {
            rows.push(remoteRow(l.agent, l.host));
            continue;
        }
        rows.push({ name: l.agent, host: node.host, address: `${l.agent}@${node.host}`, state: "offline",
            reason: "designated lead; no mailbox activity recorded on this host", role: null, description: null, registered: false, retired: false,
            harness: null, cli: null, projects: [], lead_of: ledBy(l.agent, node.host), self: !!o.self && o.self === l.agent, seen_here: false, last_seen: null });
    }
    const local = (r) => r.host === node.host;
    const inScope = (r) => everyProject || r.self || r.lead_of.length > 0
        || (local(r) && !!o.project && (r.projects.includes(o.project) || r.seen_here));
    // Retired and generated names stay out unless something holds them or they are a designated lead or the caller.
    // `unknown` counts as held: a holder exists and may be live.
    const hiddenByDefault = (r) => local(r) && (r.retired === true || r.registered === false)
        && r.state !== "live" && r.state !== "idle" && r.state !== "unknown" && r.lead_of.length === 0 && !r.self;
    const scoped = rows.filter(inScope);
    const hidden = o.all ? 0 : scoped.filter(hiddenByDefault).length;
    const shown = (o.all ? scoped : scoped.filter((r) => !hiddenByDefault(r)))
        .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || Number(b.lead_of.length > 0) - Number(a.lead_of.length > 0)
        || a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
    const lead = projectLeadView(node, o.project, new Date(now));
    return {
        schema: AGENTS_V1_SCHEMA, host: node.host, observed_at: new Date(now).toISOString(),
        scope: { project: o.project ?? null, all_projects: everyProject, include_hidden: !!o.all, hidden },
        lead: lead.address && lead.exp ? { address: lead.address, exp: lead.exp } : null,
        agents: shown,
    };
}
const oneLine = (s) => s.replace(/\s+/g, " ").trim().slice(0, 200);
/** The text form `mbx_agents` prints: one line per persona, then this project's lead and what was left out. */
export function rosterText(r) {
    const lines = r.agents.map((a) => {
        const led = a.lead_of.length ? `  LEAD of ${a.lead_of.map((p) => basename(p) || p).join(", ")}` : "";
        const cli = a.harness ?? a.cli;
        return `${a.address}  ${a.state}${led}${a.self ? "  (you)" : ""}${a.seen_here ? "  seen here (not a member)" : ""}${a.role ? `  role:${a.role}` : ""}${cli ? `  (${cli})` : ""}`
            + `  last seen ${a.last_seen ?? "never"}${a.description ? `  — ${oneLine(a.description)}` : ""}`;
    });
    const leadLine = !r.scope.project ? "lead: no project" : r.lead ? `lead: ${r.lead.address} until ${r.lead.exp}` : "lead: none";
    const hidden = r.scope.hidden ? `\n${r.scope.hidden} retired or generated name(s) hidden; pass all:true to list them.` : "";
    const scope = r.scope.all_projects ? "all projects" : r.scope.project ? `project ${r.scope.project}, plus the leads of other projects` : "the leads of other projects";
    return `${lines.join("\n") || "No agents in scope."}\n${leadLine}${hidden}\n(scope: ${scope}; pass project:"*" for every project)`;
}
