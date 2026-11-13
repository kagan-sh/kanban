// @ts-check
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { Scroll, Spinner } from "gpui-component";
import * as host from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import { sidebarRows } from "./model.js";
import { WatchedView, boardLink, button, followContext, tiny } from "./ui.js";
import { agentMark } from "./agents.js";
import { isBusy } from "./busy.js";

export class SidebarList extends WatchedView {
  init(props, cx) {
    this.expanded = new Set();
    this.collapsed = new Set();
    this.onlyNeeds = false;
    this.frozen = [];
    this.selected = null;
    this.menuFor = null;
    this.listFocus = cx.focus_handle();
    super.init(props, cx);
    this.context = followContext(cx);
    this.preferences = cx.spawn(async cx => {
      const saved = await store.kvJson("sidebar", []);
      this.collapsed = new Set(saved);
      this.onlyNeeds = Boolean(await store.kvJson("sidebar-focus", false));
      cx.notify();
    });
  }
  rows() {
    const sidebar = threads.sidebar();
    return sidebarRows(sidebar.projects, this.data.tickets, sidebar.threads, host.context().projectId, this.expanded, this.collapsed, this.frozen);
  }
  open(row, cx) {
    this.act(cx, () => row.thread ? host.openThread(row.thread.id) : boardLink(row.project ? row.project.id : row.ticket.projectId, row.ticket?.id));
  }
  toggle(id, set, key) {
    return (cx) => this.act(cx, async () => {
      set.has(id) ? set.delete(id) : set.add(id);
      if (key) await store.kvSet(key, JSON.stringify([...set]));
    });
  }
  /** bb's header controls: Focus and Board, shown on hover; Focus stays lit while it is on. */
  headerAction(id, label, cx, callback, lit = false) {
    const colors = cx.theme().colors;
    return div().flex_none().when(!lit, el => el.opacity(0)).group_hover("header", el => el.opacity(1))
      .child(button(id, label, callback).size("xsmall").text_color(lit ? colors.primary : colors.muted_foreground));
  }
  focusButton(cx) {
    return this.headerAction("sidebar-focus", this.onlyNeeds ? "Focus on" : "Focus", cx, cx => this.act(cx, async () => {
      this.onlyNeeds = !this.onlyNeeds;
      await store.kvSet("sidebar-focus", JSON.stringify(this.onlyNeeds));
    }), this.onlyNeeds);
  }
  /** A project header as bb draws it: a fold chevron and the name in small muted type, then a needs-you count. */
  projectRow(row, colors, cx) {
    const folded = this.collapsed.has(row.id);
    return h_flex().id(`project:${row.id}`).group("header").w_full().h_7().mt_2().px_2().gap_2().items_center().rounded(cx.theme().radius.md)
      .cursor_pointer().hover(el => el.bg(colors.secondary))
      .on_click((_event, cx) => this.toggle(row.id, this.collapsed, "sidebar")(cx))
      .child(chevron(folded, colors))
      .child(div().flex_1().min_w_0().truncate().text_size(12).font_weight(500).text_color(colors.muted_foreground).child(row.project.name))
      .when(row.needs > 0, el => el.child(badge(row.needs, colors)))
      .child(this.focusButton(cx))
      .child(this.headerAction(`board:${row.id}`, "Board", cx, cx => this.act(cx, () => boardLink(row.project.id))));
  }
  /** "Other threads": the project's threads on no ticket, folded under one heading as in bb. */
  otherRow(row, colors, cx) {
    const folded = this.collapsed.has(row.id);
    return h_flex().id(row.id).w_full().h_7().px_2().pl(`${INDENT}px`).gap_2().items_center().rounded(cx.theme().radius.md)
      .cursor_pointer().hover(el => el.bg(colors.secondary))
      .on_click((_event, cx) => this.toggle(row.id, this.collapsed, "sidebar")(cx))
      .child(chevron(folded, colors))
      .child(div().flex_1().min_w_0().text_size(13).text_color(colors.muted_foreground).child("Other threads"))
      .child(trailing(div().text_size(12).text_color(colors.muted_foreground).child(String(row.count))));
  }
  /** One line: a lead mark, `#N` for a ticket, the title cut with an ellipsis, then counts and hover actions. */
  itemRow(row, threadId, colors, cx) {
    const ticket = row.kind === "ticket" ? row.ticket : null;
    // The row of the thread on screen stays lit, as bb's does; a folded ticket lights when one of its threads is on screen.
    const shown = id => id === threadId || onScreen(id);
    const current = row.id === this.selected
      || (row.thread != null && shown(row.thread.id))
      || (ticket != null && !this.expanded.has(row.id) && (row.threads ?? []).some(t => shown(t.id)));
    const line = h_flex().id(`row:${row.id}`).role("button").accessibility_label(ticket ? `#${ticket.number} ${ticket.title}` : row.thread.title)
      .group("row").relative().w_full().h_7().px_2().pl(`${inset(row.depth)}px`).gap_2().items_center().rounded(cx.theme().radius.md)
      .cursor_pointer().when(current, el => el.bg(colors.accent)).hover(el => el.bg(current ? colors.accent : colors.secondary))
      .on_click((_event, cx) => { this.selected = row.id; this.open(row, cx); });
    line.child(leadMark(row, ticket, colors));
    // The number gets one fixed column, so every title in a project starts at the same edge however many digits it has.
    if (ticket) line.child(div().flex_none().min_w(28).text_size(13).text_color(colors.muted_foreground).child(`#${ticket.number}`));
    line.child(div().flex_1().min_w_0().truncate().text_size(13).text_color(colors.foreground).child(ticket ? ticket.title : row.thread.title));
    if (ticket?.proposed) line.child(pill("Proposed", colors));
    const status = statusMark(row.thread, colors);
    if (status) line.child(trailing(status));
    if ((row.threads?.length ?? 0) > 1) {
      const open = this.expanded.has(row.id);
      line.child(button(`expand:${row.id}`, `${row.threads.length} ${open ? "▾" : "▸"}`, cx => {
        this.expanded.has(row.id) ? this.expanded.delete(row.id) : this.expanded.add(row.id);
        cx.notify();
      }).size("xsmall").text_color(colors.muted_foreground));
    }
    // One quiet "···" on hover, as bb's row has. A replacement sidebar may not open a popup, so it unfolds its few
    // actions in a small list right under the row instead.
    const open = this.menuFor === row.id;
    line.child(div().absolute().top_0().bottom_0().right_0().pl_1().pr_1().flex().items_center().rounded(cx.theme().radius.md)
      .bg(current ? colors.accent : colors.secondary)
      .when(!open, el => el.opacity(0)).group_hover("row", el => el.opacity(1))
      .child(button(`row-menu:${row.id}`, "···", cx => { this.menuFor = open ? null : row.id; cx.notify(); })
        .size("xsmall").text_color(colors.muted_foreground)));
    return line;
  }
  /**
   * The row's actions: what a plugin can do of kagan's own thread menu (Pin, Archive), and Open ticket on board.
   * A ticket pins all its threads, and archives only when it has one, as bb's row menu does.
   */
  rowActions(row) {
    const ticket = row.kind === "ticket" || row.kind === "ticket-thread" ? row.ticket : null;
    const own = row.kind === "ticket" ? (row.threads ?? []) : row.thread ? [row.thread] : [];
    const actions = [];
    if (own.length) {
      const pinned = own.some(thread => thread.pinned);
      actions.push({ id: "pin", label: pinned ? "Unpin" : "Pin", run: () => Promise.all(own.map(thread => threads.setPinned(thread.id, !pinned))) });
    }
    if (own.length === 1) actions.push({ id: "archive", label: "Archive", run: () => threads.archive(own[0].id) });
    if (ticket) actions.push({ id: "board", label: "Open ticket on board", run: () => boardLink(ticket.projectId, ticket.id) });
    return actions;
  }
  /**
   * kagan's thread menu as far as a replacement sidebar may draw it: a right-aligned card with a shadow, full-width
   * items with a hover highlight, and hairlines between groups. It opens under its row, since a popup is not allowed.
   */
  rowMenu(row, colors, cx) {
    const radius = cx.theme().radius;
    const card = v_flex().id(`row-menu-list:${row.id}`).role("menu").w(200).p_1().rounded(radius.md)
      .bg(colors.background).border_1().border_color(colors.border).shadow_lg()
      .on_key_down((event, cx) => { if (event.key === "escape") { this.menuFor = null; cx.stop_propagation(); cx.notify(); } });
    this.rowActions(row).forEach((action, ix) => {
      if (ix > 0) card.child(div().h(1).mx_1().my_1().bg(colors.border));
      card.child(h_flex().id(`row-action:${action.id}:${row.id}`).role("menu_item").accessibility_label(action.label)
        .h_7().px_2().items_center().rounded(radius.sm).cursor_pointer().hover(el => el.bg(colors.secondary))
        .on_click((_event, cx) => {
          cx.stop_propagation();
          this.menuFor = null;
          this.act(cx, async () => { await action.run(); store.touch(); });
        })
        .child(div().text_size(13).text_color(colors.foreground).child(action.label)));
    });
    return h_flex().w_full().justify_end().px_1().pb_1().child(card);
  }
  onKey(event, rows, cx) {
    if (!rows.length) return;
    const found = rows.findIndex(r => r.id === this.selected);
    const ix = found === -1 ? 0 : found;
    if (event.key === "down" || event.key === "up") this.selected = rows[Math.max(0, Math.min(rows.length - 1, found + (event.key === "down" ? 1 : -1)))]?.id;
    else if (event.key === "enter" && rows[ix]) return this.open(rows[ix], cx);
    else if (event.key === "n") {
      const need = [...rows.slice(ix + 1), ...rows.slice(0, ix + 1)].find(r => r.needs && !r.project);
      if (need) { this.selected = need.id; return this.open(need, cx); }
    } else if (["left", "right"].includes(event.key) && rows[ix]?.ticket) {
      event.key === "right" ? this.expanded.add(rows[ix].ticket.id) : this.expanded.delete(rows[ix].ticket.id);
    } else return;
    cx.notify();
  }
  render(cx) {
    const threadId = host.context().threadId;
    const all = withOtherThreads(this.rows(), this.collapsed);
    const rows = this.onlyNeeds
      ? all.filter(row => row.project || row.kind === "other" || row.needs || row.pinned || (threadId != null && row.thread?.id === threadId))
      : all;
    const colors = cx.theme().colors;
    const draw = row => row.project ? this.projectRow(row, colors, cx) : row.kind === "other" ? this.otherRow(row, colors, cx) : this.itemRow(row, threadId, colors, cx);
    const drawn = rows.flatMap(row => this.menuFor === row.id ? [draw(row), this.rowMenu(row, colors, cx)] : [draw(row)]);
    return v_flex().size_full().min_h_0().track_focus(this.listFocus).tab_stop(true)
      .on_hover((hover, cx) => { this.frozen = hover ? rows.map(r => r.id) : []; cx.notify(); })
      .on_key_down((event, cx) => this.onKey(event, rows.filter(r => r.kind !== "other"), cx))
      .child(this.error ? tiny(this.error, cx).px_2() : "")
      .child(new Scroll(this.scroll).flex_1().min_h_0().child(v_flex().id("kanban-sidebar").gap(1).px_1().children(drawn)));
  }
}

