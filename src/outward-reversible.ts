import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { within } from "./policy.ts";

export type OutwardReversible =
  | { kind: "push"; remote: string; source: string; destination: string; noFollowTags: boolean; noSubmodules: boolean }
  | { kind: "draft-pr"; bodyFile?: string };

// shortcut: single literal commands only; expand the grammar only with matching rejection tests.
function words(command: string): string[] | null {
  if (!command || command.length > 65_536 || /[\u0000-\u001f\u007f]/.test(command)) return null;
  const out: string[] = [];
  let word = "", quote = "", started = false;
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = "";
      else {
        if (quote === '"' && /[$`\\]/.test(c)) return null;
        word += c;
      }
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === " ") {
      if (started) { out.push(word); word = ""; started = false; }
    } else {
      if (/[;&|<>$`(){}*?!\\~#\[\]]/.test(c)) return null;
      word += c; started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(word);
  return out;
}

const branch = (s: string): boolean => !!s && !s.startsWith("-") && !s.startsWith(".") && !s.endsWith(".")
  && !s.endsWith("/") && !s.includes("..") && !s.includes("//") && !s.includes("@{") && s !== "@"
  && s.split("/").every(p => !!p && !p.startsWith(".") && !p.endsWith(".lock"))
  && /^[A-Za-z0-9_./-]+$/.test(s);

export function parseOutwardReversible(command: string): OutwardReversible | null {
  const w = words(command);
  if (!w) return null;
  if (w[0] === "git" && w[1] === "push") {
    let noFollowTags = false, noSubmodules = false;
    let at = 2;
    while (w[at]?.startsWith("-")) {
      const flag = w[at++];
      if (flag === "--no-follow-tags") noFollowTags = true;
      else if (flag === "--recurse-submodules=no") noSubmodules = true;
      else if (flag !== "-u" && flag !== "--set-upstream") return null;
    }
    const [remote, ref] = w.slice(at);
    if (w.length !== at + 2 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote ?? "") || !ref) return null;
    const parts = ref.split(":");
    if (parts.length > 2) return null;
    if (parts.some(p => p.startsWith("refs/") && !p.startsWith("refs/heads/"))) return null;
    const source = parts[0].replace(/^refs\/heads\//, "");
    const destination = (parts[1] ?? source).replace(/^refs\/heads\//, "");
    if ((source !== "HEAD" && !branch(source)) || !branch(destination) || destination === "HEAD") return null;
    return { kind: "push", remote, source, destination, noFollowTags, noSubmodules };
  }
  if (w[0] !== "gh" || w[1] !== "pr" || w[2] !== "create") return null;
  let draft = false, head = false, bodyFile: string | undefined;
  const seen = new Set<string>();
  const aliases: Record<string, string> = { "-H": "--head", "-B": "--base", "-t": "--title", "-b": "--body", "-F": "--body-file" };
  for (let at = 3; at < w.length; at++) {
    const token = w[at];
    if (token === "--draft" || token === "-d") {
      if (draft) return null;
      draft = true; continue;
    }
    if (token === "--no-maintainer-edit") continue;
    const eq = token.indexOf("="), rawFlag = eq < 0 ? token : token.slice(0, eq);
    const flag = aliases[rawFlag] ?? rawFlag;
    if (!["--head", "--base", "--title", "--body", "--body-file"].includes(flag) || seen.has(flag)) return null;
    seen.add(flag);
    const value = eq < 0 ? w[++at] : token.slice(eq + 1);
    if (value === undefined || value.startsWith("-")) return null;
    if (flag === "--head") {
      const h = value.split(":");
      if (h.length > 2 || (h.length === 2 && !/^[A-Za-z0-9-]+$/.test(h[0])) || !branch(h.at(-1)!)) return null;
      head = true;
    } else if (flag === "--base" && !branch(value)) return null;
    else if (flag === "--body-file") { if (!value || value === "-") return null; bodyFile = value; }
  }
  if (seen.has("--body") && bodyFile) return null;
  return draft && head ? { kind: "draft-pr", ...(bodyFile ? { bodyFile } : {}) } : null;
}

const exec = promisify(execFile);
async function git(cwd: string, args: string[], missing = false): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 5000, maxBuffer: 65_536,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true" } });
    return stdout.trim();
  } catch (e) { return missing && (e as { code?: unknown }).code === 1 ? "" : null; }
}

/** Read-only preflight; never invoke this while holding the permission authority transaction. */
export async function checkOutwardReversible(intent: OutwardReversible, cwd: string): Promise<boolean> {
  try {
    if (["GIT_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GH_REPO", "GH_HOST"]
      .some(k => process.env[k] !== undefined)) return false;
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    if (!root) return false;
    if (intent.kind === "draft-pr") {
      if (!intent.bodyFile) return true;
      const file = await realpath(resolve(cwd, intent.bodyFile));
      return within(file, [root]) && within(file, [cwd]) && (await stat(file)).isFile();
    }
    const { remote, source, destination } = intent;
    if (await git(cwd, ["check-ref-format", `refs/heads/${destination}`]) === null) return false;
    if (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${source === "HEAD" ? "HEAD" : `refs/heads/${source}`}^{commit}`]) === null) return false;
    const keys = `^(remote\\.${remote.replace(/[.]/g, "\\.")}\\.|push\\.|url\\.|core\\.|credential\\.)`;
    const before = await git(cwd, ["config", "--get-regexp", keys], true);
    if (before === null || /^(?:url\..*\.(?:insteadof|pushinsteadof)|core\.(?:sshcommand|gitproxy)|remote\..*\.(?:vcs|receivepack|uploadpack|proxy)) /im.test(before)
      || /^credential(?:\..+)?\.helper [!\/]/im.test(before)) return false;
    const hook = await git(cwd, ["rev-parse", "--git-path", "hooks/pre-push"]);
    if (!hook) return false;
    const noHook = async () => {
      try { await stat(resolve(cwd, hook)); return false; }
      catch (e) { return (e as { code?: unknown }).code === "ENOENT"; }
    };
    if (!await noHook()) return false;
    const mirror = await git(cwd, ["config", "--type=bool", "--get", `remote.${remote}.mirror`], true);
    const tags = await git(cwd, ["config", "--type=bool", "--get", "push.followTags"], true);
    const submodules = await git(cwd, ["config", "--get", "push.recurseSubmodules"], true);
    if (mirror === null || mirror === "true" || tags === null || (tags === "true" && !intent.noFollowTags)
      || submodules === null || (submodules && !["no", "false"].includes(submodules) && !intent.noSubmodules)) return false;
    const urls = await git(cwd, ["remote", "get-url", "--push", "--all", remote]);
    if (!urls || urls.includes("\n")) return false;
    // Native Git transports only: a custom remote helper is an executable, not a repository address.
    if (!/^(?:https:\/\/|ssh:\/\/|file:\/\/|\/|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:)/.test(urls) || /[\u0000-\u0020\u007f]/.test(urls)) return false;
    const refs = await git(cwd, ["ls-remote", "--symref", "--", urls, "HEAD"]);
    const defaultBranch = refs?.match(/^ref: refs\/heads\/([^\t\n]+)\tHEAD$/m)?.[1];
    return !!defaultBranch && branch(defaultBranch) && destination !== defaultBranch
      && before === await git(cwd, ["config", "--get-regexp", keys], true) && await noHook();
  } catch { return false; }
}
