// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const ui = await import("./ui.js");
const { cx, texts } = await import("./test/support/view.js");

test("the shared button helpers keep their id and label", () => {
  const ghost = ui.button("card:x", "Open", () => {});
  assert.ok(ghost._node.ids.includes("card:x"));
  assert.deepEqual(ghost._node.labels, ["Open"]);
  const primary = ui.primary("save", "Save", () => {});
  assert.ok(primary._node.ids.includes("save"));
  assert.match(texts(ui.tiny("quiet", cx())).join(" "), /quiet/);
});

test("focus is best effort: a missing control calls the miss handler", () => {
  let missed = null;
  const handle = { focus() { throw new Error("not mounted"); } };
  ui.focusWhenMounted(handle, (error) => { missed = error; });
  assert.match(String(missed), /not mounted/);
  ui.focusWhenMounted({ focus() {} });
  assert.equal(typeof ui.HANDING_OFF.has, "function");
});

test("an action that throws becomes the view's error and still clears busy", async () => {
  const view = Object.create(ui.WatchedView.prototype);
  view.busy = false; view.error = ""; view.note = ""; view.fields = 0;
  view.refresh = async () => {};
  const context = { notify() {}, spawn(fn) { return Promise.resolve(fn(context)); } };
  view.act(context, async () => { throw new Error("boom"); });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(view.error, /boom/);
  assert.equal(view.busy, false);
});
