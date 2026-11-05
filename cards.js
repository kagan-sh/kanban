// @ts-check
import { AGE_WARN_DAYS, daysInStage, startProblem } from "./rules.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { KgButton, ThreadStatus } from "gpui-component";
import * as host from "kagan/host";
import * as store from "./store.js";
import * as handoff from "./handoff.js";
import { criteriaLine, descriptionPreview, dropOnCard, needsYou, openBlockers, pendingMoveControls, subTicketLine, threadStatusLine } from "./model.js";
import { HANDING_OFF, button, chip, clickCx, dot, outline, tiny } from "./ui.js";

/** A pending agent move with its Accept, Dismiss and won't-do controls. */
export function renderPendingMove(view, t, cx, prefix) {
  const spec = pendingMoveControls(t, prefix);
  if (!spec) return null;
  const pending = v_flex().gap_1().mt_1().child(tiny(spec.prompt, cx));
  const actions = h_flex().gap_3();
  for (const action of spec.actions) {
    actions.child(button(action.id, action.label, cx => {
      if (action.kind === "accept") view.move(t, t.pendingStage, cx);
      else if (action.kind === "dismiss") view.act(cx, () => store.dismissMove(t.id));
      else if (action.kind === "wont-do") view.move(t, "done", cx, "wont-do");
      else throw new Error(`Unknown pending move action ${action.kind}`);
    }));
  }
  return pending.child(actions);
}

/** The handoff's own line: asking, waiting to archive, or failed with its recovery. */
export function renderHandoffState(view, t, cx, prefix) {
  const job = t.handoff;
  if (!job) return null;
  const colors = cx.theme().colors;
  if (HANDING_OFF.has(String(job.status))) {
    const progress = job.consolidate && job.total ? ` ${job.done ?? 0} of ${job.total}` : "";
    return h_flex().gap_2().items_center().mt_1()
      .child(dot(cx, colors.primary))
      .child(tiny(`${job.consolidate ? "Consolidating" : "Handing off"}${progress}…`, cx));
  }
  if (job.status === "awaiting-archive") {
    return v_flex().gap_1().mt_1()
      .when(Boolean(job.error), el => el.child(tiny(String(job.error), cx, colors.destructive)))
      .child(h_flex().gap_2().items_center()
        .child(tiny("Some handoff sources are still live. Archive them when the new thread has what it needs.", cx).flex_1())
        .child(button(`${prefix}:archive-sources`, "Archive sources", cx => view.act(cx, () => handoff.archiveSources(t.id)))));
  }
  if (job.status !== "failed" && !job.error) return null;
  const box = v_flex().gap_1().mt_1()
    .child(tiny(job.consolidate ? "Couldn't consolidate" : "Handoff failed", cx, colors.destructive).font_weight(600));
  if (job.error) box.child(tiny(String(job.error), cx, colors.destructive));
  return box.child(h_flex().gap_3()
    .child(button(`${prefix}:retry-handoff`, "Retry", cx => view.act(cx, () => handoff.retryHandoff(t.id))))
    .child(button(`${prefix}:start-anyway`, job.consolidate ? "Start anyway" : "Start without handoff", cx => view.act(cx, () => handoff.startWithoutHandoff(t.id)))));
}

function metaRow(view, t, cx, colors) {
  const meta = [];
  if (t.stage === "backlog" && needsYou(t) && !t.proposed) {
    meta.push(h_flex().gap_1().items_center()
      .child(dot(cx, colors.primary))
      .child(tiny("Needs you", cx, colors.foreground).font_weight(600)));
  }
  if (t.kind) meta.push(chip(t.kind, cx));
  if (t.stage === "done" && t.resolution === "wont-do") meta.push(chip("won't do", cx));
  const ac = criteriaLine(t.description, t.kind);
  if (ac) meta.push(tiny(ac, cx));
  const age = t.stage === "in-progress" || t.stage === "review" ? daysInStage(t.stageAt) : null;
  if (age !== null) {
    const warn = view.ruleMap.get(t.projectId)?.ageWarnDays ?? AGE_WARN_DAYS;
    const label = tiny(`${age}d`, cx, age > warn ? colors.primary : colors.muted_foreground);
    if (age > warn) label.font_weight(600);
    meta.push(label);
  }
  if (t.projectId !== view.projectId) meta.push(tiny(view.projects.find(p => p.id === t.projectId)?.name ?? "", cx));
  return h_flex().gap_1().items_center().flex_wrap().children(meta);
}

/** The card's relationships and its reason it can't start. */
function cardDetails(view, t, cx) {
  const rows = [];
  const parent = t.parentId ? view.data.tickets.find(p => p.id === t.parentId) : null;
  if (parent) rows.push(h_flex().gap_1().items_center()
    .child(tiny("↳", cx))
    .child(button(`parent:${t.id}`, `#${parent.number} ${parent.title}`, cx => view.openTicket(parent.id, cx)).text_size(11)));
  const subs = subTicketLine(view.data.tickets.filter(c => c.parentId === t.id));
  if (subs) rows.push(tiny(subs, cx));
  const blockers = openBlockers(t);
  if (blockers.length && t.stage !== "done") {
    rows.push(h_flex().gap_1().items_center().flex_wrap()
      .child(tiny("Blocked", cx))
      .children(blockers.map(b => button(`blocked:${t.id}:${b.id}`, `#${b.number}`, cx => view.openTicket(b.id, cx)).text_size(11))));
  }
  const held = t.stage === "backlog" ? startProblem(t) : null;
  if (held) rows.push(tiny(`Can't leave Backlog yet: ${held}.`, cx));
  if (t.issue) rows.push(button(`open-issue:${t.id}`, `${t.issue.repo}#${t.issue.number}`, cx => view.act(cx, () => host.openUrl(t.issue.url))).text_size(11));
  return rows;
}

