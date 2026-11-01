// @ts-check
import { settings } from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import * as handoff from "./handoff.js";
import * as github from "./github.js";
import { stage } from "./model.js";

export function parse(argv) {
  const args = [];
  /** @type {Record<string, any>} */
  const flags = {};
  const values = new Set(["project", "desc", "stage", "title", "persona", "prompt", "parent", "query", "label", "assignee", "author"]);
  for (let ix = 0; ix < argv.length; ix++) {
    const arg = argv[ix];
    if (arg === "--") { args.push(...argv.slice(ix + 1)); break; }
    if (!arg.startsWith("--")) { args.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(flags, key)) throw new Error(`Repeated option ${arg}`);
    if (key === "json") flags[key] = true;
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
  if (job.command === "move") {
    if (args.length < 1 || args.length > 2) throw new Error("Usage: move <stage> [ticket]");
    const wanted = stage(args[0]);
    if (wanted === "done" && settings().agentMoveToDone !== true) throw new Error("Agents can move tickets to Done is off");
    const t = await store.resolveTicket(args[1], context);
    if (job.threadId && settings().agentAutoApproveMoves === false) { await store.proposeMove(t.id, wanted); return { proposed: true, stage: wanted }; }
    return store.moveTicket(t.id, wanted);
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
    if (!ref) throw new Error("Usage: ticket add <title>");
    return store.createTicket({ projectId: project(), title: [ref, ...rest].join(" "), description: flags.desc, stage: flags.stage, proposed: Boolean(job.threadId && settings().agentAutoApproveAdds !== true) });
  }
  if (action === "new") {
    const t = await threads.get(thread(ref));
    return store.createTicket({ projectId: projectId ?? t.projectId, title: t.title, threadId: t.id, stage: flags.stage });
  }
  if (action === "detach") return store.detach(thread(ref));
  if (action === "remove") return threads.archive(thread(ref));
  const t = await store.resolveTicket(ref, context);
  if (action === "show") return store.detail(t.id);
  if (action === "attach") return store.attach(t.id, thread(rest[0]));
  if (action === "delete") return store.deleteTicket(t.id);
  if (action === "edit") {
    if (flags.title === undefined && flags.desc === undefined) throw new Error("Supply --title or --desc");
    return store.editTicket(t.id, { title: flags.title, description: flags.desc });
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
  // Structured output preserves descriptions, comments and cross-project links for agents.
  return `${JSON.stringify(result, null, 2)}\n`;
}