/** Whether the window shows this thread now; false when the host cannot say. */
function onScreen(threadId) {
  try { return host.threadOnScreen(threadId); } catch { return false; }
}

const INDENT = 12;
const MAX_DEPTH = 3;
/** bb's indent: twelve pixels a level, at most three levels deep. */
function inset(depth) {
  return Math.min(1 + depth, MAX_DEPTH) * INDENT;
}

/**
 * Moves each project's threads on no ticket under one "Other threads" heading after its tickets, as bb lists them.
 * A folded heading hides them; its id is kept in the same folded set as the projects.
 */
export function withOtherThreads(rows, collapsed) {
  const out = [];
  let loose = [];
  let projectId = null;
  const flush = () => {
    if (!loose.length) return;
    const id = `other:${projectId}`;
    out.push({ kind: "other", id, count: loose.length, depth: 0 });
    if (!collapsed.has(id)) out.push(...loose);
    loose = [];
  };
  for (const row of rows) {
    if (row.project) { flush(); projectId = row.id; out.push(row); }
    else if (row.kind === "thread" && row.depth === 0) loose.push(row);
    else out.push(row);
  }
  flush();
  return out;
}

/** A ticket shows its stage circle; a thread shows the mark of the agent it runs, as bb does. */
function leadMark(row, ticket, colors) {
  const box = div().w(16).h(16).flex_none().flex().items_center().justify_center();
  if (ticket) return box.child(stageGlyph(ticket.stage, colors));
  // `agent` is the short program name kagan hands plugins (never the full line); older hosts send nothing.
  const mark = agentMark(/** @type {any} */ (row.thread)?.agent);
  if (mark) return box.child(svg(mark).w(14).h(14).text_color(colors.muted_foreground));
  // A thread with no known agent keeps a small drawn ring in the same slot, so every title starts at one edge.
  return box.child(row.kind === "ticket-thread"
    ? div().w(4).h(4).rounded(2).bg(colors.muted_foreground)
    : div().w(7).h(7).rounded(4).border_1().border_color(colors.muted_foreground));
}

