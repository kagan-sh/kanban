// @ts-check
import { USER_STORY_WARNING, looksLikeUserStory } from "./rules.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { Input, KgButton, Textarea } from "gpui-component";
import * as github from "./github.js";
import * as store from "./store.js";
import * as handoff from "./handoff.js";
import { handoffSources, moveWarning } from "./model.js";
import { button, clickCx, primary, select, tiny } from "./ui.js";

/** The fields a form shows, by the form the board has open. */
export function renderForm(view, cx) {
  const form = formShell(view, cx);
  const cancel = button("cancel-form", "Cancel", () => closeForm(view, cx));
  if (view.form === "edit") ticketFields(form, view, cx, cancel);
  else if (["start", "handoff", "consolidate"].includes(view.form)) threadFields(form, view, cx, cancel);
  else if (view.form === "attach") attachFields(form, view, cx, cancel);
  else if (view.form === "rules") rulesFields(form, view, cx, cancel);
  else if (view.form === "repos" || view.form === "import") repoFields(form, view, cx, cancel);
  return form;
}

function closeForm(view, cx) {
  view.form = null;
  view.pendingMove = null;
  cx.notify();
}

function formShell(view, cx) {
  const colors = cx.theme().colors;
  const form = v_flex().p_4().gap_3().rounded(cx.theme().radius.lg).bg(colors.surface).border_1().border_color(colors.border)
    .track_focus(view.formFocus);
  form.on_key_down((event, cx) => {
    if (event.key !== "escape") return;
    view.form = null;
    view.pendingMove = null;
    cx.stop_propagation();
    cx.notify();
  });
  return form;
}

function formTitle(text) {
  return div().font_weight(600).text_size(13).child(text);
}

function ticketFields(form, view, cx, cancel) {
  form.child(formTitle("Edit ticket"));
  form.child(tiny("Ticket title", cx));
  form.child(new Input(view.title).aria_label("Ticket title").on_change((_, cx) => cx.notify()));
  if (looksLikeUserStory(view.title.value())) form.child(tiny(USER_STORY_WARNING, cx));
  form.child(tiny("Description. A story needs a ## Acceptance criteria checklist to leave Backlog.", cx));
  form.child(new Textarea(view.description).aria_label("Description"));
  const titleOk = view.title.value().trim().length > 0 && view.title.value().trim().length <= 200;
  form.child(h_flex().gap_2().justify_end().child(cancel).child(new KgButton("save-ticket").primary().compact()
    .label("Save").disabled(view.busy || !titleOk)
    .on_click((a, b) => view.act(clickCx(a, b), async () => {
      await store.editTicket(view.ticketId, { title: view.title.value(), description: view.description.value() });
      view.form = null;
    }))));
}

function threadFields(form, view, cx, cancel) {
  const take = view.form === "handoff" || view.form === "consolidate";
  form.child(formTitle(view.form === "start" ? "Start thread" : view.form === "consolidate" ? "Consolidate threads" : "Hand off"));
  form.child(tiny(take
    ? "The board asks each selected thread for a handoff, saves it as a comment, then starts one new thread from them."
    : "Pick a persona and an optional prompt. The thread reads the ticket and its comments.", cx));
  form.child(new Textarea(view.prompt).aria_label("Prompt for the new thread"));
  form.child(select("persona", [{ id: "none", label: "No persona" }, ...view.personas.map(name => ({ id: name, label: name }))], view.persona || "No persona", (id, cx) => { view.persona = id === "none" ? "" : id; cx.notify(); }));
  if (take) for (const thread of handoffSources(view.ticket ?? {})) {
    form.child(button(`source:${thread.id}`, `${view.sourceIds.has(thread.id) ? "✓ " : ""}${thread.title}`, cx => {
      if (view.form === "handoff") view.sourceIds = new Set([thread.id]);
      else view.sourceIds.has(thread.id) ? view.sourceIds.delete(thread.id) : view.sourceIds.add(thread.id);
      cx.notify();
    }));
  }
  form.child(threadActions(view, cx, cancel));
}

function threadActions(view, cx, cancel) {
  const take = view.form === "handoff" || view.form === "consolidate";
  const actions = h_flex().gap_2().child(cancel);
  if (view.pendingMove) actions.child(button("just-move", "Move without starting a thread", cx => {
    const pending = view.pendingMove;
    view.pendingMove = null;
    view.form = null;
    view.finishMove(cx, pending.id, pending.stage, "done");
  }));
  const canSubmit = view.form === "start" || view.sourceIds.size > 0;
  actions.child(new KgButton("submit-thread").primary().compact()
    .label(view.form === "start" ? "Start thread" : view.form === "consolidate" ? "Consolidate" : "Hand off")
    .disabled(view.busy || !canSubmit)
    .on_click((a, b) => view.act(clickCx(a, b), () => submitThread(view, take))));
  return actions;
}

