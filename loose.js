// @ts-check
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { DropdownMenu, Scroll, ThreadStatus } from "gpui-component";
import * as host from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import { dropOnLoose } from "./model.js";
import { button, tiny } from "./ui.js";

export function renderLoose(view, cx, colors, radius, loose) {
    const active = view.over?.id === "loose";
    const column = v_flex().id("loose").flex_1().min_w("16rem").max_w("16rem").min_h_0().rounded(radius.lg)
      .border_1().border_dashed().border_color(active ? colors.ring : colors.border)
      .when(active, el => el.bg(colors.selection));
    view.dropTarget(column, "loose", payload => dropOnLoose(payload, view.data.tickets));
    const heading = h_flex().gap_2().px_3().pt_2().pb_1().items_baseline().justify_between()
      .child(h_flex().gap_2().items_baseline()
        .child(div().font_weight(600).text_size(12).child("Loose threads"))
        .child(tiny(String(loose.length), cx)))
      .child(button("loose-close", "Hide", cx => view.act(cx, async () => { view.looseOpen = false; await view.remember(); })));
    const body = v_flex().gap_1().px_2().pb_2()
      .child(tiny("Not on a ticket yet. Drag one onto a ticket or a column.", cx).px_1());
    for (const thread of loose.slice(0, view.looseLimit)) {
      const dragged = view.drag?.kind === "thread" && view.drag.id === thread.id;
      const row = view.dragSource(h_flex().id(`thread:${thread.id}`).gap_2().items_center().flex_wrap().px_2().py_1().rounded(radius.sm).when(dragged, el => el.opacity(0.4)), "thread", thread.id);
      const menu = new DropdownMenu(`loose-menu:${thread.id}`, "···")
        .item("Open thread", cx => view.act(cx, () => host.openThread(thread.id)))
        .item("New ticket", cx => view.act(cx, () => store.createTicket({ projectId: thread.projectId, title: thread.title, threadId: thread.id, kind: "story" })))
        .item("In progress", cx => view.act(cx, () => store.createTicket({ projectId: thread.projectId, title: thread.title, threadId: thread.id, stage: "in-progress", kind: "story" })))
        .item("Add to ticket…", () => view.attachDialog(thread.projectId, thread.id))
        .item("Archive thread", cx => view.act(cx, async () => { await threads.archive(thread.id); store.touch(); }));
      row.child(new ThreadStatus(thread.id))
        .child(button(`loose-open:${thread.id}`, thread.title, cx => view.act(cx, () => host.openThread(thread.id))).flex_1().min_w_0())
        .child(menu);
      body.child(row);
    }
    if (!loose.length) body.child(v_flex().py_6().items_center().child(tiny(view.drag?.kind === "thread" ? "Drop to take it off its ticket" : "Every thread is on a ticket", cx)));
    else if (loose.length > view.looseLimit) body.child(button("more-loose", `Show ${loose.length - view.looseLimit} more`, cx => { view.looseLimit += 20; cx.notify(); }));
    column.child(heading).child(new Scroll(view.scroll).flex_1().min_h_0().child(body));
    return column;
  }
