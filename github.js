// @ts-check
import { run } from "kagan/process";
import { settings } from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import { query } from "kagan/database";

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
    const found = JSON.parse(await gh(["search", "issues", options.query.trim(), "--state", "open", ...repos.flatMap(repo => ["--repo", repo]), ...filters, "--limit", "50", "--json", "number,title,repository,url,labels,assignees,author"]));
    for (const issue of found) issues.push({ ...issue, repo: issue.repository.nameWithOwner });
  } else for (const repo of repos) {
    const found = JSON.parse(await gh(["issue", "list", "--repo", repo, "--state", "open", ...filters, "--limit", "100", "--json", "number,title,url,labels,assignees,author"]));
    for (const issue of found) issues.push({ ...issue, repo });
  }
  cache.clear();
  cache.set(key, { at: Date.now(), issues });
  return issues;
}
export function importIssue(projectId, repo, number) {
  return store.serial(async () => {
    await store.ready();
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Issue number must be a positive integer");
    if ((await query("SELECT id FROM ticket WHERE project_id = ? AND issue_repo = ? COLLATE NOCASE AND issue_number = ?", [projectId, repo, number])).length) throw new Error("That issue is already on this board");
    const issue = JSON.parse(await gh(["issue", "view", String(number), "--repo", repo, "--json", "title,body,url,comments"]));
    const t = await store.createTicketInner({ projectId, title: String(issue.title).slice(0, 200), description: `${issue.body ?? ""}\n\n---\nCopy of ${issue.url}. Nothing syncs back to GitHub.`, issue: { repo, number, url: issue.url } });
    for (const comment of issue.comments ?? []) if (comment.body?.trim()) await store.addCommentInner(t.id, { body: comment.body, githubLogin: comment.author?.login ?? "unknown" });
    return t;
  });
}
