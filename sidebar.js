// @ts-check
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { Scroll, Spinner } from "gpui-component";
import * as host from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import { GLYPHS, NEXT, TITLES, sidebarRows } from "./model.js";
import { WatchedView, boardLink, button, followContext, requestBoardMove, requestBoardStart, tiny } from "./ui.js";
import { agentMark } from "./agents.js";
import { isBusy } from "./busy.js";

export class SidebarList extends WatchedView {
  init(props, cx) {
    this.expanded = new Set();
    this.collapsed = new Set();
    this.onlyNeeds = false;
    this.frozen = [];
    this.selected = null;
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
      .child(div().w(16).flex_none().text_size(11).text_color(colors.muted_foreground).child(folded ? "›" : "⌄"))
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
      .child(div().w(16).flex_none().text_size(11).text_color(colors.muted_foreground).child(folded ? "›" : "⌄"))
      .child(div().flex_1().min_w_0().text_size(13).text_color(colors.muted_foreground).child("Other threads"))
      .child(div().flex_none().text_size(12).text_color(colors.muted_foreground).child(String(row.count)));
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
    if (ticket) line.child(div().flex_none().text_size(13).text_color(colors.muted_foreground).child(`#${ticket.number}`));
    line.child(div().flex_1().min_w_0().truncate().text_size(13).text_color(colors.foreground).child(ticket ? ticket.title : row.thread.title));
    if (ticket?.proposed) line.child(pill("Proposed", colors));
    const status = statusMark(row.thread, colors);
    if (status) line.child(status);
    if ((row.threads?.length ?? 0) > 1) {
      const open = this.expanded.has(row.id);
      line.child(button(`expand:${row.id}`, `${row.threads.length} ${open ? "⌄" : "›"}`, cx => {
        this.expanded.has(row.id) ? this.expanded.delete(row.id) : this.expanded.add(row.id);
        cx.notify();
      }).size("xsmall").text_color(colors.muted_foreground));
    }
    // The actions float over the row's right end on hover, so a quiet row gives its title the full width.
    const tail = h_flex().absolute().top_0().bottom_0().right_0().pl_2().pr_1().gap_1().items_center()
      .rounded(cx.theme().radius.md).bg(current ? colors.accent : colors.secondary).opacity(0).group_hover("row", el => el.opacity(1));
    this.rowTail(row, ticket, tail, cx);
    return line.child(tail);
  }
  rowTail(row, ticket, line, cx) {
    const small = (id, label, callback) => button(id, label, callback).size("xsmall").text_color(cx.theme().colors.muted_foreground);
    if (ticket?.proposed && !row.thread) line.child(small(`board-ticket:${row.id}`, "Board", cx => this.act(cx, () => boardLink(ticket.projectId, ticket.id))));
    if (ticket && !ticket.proposed) {
      const next = NEXT[ticket.stage];
      if (next) line.child(small(`move-ticket:${row.id}:${next}`, `→ ${TITLES[next]}`, cx => this.act(cx, () => requestBoardMove(ticket, next))));
      line.child(small(`start-ticket:${row.id}`, "Start", cx => this.act(cx, () => requestBoardStart(ticket))));
      line.child(small(`open-ticket:${row.id}`, "Ticket", cx => this.act(cx, () => boardLink(ticket.projectId, ticket.id))));
    }
    if (row.thread && !row.ticket) line.child(small(`newtkt:${row.id}`, "New ticket", cx => this.act(cx, () => store.createTicket({ projectId: row.thread.projectId, title: row.thread.title, threadId: row.thread.id }))));
    if (row.thread && row.kind !== "ticket") line.child(small(`archive:${row.id}`, "Archive", cx => this.act(cx, async () => { await threads.archive(row.thread.id); store.touch(); })));
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
    return v_flex().size_full().min_h_0().track_focus(this.listFocus).tab_stop(true)
      .on_hover((hover, cx) => { this.frozen = hover ? rows.map(r => r.id) : []; cx.notify(); })
      .on_key_down((event, cx) => this.onKey(event, rows.filter(r => r.kind !== "other"), cx))
      .child(this.error ? tiny(this.error, cx).px_2() : "")
      .child(new Scroll(this.scroll).flex_1().min_h_0().child(v_flex().id("kanban-sidebar").gap(1).px_1().children(rows.map(draw))));
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
    if (!collapsed.has(id)) out.push(...loose.map(row => ({ ...row, depth: row.depth + 1 })));
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
  if (ticket) return box.text_size(13).text_color(ticket.stage === "backlog" ? colors.muted_foreground : colors.foreground).child(GLYPHS[ticket.stage] ?? "○");
  // `agent` is the short program name kagan hands plugins (never the full line); older hosts send nothing.
  const mark = agentMark(/** @type {any} */ (row.thread)?.agent);
  if (mark) return box.child(svg(mark).w(14).h(14).text_color(colors.muted_foreground));
  return box.text_size(10).text_color(colors.muted_foreground).child(row.kind === "ticket-thread" ? "•" : "○");
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

function badge(count, colors) {
  return div().flex_none().min_w(16).h(16).px_1().rounded(8).bg(colors.primary).text_color(colors.primary_foreground)
    .text_size(10).font_weight(600).flex().items_center().justify_center().child(String(count));
}

function pill(label, colors) {
  return div().flex_none().px_1().rounded(4).bg(colors.muted).text_size(10).font_weight(500).text_color(colors.primary).child(label);
}
