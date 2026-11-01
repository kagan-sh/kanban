// @ts-check
import { readdir, readFile } from "fs/promises";
import { settings } from "kagan/host";
import { run } from "kagan/process";

const NAME = /^[A-Za-z0-9][\w.-]*$/;
let lastPull = 0;
let lastDir = "";

function personasDir() {
  const dir = settings().personasDir;
  return typeof dir === "string" && dir ? dir : null;
}

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

export async function personaBody(name) {
  if (!name) return null;
  const dir = personasDir();
  if (!dir || !NAME.test(name)) throw new Error("Choose a persona from the configured folder");
  return readFile(`${dir.replace(/[/\\]$/, "")}/${name}.md`, "utf8");
}
