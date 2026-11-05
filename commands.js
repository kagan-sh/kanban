// @ts-check
import { parseKind } from "./rules.js";
import { settings } from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import * as boardData from "./board-data.js";
import * as handoff from "./handoff.js";
import * as github from "./github.js";
import { stage } from "./model.js";

const blockerRefs = (value) => String(value ?? "").split(",").map(part => part.trim()).filter(Boolean);

async function resolveAll(value, context) {
  const ids = [];
  for (const part of blockerRefs(value)) ids.push((await store.resolveTicket(part, context)).id);
  return ids;
}

export async function listCommand(_job, ctx) {
  return boardData.board([ctx.project()]);
}

export async function rulesCommand(_job, ctx) {
  const id = ctx.project();
  if (ctx.flags["warn-days"] === undefined && ctx.flags["wip-limit"] === undefined) return store.boardRules(id);
  /** @type {{ageWarnDays?: number, wipLimit?: number | null}} */
  const change = {};
  if (ctx.flags["warn-days"] !== undefined) change.ageWarnDays = Number(ctx.flags["warn-days"]);
  if (ctx.flags["wip-limit"] !== undefined) change.wipLimit = ctx.flags["wip-limit"] === "off" ? null : Number(ctx.flags["wip-limit"]);
  return store.setBoardRules(id, change);
}

export async function moveCommand(job, ctx) {
  if (ctx.args.length < 1 || ctx.args.length > 2) throw new Error("Usage: move <stage> [ticket] [--wont-do]");
  const wanted = stage(ctx.args[0]);
  const resolution = ctx.flags["wont-do"] ? "wont-do" : "done";
  if (ctx.flags["wont-do"] && wanted !== "done") throw new Error("--wont-do only goes with move done");
  if (wanted === "done" && settings().agentMoveToDone !== true) throw new Error("Agents can move tickets to Done is off");
  const t = await store.resolveTicket(ctx.args[1], ctx.ticketContext);
  if (job.threadId && settings().agentAutoApproveMoves === false) {
    if (ctx.flags["wont-do"]) throw new Error("Won't do cannot be proposed while moves wait for approval. Run `kg kanban move done` and tell the person to pick Won't do when they accept.");
    await store.proposeMove(t.id, wanted);
    return { proposed: true, stage: wanted, id: t.id, number: t.number, title: t.title, note: `Proposed moving #${t.number} ${t.title} to ${wanted}. The person accepts it on the board.` };
  }
  return store.moveTicket(t.id, wanted, resolution);
}

export async function reposCommand(job, ctx) {
  const [action, repo, number] = ctx.args;
  if (action === "list") return store.listRepos(ctx.project());
  if (action === "issues") return github.listIssues(ctx.project(), ctx.flags);
  if (!repo) throw new Error("Name a repository");
  if (action === "link") return store.linkRepo(ctx.project(), await github.normalizeRepo(repo));
  if (action === "unlink") return store.unlinkRepo(ctx.project(), repo);
  if (action === "import") return github.importIssue(ctx.project(), await github.normalizeRepo(repo), Number(number), { proposed: Boolean(job.threadId && settings().agentAutoApproveAdds !== true) });
  throw new Error("Usage: repos <list|link|unlink|issues|import>");
}

export async function ticketCommand(job, ctx) {
  const [action, ref, ...rest] = ctx.args;
  const handler = {
    add: () => addTicket(job, ctx, [ref, ...rest]),
    new: () => newTicket(job, ctx, ref),
    detach: () => store.detach(ctx.thread(ref)),
    remove: () => removeThread(job, ctx, ref),
    show: async () => boardData.detail((await ticket(ctx, ref)).id),
    attach: async () => store.attach((await ticket(ctx, ref)).id, ctx.thread(rest[0])),
    delete: () => deleteTicket(job, ctx, ref),
    edit: () => editTicket(ctx, ref),
    rank: () => rankTicket(ctx, ref),
    block: () => setBlock(ctx, ref, "block"),
    unblock: () => setBlock(ctx, ref, "unblock"),
    comment: () => comment(ctx, ref, rest),
    parent: () => parentTicket(ctx, ref),
    start: async () => handoff.startThread((await ticket(ctx, ref)).id, ctx.flags),
    handoff: async () => handoff.startHandoff((await ticket(ctx, ref)).id, { ...ctx.flags, sourceThreadIds: rest.length ? rest : [ctx.thread()], consolidate: false }),
    consolidate: async () => handoff.startHandoff((await ticket(ctx, ref)).id, { ...ctx.flags, sourceThreadIds: rest.length ? rest : [ctx.thread()], consolidate: true }),
  }[action];
  if (!handler) throw new Error(`Unknown ticket command ${action ?? ""}`);
  return handler();
}

async function ticket(ctx, ref) {
  return store.resolveTicket(ref, ctx.ticketContext);
}

