// @ts-check
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { Scroll, ThreadStatus } from "gpui-component";
import * as host from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import { GLYPHS, NEXT, TITLES, sidebarRows } from "./model.js";
import { WatchedView, boardLink, button, chip, followContext, requestBoardMove, requestBoardStart, tiny } from "./ui.js";

function glyphTone(stage, colors) {
  return stage === "backlog" ? colors.muted_foreground : colors.foreground;
}

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
  focusButton(cx) {
    return button("sidebar-focus", this.onlyNeeds ? "Show all" : "Focus", cx => this.act(cx, async () => {
      this.onlyNeeds = !this.onlyNeeds;
      await store.kvSet("sidebar-focus", JSON.stringify(this.onlyNeeds));
    })).text_size(11).tooltip("Only what needs you, pinned rows, and the open thread");
  }
  projectRow(row, colors, cx) {
    return h_flex().w_full().h_7().px_2().gap_1().items_center()
      .child(button(`collapse:${row.id}`, this.collapsed.has(row.id) ? "▸" : "▾", this.toggle(row.id, this.collapsed, "sidebar")).text_size(11))
      .child(button(`project:${row.id}`, row.project.name, cx => this.open(row, cx)).flex_1().text_size(12))
      .when(row.needs > 0, el => el.child(tiny(String(row.needs), cx, colors.primary).font_weight(600)))
      .child(button(`board:${row.id}`, "▦", cx => this.act(cx, () => boardLink(row.project.id))).tooltip("Open board"));
  }
  /** A ticket row, its thread row, or a loose thread: one shape, different tail actions. */
  itemRow(row, threadId, colors, cx) {
    const ticket = row.kind === "ticket" ? row.ticket : null;
    const line = h_flex().w_full().min_h(30).flex_wrap().items_center().gap_1().px_2().py_1().pl(`${(row.depth + 1) * 0.75}rem`)
      .bg(row.id === this.selected || row.thread?.id === threadId ? colors.selection : colors.background);
    line.child(div().text_size(12).text_color(ticket ? glyphTone(ticket.stage, colors) : colors.muted_foreground)
      .child(ticket ? GLYPHS[ticket.stage] ?? "○" : "○"));
    if (ticket) line.child(tiny(`#${ticket.number}`, cx));
    const title = ticket ? `#${ticket.number} ${ticket.title}` : row.thread.title;
    line.child(div().flex_1().min_w_0().overflow_hidden().child(button(`row:${row.id}`, title, cx => { this.selected = row.id; this.open(row, cx); })));
    if (row.thread) line.child(new ThreadStatus(row.thread.id));
    if (ticket?.proposed) line.child(chip("Proposed", cx));
    if ((row.threads?.length ?? 0) > 1) line.child(button(`expand:${row.id}`, `${row.threads.length}`, cx => {
      this.expanded.has(row.id) ? this.expanded.delete(row.id) : this.expanded.add(row.id);
      cx.notify();
    }).tooltip(`${row.threads.length} threads`));
    this.rowTail(row, ticket, line, cx);
    return line;
  }
  rowTail(row, ticket, line, cx) {
    if (ticket && !row.thread) line.child(button(`board-ticket:${row.id}`, "Board", cx => this.act(cx, () => boardLink(ticket.projectId, ticket.id))).text_size(11));
    if (ticket && !ticket.proposed) {
      line.child(button(`open-ticket:${row.id}`, "Ticket", cx => this.act(cx, () => boardLink(ticket.projectId, ticket.id))).text_size(11));
      const next = NEXT[ticket.stage];
      if (next) line.child(button(`move-ticket:${row.id}:${next}`, `→ ${TITLES[next]}`, cx => this.act(cx, () => requestBoardMove(ticket, next))).text_size(11).tooltip(`Move to ${TITLES[next]}`));
      line.child(button(`start-ticket:${row.id}`, "Start", cx => this.act(cx, () => requestBoardStart(ticket))).text_size(11));
    }
    if (row.thread && row.kind !== "ticket") line.child(button(`archive:${row.id}`, "Archive", cx => this.act(cx, async () => { await threads.archive(row.thread.id); store.touch(); })).text_size(11));
    if (row.thread && !row.ticket) line.child(button(`newtkt:${row.id}`, "Ticket", cx => this.act(cx, () => store.createTicket({ projectId: row.thread.projectId, title: row.thread.title, threadId: row.thread.id }))).text_size(11));
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
    const all = this.rows();
    const rows = this.onlyNeeds
      ? all.filter(row => row.project || row.needs || row.pinned || (threadId != null && row.thread?.id === threadId))
      : all;
    const quiet = this.onlyNeeds ? all.length - rows.length : 0;
    const colors = cx.theme().colors;
    return v_flex().size_full().min_h_0().track_focus(this.listFocus).tab_stop(true)
      .on_hover((hover, cx) => { this.frozen = hover ? rows.map(r => r.id) : []; cx.notify(); })
      .on_key_down((event, cx) => this.onKey(event, rows, cx))
      .child(this.error ? tiny(this.error, cx).px_2() : "")
      .child(h_flex().px_2().py_1().items_center().child(this.focusButton(cx)))
      .child(quiet ? tiny(`${quiet} quiet`, cx).px_2() : "")
      .child(new Scroll(this.scroll).flex_1().min_h_0().child(v_flex().id("kanban-sidebar").children(
        rows.map(row => row.project ? this.projectRow(row, colors, cx) : this.itemRow(row, threadId, colors, cx)),
      )));
  }
}
