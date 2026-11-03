// @ts-check
import { settings } from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import * as handoff from "./handoff.js";
import * as github from "./github.js";
import { stage, parseKind, looksLikeUserStory, USER_STORY_WARNING, acceptanceCriteria } from "./model.js";

export function parse(argv) {
  const args = [];
  /** @type {Record<string, any>} */
  const flags = {};
  const values = new Set(["project", "desc", "stage", "title", "persona", "prompt", "parent", "query", "label", "assignee", "author", "kind", "before", "after", "by", "blocked-by", "warn-days", "wip-limit"]);
  const bools = new Set(["json", "wont-do", "top", "bottom"]);
  for (let ix = 0; ix < argv.length; ix++) {
    const arg = argv[ix];
    if (arg === "--") { args.push(...argv.slice(ix + 1)); break; }
    if (!arg.startsWith("--")) { args.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(flags, key)) throw new Error(`Repeated option ${arg}`);
    if (bools.has(key)) flags[key] = true;
    else if (values.has(key)) {
      if (argv[ix + 1] === undefined || argv[ix + 1].startsWith("--")) throw new Error(`${arg} needs a value`);
      flags[key] = argv[++ix];
    } else throw new Error(`Unknown option ${arg}`);
  }
  return { args, flags };
}

export async function execute(job) {
  const { args, flags } = parse(job.argv);
  const projectId = flags.project ?? job.projectId;
  const context = { projectId, threadId: job.threadId };
  const project = () => { if (!projectId) throw new Error("Choose --project <project-id> or run inside a project"); return projectId; };
  const thread = ref => { if (!ref && !job.threadId) throw new Error("Name a thread"); return ref ?? job.threadId; };
  if (job.command === "list") {
    return store.board([project()]);
  }
  if (job.command === "rules") {
    const id = project();
    if (flags["warn-days"] === undefined && flags["wip-limit"] === undefined) return store.boardRules(id);
    /** @type {{ageWarnDays?: number, wipLimit?: number | null}} */
    const change = {};
    if (flags["warn-days"] !== undefined) change.ageWarnDays = Number(flags["warn-days"]);
    if (flags["wip-limit"] !== undefined) change.wipLimit = flags["wip-limit"] === "off" ? null : Number(flags["wip-limit"]);
    return store.setBoardRules(id, change);
  }
  if (job.command === "move") {
    if (args.length < 1 || args.length > 2) throw new Error("Usage: move <stage> [ticket] [--wont-do]");
    const wanted = stage(args[0]);
    const resolution = flags["wont-do"] ? "wont-do" : "done";
    if (flags["wont-do"] && wanted !== "done") throw new Error("--wont-do only goes with move done");
    if (wanted === "done" && settings().agentMoveToDone !== true) throw new Error("Agents can move tickets to Done is off");
    const t = await store.resolveTicket(args[1], context);
    if (job.threadId && settings().agentAutoApproveMoves === false) {
      if (flags["wont-do"]) throw new Error("Won't do cannot be proposed while moves wait for approval. Run `kg kanban move done` and tell the person to pick Won't do when they accept.");
      await store.proposeMove(t.id, wanted);
      return { proposed: true, stage: wanted };
    }
    return store.moveTicket(t.id, wanted, resolution);
  }
  if (job.command === "repos") {
    const [action, repo, number] = args;
    if (action === "list") return store.listRepos(project());
    if (action === "issues") return github.listIssues(project(), flags);
    if (!repo) throw new Error("Name a repository");
    if (action === "link") return store.linkRepo(project(), await github.normalizeRepo(repo));
    if (action === "unlink") return store.unlinkRepo(project(), repo);
    if (action === "import") return github.importIssue(project(), await github.normalizeRepo(repo), Number(number));
    throw new Error("Usage: repos <list|link|unlink|issues|import>");
  }
  if (job.command !== "ticket") throw new Error(`Unknown command ${job.command}`);
  const [action, ref, ...rest] = args;
  if (action === "add") {
    if (!ref) throw new Error("Usage: ticket add <title> [--kind <story|bug|task>] [--blocked-by <ticket>[,<ticket>...]]");
    const kind = flags.kind === undefined ? "story" : parseKind(flags.kind);
    const blockerIds = [];
    for (const part of String(flags["blocked-by"] ?? "").split(",").map(part => part.trim()).filter(Boolean)) blockerIds.push((await store.resolveTicket(part, context)).id);
    return store.createTicket({ projectId: project(), title: [ref, ...rest].join(" "), description: flags.desc, stage: flags.stage, kind, blockerIds, proposed: Boolean(job.threadId && settings().agentAutoApproveAdds !== true) });
  }
  if (action === "new") {
    const t = await threads.get(thread(ref));
    const kind = flags.kind === undefined ? "story" : parseKind(flags.kind);
    return store.createTicket({ projectId: projectId ?? t.projectId, title: t.title, threadId: t.id, stage: flags.stage, kind });
  }
  if (action === "detach") return store.detach(thread(ref));
  if (action === "remove") {
    if (job.threadId && settings().agentAutoApproveMoves === false) throw new Error("Archiving a thread from the agent CLI needs Agents move tickets without asking you");
    return threads.archive(thread(ref));
  }
  const t = await store.resolveTicket(ref, context);
  if (action === "show") return store.detail(t.id);
  if (action === "attach") return store.attach(t.id, thread(rest[0]));
  if (action === "delete") {
    if (job.threadId && settings().agentMoveToDone !== true) throw new Error("Deleting a ticket from the agent CLI needs Agents can move to Done (archives threads)");
    return store.deleteTicket(t.id);
  }
  if (action === "edit") {
    if (flags.title === undefined && flags.desc === undefined && flags.kind === undefined) throw new Error("Supply --title, --desc, or --kind");
    return store.editTicket(t.id, { title: flags.title, description: flags.desc, kind: flags.kind === undefined ? undefined : parseKind(flags.kind, true) });
  }
  if (action === "rank") {
    const place = flags.top ? { top: true } : flags.bottom ? { bottom: true } : flags.before ? { before: (await store.resolveTicket(flags.before, context)).id } : flags.after ? { after: (await store.resolveTicket(flags.after, context)).id } : null;
    if (!place) throw new Error("Usage: ticket rank <ticket> (--top | --bottom | --before <ticket> | --after <ticket>)");
    return store.rankTicket(t.id, place);
  }
  if (action === "block" || action === "unblock") {
    const parts = String(flags.by ?? "").split(",").map(part => part.trim()).filter(Boolean);
    if (!parts.length) throw new Error(`Usage: ticket ${action} <ticket> --by <ticket>[,<ticket>...]`);
    for (const part of parts) {
      const blocker = await store.resolveTicket(part, context);
      if (action === "block") await store.blockTicket(t.id, blocker.id);
      else await store.unblockTicket(t.id, blocker.id);
    }
    return store.detail(t.id);
  }
  if (action === "comment") return store.addComment(t.id, { body: rest.join(" "), threadId: job.threadId });
  if (action === "parent") return store.setParent(t.id, rest[0] === "none" ? null : (await store.resolveTicket(rest[0], context)).id);
  if (action === "start") return handoff.startThread(t.id, flags);
  if (action === "handoff" || action === "consolidate") return handoff.startHandoff(t.id, { ...flags, sourceThreadIds: rest.length ? rest : [thread()], consolidate: action === "consolidate" });
  throw new Error(`Unknown ticket command ${action ?? ""}`);
}

