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

test("without a folder the built-in personas are still available", async () => {
  host.state.values.personasDir = undefined;
  assert.deepEqual(await personas.listPersonas(), ["comment-editor"]);
  const text = await personas.personaBody("comment-editor");
  assert.match(text, /Comment editor/);
  await assert.rejects(() => personas.personaBody("nobody"), /Choose a persona/);
  assert.equal(await personas.personaBody(null), null);
});

test("a folder adds persona files and a file of the same name wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kanban-personas-"));
  try {
    await writeFile(join(dir, "implementer.md"), "# Implementer\nBuild it.");
    await writeFile(join(dir, "comment-editor.md"), "# Custom editor");
    await writeFile(join(dir, "README.md"), "not a persona");
    await writeFile(join(dir, "bad name.md"), "not a persona");
    host.state.values.personasDir = dir;
    const names = await personas.listPersonas();
    assert.deepEqual(names, ["comment-editor", "implementer"]);
    assert.match(await personas.personaBody("implementer"), /Build it/);
    assert.match(await personas.personaBody("comment-editor"), /Custom editor/);
    await assert.rejects(() => personas.personaBody("../escape"), /Choose a persona/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    host.state.values.personasDir = undefined;
  }
});