async function submitThread(view, take) {
  const options = { persona: view.persona || null, prompt: view.prompt.value() };
  try {
    if (!take) await handoff.startThread(view.ticketId, options);
    else {
      if (view.pendingMove) {
        const moved = await store.moveTicket(view.pendingMove.id, view.pendingMove.stage);
        const warning = moveWarning(moved);
        if (warning) view.note = warning;
      }
      await handoff.startHandoff(view.ticketId, { ...options, sourceThreadIds: [...view.sourceIds], consolidate: view.form === "consolidate" });
    }
  } finally {
    // Close even on failure so Retry on the card is the recovery path, not a second spawn.
    view.form = null;
    view.pendingMove = null;
  }
}

function attachFields(form, view, cx, cancel) {
  const loose = view.data.loose.filter(thread => thread.projectId === view.ticket?.projectId);
  for (const thread of loose) form.child(button(`attach:${thread.id}`, thread.title, cx => view.act(cx, async () => { await store.attach(view.ticketId, thread.id); view.form = null; })));
  if (!loose.length) form.child(tiny("No threads without a ticket in this project", cx));
  form.child(cancel);
}

function rulesFields(form, view, cx, cancel) {
  form.child(formTitle("Board rules"));
  form.child(tiny("For this project's tickets only.", cx));
  form.child(h_flex().gap_3().items_center().justify_between()
    .child(tiny("Days in a column before a warning", cx))
    .child(new Input(view.warnDays).aria_label("Warning days").max_w("5rem")));
  form.child(h_flex().gap_3().items_center().justify_between()
    .child(tiny("Most tickets in In progress", cx))
    .child(new Input(view.wipLimit).aria_label("Work in progress limit").max_w("5rem")));
  form.child(h_flex().gap_2().justify_end().child(cancel).child(primary("save-rules", "Save", cx => view.act(cx, async () => {
    const days = Number(view.warnDays.value());
    const raw = view.wipLimit.value().trim();
    const limit = raw === "" || raw.toLowerCase() === "off" ? null : Number(raw);
    await store.setBoardRules(view.projectId, { ageWarnDays: days, wipLimit: limit });
    view.form = null;
  }))));
}

function repoFields(form, view, cx, cancel) {
  const colors = cx.theme().colors;
  if (view.form === "import") {
    form.child(formTitle("Import issue"));
    form.child(tiny("Copies the issue onto the bottom of Backlog. Nothing is written to GitHub.", cx));
  } else {
    form.child(formTitle("Linked repos"));
    form.child(tiny("Issues from these GitHub repos can be imported as tickets.", cx));
    for (const repo of view.repos) form.child(h_flex().gap_2().items_center().child(tiny(repo, cx, colors.foreground).flex_1()).child(button(`unlink:${repo}`, "Unlink", cx => view.act(cx, () => store.unlinkRepo(view.projectId, repo)))));
    form.child(h_flex().gap_2().child(new Input(view.repo).aria_label("Repo to link")).child(button("link-repo", "Link", cx => view.act(cx, async () => { await store.linkRepo(view.projectId, await github.normalizeRepo(view.repo.value())); view.repo.set_value(""); }))));
  }
  form.child(new Input(view.issueQuery).aria_label("Search open issues"));
  for (const field of ["label", "assignee", "author"]) {
    const values = new Set(view.issues.flatMap(issue => field === "label" ? issue.labels?.map(l => l.name) ?? [] : field === "assignee" ? issue.assignees?.map(a => a.login) ?? [] : [issue.author?.login]).filter(Boolean));
    form.child(select(`issue-${field}`, [{ id: "all", label: `All ${field}s` }, ...[...values].map(value => ({ id: value, label: value }))], view.issueFilters[field] || `All ${field}s`, (value, cx) => { view.issueFilters[field] = value === "all" ? "" : value; cx.notify(); }));
  }
  form.child(button("search-issues", "Search issues", cx => view.act(cx, async () => { view.issues = await github.listIssues(view.projectId, { query: view.issueQuery.value(), ...view.issueFilters }); })));
  for (const issue of view.issues) form.child(button(`import:${issue.repo}:${issue.number}`, `${issue.repo}#${issue.number} · ${issue.title}`, cx => view.act(cx, async () => { const ticket = await github.importIssue(view.projectId, issue.repo, issue.number); view.ticketId = ticket.id; view.form = null; })));
  form.child(cancel);
}