export async function cli(job) {
  try {
    const result = await execute(job);
    return { exitCode: 0, stdout: format(result), stderr: "" };
  } catch (error) { return { exitCode: 1, stdout: "", stderr: String(error) }; }
}

function format(result) {
  if (result === undefined) return "Done\n";
  const value = noteTitle(result);
  const warning = value && typeof value === "object" && typeof value.warning === "string" ? value.warning : "";
  const note = value && typeof value === "object" && typeof value.note === "string" ? value.note : "";
  const lines = prose(value);
  // Structured output preserves descriptions, comments and cross-project links for agents.
  return `${JSON.stringify(value, null, 2)}\n${lines ? `${lines}\n` : ""}${note ? `${note}\n` : ""}${warning ? `${warning}\n` : ""}`;
}

function noteTitle(result) {
  if (!result || typeof result !== "object" || typeof result.title !== "string" || result.titleWarning) return result;
  if (!looksLikeUserStory(result.title)) return result;
  return { ...result, titleWarning: USER_STORY_WARNING };
}

function prose(result) {
  if (!result || typeof result !== "object" || result.number == null || !result.stage) return "";
  const lines = [];
  if (result.kind) lines.push(`Kind: ${result.kind}`);
  if (result.stage === "done" && result.resolution === "wont-do") lines.push("Won't do");
  const counted = Object.hasOwn(result, "acceptanceCriteria") ? result.acceptanceCriteria : null;
  if (counted) lines.push(`Acceptance criteria: ${counted.done} of ${counted.total} done`);
  else if (result.kind === "story" && Object.hasOwn(result, "acceptanceCriteria")) lines.push("Acceptance criteria: none");
  else if (result.kind === "story" && typeof result.description === "string") {
    const live = acceptanceCriteria(result.description);
    if (live) lines.push(`Acceptance criteria: ${live.done} of ${live.total} done`);
  }
  if (result.startProblem) lines.push(`Can't leave Backlog yet: ${result.startProblem}.`);
  if (typeof result.daysInStage === "number") {
    const where = result.stage === "in-progress" ? "In progress" : `In ${result.stage}`;
    const stale = typeof result.ageWarnDays === "number" && result.daysInStage > result.ageWarnDays;
    lines.push(`${where} for ${result.daysInStage} day${result.daysInStage === 1 ? "" : "s"}${stale ? `, past the ${result.ageWarnDays}-day warning` : ""}`);
  }
  if (result.wip) lines.push(`In progress holds ${result.wip.count} of a limit of ${result.wip.limit}${result.wip.count > result.wip.limit ? ", over the limit" : ""}`);
  if (result.titleWarning) lines.push(result.titleWarning);
  for (const blocker of result.blockedBy ?? []) if (blocker?.number != null) lines.push(`Blocked by #${blocker.number} ${blocker.title}`);
  return lines.join("\n");
}
