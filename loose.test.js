// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { renderLoose } = await import("./loose.js");
const { colors, cx, view, ids, labels, texts } = await import("./test/support/view.js");

test("the loose tray lists threads and a new-ticket/in-progress/review action each", () => {
  const thread = { id: "thr_a", projectId: "prj_1", title: "Loose work", status: "idle" };
  const v = view({ data: { tickets: [], loose: [thread] }, looseLimit: 20 });
  const tray = renderLoose(v, cx(), colors(), { lg: 8 }, [thread]);
  assert.match(texts(tray).join(" "), /Loose threads/);
  assert.ok(ids(tray).includes("thread:thr_a"));
  assert.ok(ids(tray).includes("loose-close"));
});

test("an empty tray explains where threads go and a capped tray offers more", () => {
  const v = view({ data: { tickets: [], loose: [] }, drag: null });
  const empty = renderLoose(v, cx(), colors(), { lg: 8 }, []);
  assert.match(texts(empty).join(" "), /Every thread is on a ticket/);
  const threads = Array.from({ length: 25 }, (_, i) => ({ id: `thr_${i}`, projectId: "prj_1", title: `T${i}`, status: "idle" }));
  const capped = renderLoose({ ...v, looseLimit: 2 }, cx(), colors(), { lg: 8 }, threads);
  assert.ok(ids(capped).includes("more-loose"));
  assert.ok(labels(capped).join(" ").includes("Show 23 more"));
});
