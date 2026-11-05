// @ts-check
import { run } from "kagan/process";
import { log, settings } from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import { checkCounts } from "./checks.js";

const cache = new Map();
const autoLinked = new Set();

async function gh(args) {
  const result = await run("gh", args, { timeoutMs: 30000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "GitHub lookup failed. Check gh auth status.");
  return result.stdout;
}
export async function normalizeRepo(input) {
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/.exec(input.trim());
  if (!match) throw new Error("Give a repository as owner/name or an https GitHub URL");
  return (await gh(["repo", "view", match[1], "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim();
}
export async function maybeAutoLink(projectId) {
  if (settings().autoLinkRemote !== true || autoLinked.has(projectId)) return;
  const project = await threads.project(projectId);
  const match = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(project.gitRemoteUrl ?? "");
  if (match && await store.autoLinkAllowed(projectId, match[1])) await store.linkRepo(projectId, await normalizeRepo(match[1]));
  autoLinked.add(projectId);
}
/** @param {string} projectId @param {Record<string, string>} [options] */
export async function listIssues(projectId, options = {}) {
  const repos = await store.listRepos(projectId);
  const key = JSON.stringify([repos, options]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.issues;
  const issues = [];
  const filters = [];
  for (const field of ["label", "assignee", "author"]) if (options[field]) filters.push(`--${field}`, options[field]);
  if (repos.length && options.query?.trim()) {
    const found = JSON.parse(await gh(["search", "issues", `${options.query.trim()} is:issue`, "--state", "open", ...repos.flatMap(repo => ["--repo", repo]), ...filters, "--limit", "50", "--json", "number,title,repository,url,labels,assignees,author"]));
    for (const issue of found) issues.push({ ...issue, repo: issue.repository.nameWithOwner });
  } else {
    const errors = [];
    for (const repo of repos) {
      try {
        const found = JSON.parse(await gh(["issue", "list", "--repo", repo, "--state", "open", ...filters, "--limit", "100", "--json", "number,title,url,labels,assignees,author"]));
        for (const issue of found) issues.push({ ...issue, repo });
      } catch (error) {
        errors.push(`${repo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!issues.length && errors.length) throw new Error(errors.join("\n"));
    for (const error of errors) log("warn", `Couldn't list issues: ${error}`);
  }
  cache.clear();
  cache.set(key, { at: Date.now(), issues });
  return issues;
}
/** @param {{proposed?: boolean}} [options] */
export function importIssue(projectId, repo, number, options = {}) {
  return store.serial(async () => {
    await store.ready();
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Issue number must be a positive integer");
    if (await store.issueTicket(projectId, repo, number)) throw new Error("That issue is already on this board");
    const issue = JSON.parse(await gh(["issue", "view", String(number), "--repo", repo, "--json", "title,body,url,comments"]));
    const t = await store.createTicketInner({ projectId, title: String(issue.title).slice(0, 200), description: `${issue.body ?? ""}\n\n---\nCopy of ${issue.url}. Nothing syncs back to GitHub.`, issue: { repo, number, url: issue.url }, kind: null, proposed: Boolean(options.proposed) });
    for (const comment of issue.comments ?? []) if (comment.body?.trim()) await store.addCommentInner(t.id, { body: comment.body, githubLogin: comment.author?.login ?? "unknown" });
    return t;
  });
}

const PULL_FIELDS = "number,title,url,state,isDraft,mergedAt,reviewDecision,statusCheckRollup";
const pullCache = new Map();

/** The branch the ticket's worktree uses, so a pull request can be matched to it. */
async function branchOf(ticket) {
  if (ticket.environmentId) {
    const env = await threads.environment(ticket.environmentId).catch((error) => { log("warn", `Couldn't read environment ${ticket.environmentId}: ${error}`); return null; });
    if (env?.branch) return env.branch;
  }
  return `kanban/${ticket.number}`;
}

/** Pull requests of the ticket's linked repos whose head is its branch. Read-only, through the person's gh login. */
export async function pullRequests(ticket) {
  const repos = await store.listRepos(ticket.projectId);
  if (!repos.length) return { pulls: [], error: null };
  const branch = await branchOf(ticket);
  const key = JSON.stringify([repos, branch]);
  const cached = pullCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return { pulls: cached.pulls, error: cached.error };
  const pulls = [];
  const errors = [];
  for (const repo of repos) {
    let found;
    try {
      found = JSON.parse(await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", "10", "--json", PULL_FIELDS]));
    } catch (error) {
      errors.push(`${repo}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const pull of found) pulls.push({
      repo, number: pull.number, title: pull.title, url: pull.url, state: pull.state, isDraft: Boolean(pull.isDraft),
      mergedAt: pull.mergedAt ? Date.parse(pull.mergedAt) : null, reviewDecision: pull.reviewDecision ?? "",
      checks: checkCounts(pull.statusCheckRollup),
    });
  }
  const result = { pulls, error: errors.length ? errors.join("\n") : null };
  pullCache.set(key, { ...result, at: Date.now() });
  // Keep the cache small; a long-lived board must not grow it per branch.
  while (pullCache.size > 20) pullCache.delete(pullCache.keys().next().value);
  return result;
}
