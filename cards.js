// @ts-check
import { AGE_WARN_DAYS, daysInStage } from "./rules.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { ThreadStatus } from "gpui-component";
import * as host from "kagan/host";
import * as store from "./store.js";
import * as handoff from "./handoff.js";
import { criteriaLine, descriptionPreview, dropOnCard, needsYou, openBlockers, pendingMoveControls, subTicketLine, threadStatusLine } from "./model.js";
import { HANDING_OFF, button, chip, dot, link, outline, tiny } from "./ui.js";

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
  const meta = [tiny(`#${t.number}`, cx)];
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
  if (parent) rows.push(h_flex().id(`parent:${t.id}`).role("button").accessibility_label(`Sub-ticket of #${parent.number} ${parent.title}`).gap_1().items_center().min_w_0().cursor_pointer()
    .on_click((_event, cx) => { cx.stop_propagation(); view.openTicket(parent.id, cx); })
    .child(tiny("↳", cx))
    .child(tiny(`#${parent.number} ${parent.title}`, cx).flex_1().min_w_0().truncate()));
  const subs = subTicketLine(view.data.tickets.filter(c => c.parentId === t.id));
  if (subs) rows.push(tiny(subs, cx));
  const blockers = openBlockers(t);
  if (blockers.length && t.stage !== "done") {
    rows.push(h_flex().gap_1().items_center().flex_wrap()
      .child(tiny("Blocked", cx))
      .children(blockers.map(b => link(`blocked:${t.id}:${b.id}`, `#${b.number}`, cx => view.openTicket(b.id, cx), cx))));
  }
  if (t.issue) rows.push(link(`open-issue:${t.id}`, `${t.issue.repo}#${t.issue.number}`, cx => view.act(cx, () => host.openUrl(t.issue.url)), cx));
  return rows;
}

function cardThreads(view, t, cx) {
  if (!t.threads.length) {
    return link(`start-card:${t.id}`, "+ Start a thread", cx => {
      view.ticketId = t.id;
      view.act(cx, () => view.prepare("start", t));
    }, cx);
  }
  const open = view.openThreads.has(t.id);
  const toggle = link(`threads:${t.id}`, `${open ? "▾" : "▸"} ${t.threads.length} thread${t.threads.length === 1 ? "" : "s"}`, cx => {
    view.openThreads.has(t.id) ? view.openThreads.delete(t.id) : view.openThreads.add(t.id);
    cx.notify();
  }, cx);
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

/** The card's title, left-aligned and wrapping across the card as bb's does. */
function cardTitle(t, colors) {
  return div().w_full().pr(28).whitespace_normal().text_size(14).text_color(colors.foreground).child(t.title);
}

/** bb opens the ticket from anywhere on the card; its own buttons keep their clicks. */
function opensOnClick(card, view, t) {
  return card.cursor_pointer().on_click((_event, cx) => view.openTicket(t.id, cx));
}

/** The menu stays out of the way until the pointer is over its card, as in bb. */
function hoverMenu(view, t, cx, open) {
  // The menu's click stops here, so opening it does not also open the ticket.
  return div().id(`card-menu:${t.id}`).absolute().top(6).right(6).when(!open, el => el.opacity(0)).group_hover("card", el => el.opacity(1))
    .on_click((_event, cx) => cx.stop_propagation())
    .child(view.menu(t, cx));
}

export function renderCard(view, t, cx, colors, radius) {
  if (t.proposed) return renderProposedCard(view, t, cx, colors, radius);
  const active = view.over?.id === t.id;
  const dragged = view.drag?.kind === "ticket" && view.drag.id === t.id;
  const card = v_flex().id(`ticket:${t.id}`).group("card").gap_1().px_3().py(10).rounded(radius.lg).bg(colors.background).border_1()
    .border_color(active ? colors.ring : view.jumpId === t.id ? colors.primary : colors.border)
    .when(dragged, el => el.opacity(0.4));
  view.dropTarget(view.dragSource(card, "ticket", t.id), t.id, (payload, side) => dropOnCard(payload, side, t, view.data.tickets, view.data.loose));
  if (active && view.over.side === "top") card.child(div().h(2).w_full().rounded(1).bg(colors.ring));
  // The card itself takes the keyboard for a jump.
  // Enter or Space there opens it, as a click does.
  if (view.jumpId === t.id) {
    card.track_focus(view.jumpFocus).on_key_down((event, cx) => {
      if (event.key !== "enter" && event.key !== "space") return;
      cx.stop_propagation();
      view.openTicket(t.id, cx);
    });
  }
  opensOnClick(card, view, t).relative().child(cardTitle(t, colors)).child(hoverMenu(view, t, cx, view.jumpId === t.id));
  card.child(metaRow(view, t, cx, colors));
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

/** At most three lines of the description with blank lines dropped, as bb's line-clamped preview reads. */
export function cardPreview(text) {
  const lines = String(text ?? "").split("\n").map(line => line.trim()).filter(Boolean);
  return descriptionPreview(lines.slice(0, 3).join("\n") + (lines.length > 3 ? "\n…" : ""), 160);
}

export function renderProposedCard(view, t, cx, colors, radius) {
  const active = view.over?.id === t.id;
  const card = v_flex().id(`ticket:${t.id}`).gap_1().px_3().py(10).rounded(radius.lg).bg(colors.surface)
    .border_1().border_dashed().border_color(active ? colors.ring : colors.border);
  view.dropTarget(view.dragSource(card, "ticket", t.id), t.id, (payload, side) => dropOnCard(payload, side, t, view.data.tickets, view.data.loose));
  card.child(tiny(`Proposed by an agent${view.shown.has(t.projectId) ? ` in ${view.projects.find(p => p.id === t.projectId)?.name ?? ""}` : ""}`, cx));
  opensOnClick(card, view, t).child(cardTitle(t, colors));
  const preview = cardPreview(t.description);
  if (preview) card.child(tiny(preview, cx).whitespace_normal());
  card.child(h_flex().gap_2().pt_1()
    .child(outline(`accept:${t.id}`, "Accept", cx => view.act(cx, () => store.acceptTicket(t.id))).size("xsmall"))
    .child(link(`dismiss:${t.id}`, "Dismiss", cx => view.act(cx, () => store.dismissTicket(t.id)), cx)));
  return card;
}
