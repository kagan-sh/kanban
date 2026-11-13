// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const personas = await import("./personas.js");
const host = await import("./test/support/kagan-host.js");

test("without a personas folder there are no personas: the plugin ships none", async () => {
  host.state.values.personasDir = undefined;
  assert.deepEqual(await personas.listPersonas(), []);
  await assert.rejects(() => personas.personaBody("implementer"), /personas folder in Settings/);
  assert.equal(await personas.personaBody(null), null);
});

test("the personas are the folder's .md files, without README or bad names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-personas-"));
  try {
    await writeFile(join(dir, "implementer.md"), "# Implementer\nBuild it.");
    await writeFile(join(dir, "reviewer.md"), "# Reviewer");
    await writeFile(join(dir, "README.md"), "not a persona");
    await writeFile(join(dir, "bad name.md"), "not a persona");
    host.state.values.personasDir = dir;
    assert.deepEqual(await personas.listPersonas(), ["implementer", "reviewer"]);
    assert.match(await personas.personaBody("implementer"), /Build it/);
    await assert.rejects(() => personas.personaBody("missing"), /personas folder in Settings/);
    await assert.rejects(() => personas.personaBody("../escape"), /personas folder in Settings/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    host.state.values.personasDir = undefined;
  }
});

test("each stage's default persona comes from Settings, and only when the folder has it", () => {
  const names = ["implementer", "intake"];
  host.state.values.personaBacklog = " intake ";
  host.state.values.personaInProgress = "gone";
  try {
    assert.equal(personas.stagePersona("backlog", names), "intake");
    assert.equal(personas.stagePersona("in-progress", names), "", "a name the folder lacks is not preselected");
    assert.equal(personas.stagePersona("review", names), "", "an unset stage preselects nothing");
    assert.equal(personas.stagePersona("done", names), "");
  } finally {
    host.state.values.personaBacklog = undefined;
    host.state.values.personaInProgress = undefined;
  }
});
