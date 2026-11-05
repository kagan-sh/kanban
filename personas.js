// @ts-check
import { readdir, readFile } from "fs/promises";
import { settings } from "kagan/host";
import { run } from "kagan/process";
import { BUILTIN_PERSONAS } from "./personas-data.js";

const NAME = /^[A-Za-z0-9][\w.-]*$/;
let lastPull = 0;
let lastDir = "";

function personasDir() {
  const dir = settings().personasDir;
  return typeof dir === "string" && dir ? dir : null;
}

export async function listPersonas() {
  const dir = personasDir();
  if (!dir) return Object.keys(BUILTIN_PERSONAS);
  if (dir !== lastDir || Date.now() - lastPull > 300000) {
    lastDir = dir;
    lastPull = Date.now();
    await run("git", ["-C", dir, "pull", "--ff-only"], { timeoutMs: 30000 }).catch(() => undefined);
  }
  const found = (await readdir(dir))
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md" && NAME.test(n.slice(0, -3)))
    .map((n) => n.slice(0, -3))
    .sort();
  return [...new Set([...Object.keys(BUILTIN_PERSONAS), ...found])];
}

export async function personaBody(name) {
  if (!name) return null;
  const dir = personasDir();
  if (!NAME.test(name)) throw new Error("Choose a persona from the configured folder");
  if (dir) {
    const text = await readFile(`${dir.replace(/[/\\]$/, "")}/${name}.md`, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Couldn't read persona ${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (text !== null) return text;
  }
  if (Object.hasOwn(BUILTIN_PERSONAS, name)) return BUILTIN_PERSONAS[name];
  throw new Error("Choose a persona from the configured folder");
}
