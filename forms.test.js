// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { renderForm } = await import("./forms.js");
const { InputState, TextareaState } = await import("./test/support/gpui-component.js");
const { cx, view, ids, labels, texts } = await import("./test/support/view.js");

function fake(extra = {}) {
  return view({
    form: "new", projectId: "prj_1", busy: false, ticketId: "tkt_1", note: "",
    title: InputState("title"), description: TextareaState(), prompt: TextareaState(), comment: TextareaState(),
    warnDays: InputState("14"), wipLimit: InputState(""), repo: InputState("repo"), issueQuery: InputState("query"),
    issueFilters: { label: "", assignee: "", author: "" }, repos: ["owner/name"], issues: [], personas: ["implementer"],
    persona: "", sourceIds: new Set(), pendingMove: null, ticket: null,
    act() {}, finishMove() {}, ...extra,
  });
}

test("the ticket form asks for a title and a description", () => {
  const form = renderForm(fake({ form: "edit" }), cx());
  assert.match(texts(form).join(" "), /Edit ticket/);
  assert.ok(ids(form).includes("save-ticket"));
});

test("the thread form lists personas and the selected sources", () => {
  const ticket = { id: "tkt_1", number: 1, stage: "review", threads: [{ id: "thr_a", title: "A" }, { id: "thr_b", title: "B" }] };
  const form = renderForm(fake({ form: "handoff", ticket, sourceIds: new Set(["thr_a"]) }), cx());
  assert.match(texts(form).join(" "), /Hand off/);
  assert.ok(ids(form).includes("source:thr_a"));
  assert.ok(ids(form).includes("submit-thread"));
});

test("attach lists only loose threads from the ticket's project", () => {
  const ticket = { id: "tkt_1", projectId: "prj_1" };
  const loose = [{ id: "thr_a", projectId: "prj_1", title: "A" }, { id: "thr_b", projectId: "prj_2", title: "B" }];
  const form = renderForm(fake({ form: "attach", ticket, data: { tickets: [], loose } }), cx());
  assert.ok(ids(form).includes("attach:thr_a"));
  assert.equal(ids(form).includes("attach:thr_b"), false);
});

test("rules and repos forms show their fields", () => {
  const rules = renderForm(fake({ form: "rules" }), cx());
  assert.match(texts(rules).join(" "), /Board rules/);
  assert.ok(ids(rules).includes("save-rules"));
  const repos = renderForm(fake({ form: "repos" }), cx());
  assert.match(texts(repos).join(" "), /Linked repos/);
  assert.ok(ids(repos).includes("link-repo"));
  const imported = renderForm(fake({ form: "import" }), cx());
  assert.match(texts(imported).join(" "), /Import issue/);
});
