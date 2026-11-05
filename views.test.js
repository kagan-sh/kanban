// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const views = await import("./views.js");

test("the panel facade still exports the two panels kagan.json names", () => {
  assert.equal(typeof views.BoardPanel, "function");
  assert.equal(typeof views.SidebarList, "function");
  assert.equal(Object.getPrototypeOf(views.BoardPanel.prototype) !== null, true);
});
