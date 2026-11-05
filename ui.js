// @ts-check
import { View, div } from "gpui-kit";
import { KgButton, ScrollbarHandle, Select } from "gpui-component";
import * as host from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import * as boardData from "./board-data.js";

export const HANDING_OFF = new Set(["handing-off", "running"]);
export const STATUS_WORD = { error: "Failed", unread: "New reply" };

export function clickCx(a, b) { return b ?? a; }
export function button(id, label, callback) {
  return new KgButton(id).label(label).ghost().compact().on_click((a, b) => callback(clickCx(a, b)));
}
export function primary(id, label, callback) {
  return new KgButton(id).label(label).primary().compact().on_click((a, b) => callback(clickCx(a, b)));
}
export function outline(id, label, callback) {
  return new KgButton(id).label(label).outline().compact().on_click((a, b) => callback(clickCx(a, b)));
}
export function muted(message, cx) {
  return div().text_color(cx.theme().colors.muted_foreground).text_size(12).child(message);
}
export function tiny(message, cx, color) {
  return div().text_color(color ?? cx.theme().colors.muted_foreground).text_size(11).child(message);
}
export function chip(label, cx, color) {
  const colors = cx.theme().colors;
  return div().px_1().rounded(cx.theme().radius.sm).border_1().border_color(colors.border)
    .text_size(11).text_color(color ?? colors.muted_foreground).child(label);
}
export function dot(cx, color) {
  return div().w(6).h(6).rounded(3).bg(color);
}
export function select(id, rows, label, callback) {
  return new Select(id, () => rows, row => div().child(String(/** @type {{label: string}} */ (row).label)), callback).placeholder(label);
}
export function boardLink(projectId, ticketId) { return host.openPanel("board", { projectId, ticketId }); }
export function requestBoardMove(ticket, stage) {
  return host.openPanel("board", { projectId: ticket.projectId, ticketId: ticket.id, move: stage, moveAt: Date.now() });
}
export function requestBoardStart(ticket) {
  return host.openPanel("board", { projectId: ticket.projectId, ticketId: ticket.id, start: true, startAt: Date.now() });
}
export function followContext(cx) { return cx.spawn(async cx => { for (;;) { await host.onContextChanged(); cx.notify(); } }); }
export function divider(colors) {
  return div().h(1).w_full().bg(colors.border);
}
/** Focus is best effort: the control may mount a frame later, or Escape may have closed it first. */
export function focusWhenMounted(handle, onMiss = () => undefined) {
  try { handle.focus(); } catch (error) { onMiss(error); }
}
export class WatchedView extends View {
  init(_props, cx) {
    this.error = "";
    this.busy = false;
    this.data = { tickets: [], loose: [] };
    this.projects = [];
    this.scroll = ScrollbarHandle();
    // The board owns these; the base only uses them for a best-effort refocus after an action.
    this.composerFocus ??= null;
    this.refocusComposer ??= false;
    this.watch = cx.spawn(async cx => {
      let generation = store.currentGeneration();
      await this.refresh();
      cx.notify();
      for (;;) {
        generation = await store.nextChange(generation);
        await this.refresh();
        cx.notify();
      }
    });
  }
  async refresh() {
    try {
      this.projects = await threads.projects();
      this.data = await boardData.board(this.projects.map(p => p.id));
      this.error = "";
    } catch (error) { this.error = String(error); }
  }
  act(cx, fn) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.note = "";
    cx.notify();
    cx.spawn(async cx => {
      try { await fn(); await this.refresh(); }
      catch (error) { this.error = String(error); }
      finally {
        this.busy = false;
        cx.notify();
        if (this.refocusComposer) {
          this.refocusComposer = false;
          focusWhenMounted(this.composerFocus);
        }
      }
    });
  }
  render(cx) { return muted(this.error, cx); }
}

