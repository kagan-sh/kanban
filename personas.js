// @ts-check
import { readdir, readFile } from "fs/promises";
import { settings } from "kagan/host";
import { run } from "kagan/process";

const NAME = /^[A-Za-z0-9][\w.-]*$/;
/** Each stage's default persona is a setting, so the person picks it; the plugin names none. */
const STAGE_SETTING = { backlog: "personaBacklog", "in-progress": "personaInProgress", review: "personaReview" };
let lastPull = 0;
let lastDir = "";

function personasDir() {
  const dir = settings().personasDir;
  return typeof dir === "string" && dir ? dir : null;
}

/** The persona files in the folder Settings names. No folder, no personas. */
export async function listPersonas() {
  const dir = personasDir();
  if (!dir) return [];
  if (dir !== lastDir || Date.now() - lastPull > 300000) {
    lastDir = dir;
    lastPull = Date.now();
    await run("git", ["-C", dir, "pull", "--ff-only"], { timeoutMs: 30000 }).catch(() => undefined);
  }
  return (await readdir(dir))
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md" && NAME.test(n.slice(0, -3)))
    .map((n) => n.slice(0, -3))
    .sort();
}

/** The persona Settings picks for a thread started in this stage, when the folder has it. */
export function stagePersona(stage, names) {
  const key = STAGE_SETTING[stage];
  const name = key ? settings()[key] : null;
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed && names.includes(trimmed) ? trimmed : "";
}

export async function personaBody(name) {
  if (!name) return null;
  const dir = personasDir();
  if (!dir || !NAME.test(name)) throw new Error("Choose a persona from the personas folder in Settings");
  const text = await readFile(`${dir.replace(/[/\\]$/, "")}/${name}.md`, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Couldn't read persona ${name}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (text === null) throw new Error("Choose a persona from the personas folder in Settings");
  return text;
}