function cardThreads(view, t, cx) {
  if (!t.threads.length) {
    return button(`start-card:${t.id}`, "+  Start a thread", cx => {
      view.ticketId = t.id;
      view.act(cx, () => view.prepare("start", t));
    }).text_size(11);
  }
  const open = view.openThreads.has(t.id);
  const toggle = button(`threads:${t.id}`, `${open ? "▾" : "▸"} ${t.threads.length} thread${t.threads.length === 1 ? "" : "s"}`, cx => {
    view.openThreads.has(t.id) ? view.openThreads.delete(t.id) : view.openThreads.add(t.id);
    cx.notify();
  }).text_size(11);
  if (!open) return toggle;
  const list = v_flex().gap_1().child(toggle);
  for (const thread of t.threads) {
    const dragged = view.drag?.kind === "thread" && view.drag.id === thread.id;
    const row = view.dragSource(h_flex().id(`thread:${thread.id}`).gap_2().items_center().px_1().when(dragged, el => el.opacity(0.4)), "thread", thread.id);
    row.child(new ThreadStatus(thread.id)).child(button(`card-thread:${thread.id}`, thread.title, cx => view.act(cx, () => host.openThread(thread.id))).flex_1().min_w_0().text_size(11));
    list.child(row);
  }
  return list;
}

export function renderCard(view, t, cx, colors, radius) {
  if (t.proposed) return renderProposedCard(view, t, cx, colors, radius);
  const active = view.over?.id === t.id;
  const dragged = view.drag?.kind === "ticket" && view.drag.id === t.id;
  const card = v_flex().id(`ticket:${t.id}`).gap_1().px_3().py_2().rounded(radius.md).bg(colors.background).border_1()
    .border_color(active ? colors.ring : view.jumpId === t.id ? colors.primary : colors.border)
    .when(dragged, el => el.opacity(0.4));
  view.dropTarget(view.dragSource(card, "ticket", t.id), t.id, (payload, side) => dropOnCard(payload, side, t, view.data.tickets, view.data.loose));
  if (active && view.over.side === "top") card.child(div().h(2).w_full().rounded(1).bg(colors.ring));
  const opener = new KgButton(`card:${t.id}`).label(t.title).ghost().compact().flex_1().min_w_0().on_click((a, b) => view.openTicket(t.id, clickCx(a, b)));
  if (view.jumpId === t.id) opener.track_focus(view.jumpFocus);
  const meta = metaRow(view, t, cx, colors);
  card.child(h_flex().gap_2().items_start()
    .child(v_flex().gap_1().flex_1().min_w_0()
      .child(h_flex().gap_1().items_baseline().child(tiny(`#${t.number}`, cx)).child(opener))
      .child(meta))
    .child(view.menu(t, cx)));
  card.children(cardDetails(view, t, cx));
  const job = renderHandoffState(view, t, cx, `card:${t.id}`);
  if (job) card.child(job);
  if (t.pendingStage) card.child(renderPendingMove(view, t, cx, `card:${t.id}`));
  const statusLine = threadStatusLine(t.threads);
  if (statusLine) card.child(tiny(statusLine.replace("Thread status · ", ""), cx));
  card.child(cardThreads(view, t, cx));
  if (active && view.over.side === "bottom") card.child(div().h(2).w_full().rounded(1).bg(colors.ring));
  return card;
}

export function renderProposedCard(view, t, cx, colors, radius) {
  const active = view.over?.id === t.id;
  const card = v_flex().id(`ticket:${t.id}`).gap_1().px_3().py_2().rounded(radius.md).bg(colors.surface)
    .border_1().border_dashed().border_color(active ? colors.ring : colors.border);
  view.dropTarget(view.dragSource(card, "ticket", t.id), t.id, (payload, side) => dropOnCard(payload, side, t, view.data.tickets, view.data.loose));
  card.child(tiny(`Proposed by an agent${view.shown.has(t.projectId) ? ` in ${view.projects.find(p => p.id === t.projectId)?.name ?? ""}` : ""}`, cx));
  card.child(h_flex().gap_1().items_baseline()
    .child(tiny(`#${t.number}`, cx))
    .child(button(`card:${t.id}`, t.title, cx => view.openTicket(t.id, cx)).flex_1().min_w_0()));
  const preview = descriptionPreview(t.description);
  if (preview) card.child(tiny(preview, cx));
  card.child(h_flex().gap_2().pt_1()
    .child(outline(`accept:${t.id}`, "Accept", cx => view.act(cx, () => store.acceptTicket(t.id))))
    .child(button(`dismiss:${t.id}`, "Dismiss", cx => view.act(cx, () => store.dismissTicket(t.id)))));
  return card;
}