/**
 * bb's stage circles, drawn rather than typed so each is the same size and weight: a dashed ring for Backlog, a ring
 * with its left half filled for In progress, a ring around a dot for Review, a full disc for Done.
 */
export function stageGlyph(stage, colors) {
  const quiet = stage === "backlog";
  const tone = quiet ? colors.muted_foreground : colors.foreground;
  const ring = div().relative().w(12).h(12).rounded(6).border_1().border_color(tone).flex().items_center().justify_center();
  if (stage === "backlog") return ring.border_dashed();
  if (stage === "in-progress") return ring.child(div().absolute().top(1).left(1).w(4).h(8).rounded_tl(4).rounded_bl(4).bg(tone));
  if (stage === "review") return ring.child(div().w(6).h(6).rounded(3).bg(tone));
  return div().w(12).h(12).rounded(6).bg(tone);
}

/**
 * A thread's state in one small mark, as bb's row draws it: a spinner while it works, a red mark when it failed, a
 * dot when it has a reply you have not read. Idle stays quiet.
 */
function statusMark(thread, colors) {
  if (!thread) return null;
  const box = div().w(14).h(14).flex_none().flex().items_center().justify_center();
  if (thread.status === "starting" || isBusy(thread.id)) return box.child(new Spinner().size("xsmall").color(colors.muted_foreground));
  if (thread.status === "error") return box.text_size(12).font_weight(700).text_color(colors.destructive).child("!");
  if ((thread.lastReadAt ?? 0) < (thread.latestAttentionAt ?? 0)) return box.child(div().w(6).h(6).rounded(3).bg(colors.primary));
  return null;
}

/** A fold arrow in a fixed 16px slot, centred, so headers and rows share one left edge. */
function chevron(folded, colors) {
  return div().w(16).h(16).flex_none().flex().items_center().justify_center().text_size(9).text_color(colors.muted_foreground).child(folded ? "▸" : "▾");
}

/** The row's right column: one fixed slot, right-aligned, so counts and marks line up down the list. */
function trailing(child) {
  return div().w(20).h(16).flex_none().flex().items_center().justify_end().child(child);
}

function badge(count, colors) {
  return div().flex_none().min_w(16).h(16).px_1().rounded(8).bg(colors.primary).text_color(colors.primary_foreground)
    .text_size(10).font_weight(600).flex().items_center().justify_center().child(String(count));
}

function pill(label, colors) {
  return div().flex_none().px_1().rounded(4).bg(colors.muted).text_size(10).font_weight(500).text_color(colors.primary).child(label);
}
