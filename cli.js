// @ts-check
import { formatResult } from "./format.js";
import { listCommand, moveCommand, reposCommand, rulesCommand, ticketCommand } from "./commands.js";

export function parse(argv) {
  const args = [];
  /** @type {Record<string, any>} */
  const flags = {};
  const values = new Set(["project", "desc", "stage", "title", "persona", "prompt", "parent", "to", "query", "label", "assignee", "author", "kind", "before", "after", "by", "blocked-by", "warn-days", "wip-limit"]);
  const bools = new Set(["json", "wont-do", "top", "bottom", "none"]);
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

/** One parsed command, with the project and thread references the handlers share. */
function contextOf(job, parsed) {
  const projectId = parsed.flags.project ?? job.projectId;
  return {
    flags: parsed.flags,
    args: parsed.args,
    projectId,
    ticketContext: { projectId, threadId: job.threadId },
    project() {
      if (!projectId) throw new Error("Choose --project <project-id> or run inside a project");
      return projectId;
    },
    thread(ref) {
      if (!ref && !job.threadId) throw new Error("Name a thread");
      return ref ?? job.threadId;
    },
  };
}

export async function execute(job, parsed = parse(job.argv)) {
  const ctx = contextOf(job, parsed);
  if (job.command === "list") return listCommand(job, ctx);
  if (job.command === "rules") return rulesCommand(job, ctx);
  if (job.command === "move") return moveCommand(job, ctx);
  if (job.command === "repos") return reposCommand(job, ctx);
  if (job.command === "ticket") return ticketCommand(job, ctx);
  throw new Error(`Unknown command ${job.command}`);
}

export async function cli(job) {
  try {
    const parsed = parse(job.argv);
    const result = await execute(job, parsed);
    return { exitCode: 0, stdout: formatResult(result, parsed.flags.json === true), stderr: "" };
  } catch (error) { return { exitCode: 1, stdout: "", stderr: String(error) }; }
}