async function addTicket(job, ctx, words) {
  if (!words[0]) throw new Error("Usage: ticket add <title> [--kind <story|bug|task>] [--parent <ticket>] [--blocked-by <ticket>[,<ticket>...]]");
  const kind = ctx.flags.kind === undefined ? "story" : parseKind(ctx.flags.kind);
  const wanted = stage(ctx.flags.stage ?? "backlog");
  if (wanted === "done") throw new Error("Create a ticket before moving it to Done");
  const parentId = ctx.flags.parent === undefined ? null : (await store.resolveTicket(ctx.flags.parent, ctx.ticketContext)).id;
  const proposed = Boolean(job.threadId && settings().agentAutoApproveAdds !== true);
  const created = await store.createTicket({
    projectId: ctx.project(), title: words.join(" "), description: ctx.flags.desc, stage: wanted, kind,
    blockerIds: await resolveAll(ctx.flags["blocked-by"], ctx.ticketContext), parentId, proposed,
  });
  return { ...created, note: proposed ? `Proposed #${created.number} ${created.title}. The person accepts it on the board.` : `Created #${created.number} ${created.title}.` };
}

async function newTicket(job, ctx, ref) {
  const t = await threads.get(ctx.thread(ref));
  const existing = await store.ticketOfThread(t.id);
  if (existing) throw new Error(`${t.id} is already on #${existing.number}. Run \`kg kanban ticket detach\` first.`);
  const kind = ctx.flags.kind === undefined ? "story" : parseKind(ctx.flags.kind);
  const proposed = Boolean(job.threadId && settings().agentAutoApproveAdds !== true);
  const created = await store.createTicket({ projectId: ctx.ticketContext.projectId ?? t.projectId, title: t.title, threadId: t.id, stage: ctx.flags.stage, kind, checkStart: true, proposed });
  return { ...created, note: proposed ? `Proposed #${created.number} ${created.title} with thread ${t.id}. The person accepts it on the board.` : `Created #${created.number} ${created.title} with thread ${t.id}.` };
}

async function removeThread(job, ctx, ref) {
  const threadId = ctx.thread(ref);
  if (job.threadId && threadId !== job.threadId && settings().agentMoveToDone !== true) throw new Error("Archiving another thread is not something an agent does. Ask the person to archive it.");
  return threads.archive(threadId);
}

async function deleteTicket(job, ctx, ref) {
  if (job.threadId && settings().agentMoveToDone !== true) throw new Error("Deleting a ticket from the agent CLI needs Agents can move to Done (archives threads)");
  return store.deleteTicket((await ticket(ctx, ref)).id);
}

async function editTicket(ctx, ref) {
  if (ctx.flags.title === undefined && ctx.flags.desc === undefined && ctx.flags.kind === undefined) throw new Error("Supply --title, --desc, or --kind");
  const t = await ticket(ctx, ref);
  return store.editTicket(t.id, { title: ctx.flags.title, description: ctx.flags.desc, kind: ctx.flags.kind === undefined ? undefined : parseKind(ctx.flags.kind, true) });
}

async function rankTicket(ctx, ref) {
  const place = ctx.flags.top ? { top: true }
    : ctx.flags.bottom ? { bottom: true }
      : ctx.flags.before ? { before: (await store.resolveTicket(ctx.flags.before, ctx.ticketContext)).id }
        : ctx.flags.after ? { after: (await store.resolveTicket(ctx.flags.after, ctx.ticketContext)).id }
          : null;
  if (!place) throw new Error("Usage: ticket rank <ticket> (--top | --bottom | --before <ticket> | --after <ticket>)");
  const t = await ticket(ctx, ref);
  const ranked = await store.rankTicket(t.id, place);
  return { ...ranked, backlogRank: await store.backlogPlace(t.id) };
}

async function setBlock(ctx, ref, action) {
  if (!String(ctx.flags.by ?? "").trim()) throw new Error(`Usage: ticket ${action} <ticket> --by <ticket>[,<ticket>...]`);
  const t = await ticket(ctx, ref);
  for (const blockerId of await resolveAll(ctx.flags.by, ctx.ticketContext)) {
    if (action === "block") await store.blockTicket(t.id, blockerId);
    else await store.unblockTicket(t.id, blockerId);
  }
  return boardData.detail(t.id);
}

async function comment(ctx, ref, words) {
  const t = await ticket(ctx, ref);
  return store.addComment(t.id, { body: words.join(" "), threadId: ctx.ticketContext.threadId });
}

async function parentTicket(ctx, ref) {
  const clear = Boolean(ctx.flags.none) || ctx.args.includes("none");
  if (ctx.flags.to === undefined && !clear) throw new Error("Usage: ticket parent <ticket> (--to <ticket> | --none)");
  if (ctx.flags.to !== undefined && clear) throw new Error("Give --to or --none, not both");
  const parent = clear ? null : (await store.resolveTicket(ctx.flags.to, ctx.ticketContext)).id;
  const t = await ticket(ctx, ref);
  return store.setParent(t.id, parent);
}
