// @ts-check
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { Button, KgButton, DropdownMenu, Input, InputState, Textarea, TextareaState, Scroll, ScrollbarHandle, Select, Markdown, ThreadStatus } from "gpui-component";
import * as host from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import * as handoff from "./handoff.js";
import * as github from "./github.js";
import { listPersonas } from "./personas.js";
import { STAGES, TITLES, PERSONAS, GLYPHS, NEXT, needsYou, matches, sidebarRows, AGE_WARN_DAYS, isGated, startProblem, daysInStage, sortColumn, openBlockers, canBlock, subTicketLine, threadStatusLine, criteriaLine, rankOrder, looksLikeUserStory, USER_STORY_WARNING, KINDS, dropOnCard, dropOnColumn, dropOnLoose, threadMatches } from "./model.js";

function clickCx(a, b) { return b ?? a; }
function button(id, label, callback) {
  return new KgButton(id).label(label).ghost().compact().on_click((a, b) => callback(clickCx(a, b)));
}
function primary(id, label, callback) {
  return new KgButton(id).label(label).primary().compact().on_click((a, b) => callback(clickCx(a, b)));
}
function muted(message, cx) {
  return div().text_color(cx.theme().colors.muted_foreground).text_size(12).child(message);
}
function chip(label, cx, color) {
  const colors = cx.theme().colors;
  return div().px_1().rounded(cx.theme().radius.sm).border_1().border_color(colors.border)
    .text_size(11).text_color(color ?? colors.muted_foreground).child(label);
}
function select(id, rows, label, callback) {
  return new Select(id, () => rows, row => div().child(String(/** @type {{label: string}} */ (row).label)), callback).placeholder(label);
}
function boardLink(projectId, ticketId) { return host.openPanel("board", { projectId, ticketId }); }
function followContext(cx) { return cx.spawn(async cx => { for (;;) { await host.onContextChanged(); cx.notify(); } }); }

class WatchedView extends View {
  init(_props, cx) {
    this.error = "";
    this.busy = false;
    this.data = { tickets: [], loose: [] };
    this.projects = [];
    this.scroll = ScrollbarHandle();
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
      this.data = await store.board(this.projects.map(p => p.id));
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
          try { this.composerFocus.focus(); } catch { /* The field closes when Escape won the race. */ }
        }
      }
    });
  }
  render(cx) { return muted(this.error, cx); }
}

export class BoardPanel extends WatchedView {
  init(props, cx) {
    this.projectId = host.context().projectId;
    this.ticketId = null;
    this.ticket = null;
    this.shown = new Set();
    this.search = InputState("Search");
    this.formFocus = cx.focus_handle();
    this.boardFocus = cx.focus_handle();
    this.searchFocus = cx.focus_handle();
    this.composerFocus = cx.focus_handle();
    this.jumpFocus = cx.focus_handle();
    this.composer = InputState("Ticket title, then Enter");
    this.composerOpen = false;
    this.warnDays = InputState("14");
    this.wipLimit = InputState("Off");
    this.ruleMap = new Map();
    this.note = "";
    this.fields = 0;
    this.refocusComposer = false;
    this.jumpIndex = -1;
    this.jumpId = null;
    this.title = InputState("Ticket title");
    this.description = TextareaState();
    this.comment = TextareaState();
    this.prompt = TextareaState();
    this.repo = InputState("owner/name");
    this.issueQuery = InputState("Search open issues");
    this.issueFilters = { label: "", assignee: "", author: "" };
    this.repos = [];
    this.issues = [];
    this.personas = [];
    this.persona = "";
    this.form = null;
    this.looseOpen = false;
    this.doneLimit = 5;
    this.drag = null;
    this.over = null;
    this.openThreads = new Set();
    this.columns = STAGES.map(() => ScrollbarHandle());
    this.pendingMove = null;
    this.sourceIds = new Set();
    const typing = (state) => {
      state.on("focus", () => { this.fields += 1; });
      state.on("blur", () => { this.fields = Math.max(0, this.fields - 1); });
    };
    for (const state of [this.search, this.composer, this.title, this.repo, this.issueQuery, this.warnDays, this.wipLimit, this.description, this.comment, this.prompt]) typing(state);
    this.composer.on("submit", (_event, cx) => this.submitComposer(cx));
    super.init(props, cx);
    this.contextTask = cx.spawn(async cx => {
      const state = await store.kvJson("board", {});
      this.projectId ??= state.projectId;
      this.looseOpen = Boolean(state.looseOpen);
      if (Array.isArray(state.shown)) this.shown = new Set(state.shown.filter(id => typeof id === "string"));
      this.applyContext(host.context());
      await this.refresh();
      this.consumeMove(cx);
      cx.notify();
      for (;;) {
        this.applyContext(await host.onContextChanged());
        await this.refresh();
        this.consumeMove(cx);
        cx.notify();
      }
    });
  }
  applyContext(context) {
    const props = context.props;
    if (props?.projectId) this.projectId = props.projectId;
    if (props && Object.hasOwn(props, "ticketId")) this.ticketId = props.ticketId ?? null;
    const request = props?.move ? `${props.ticketId}:${props.move}` : null;
    if (request !== this.lastMoveRequest) { this.requestedMove = props?.move; this.lastMoveRequest = request; }
  }
  consumeMove(cx) {
    if (this.requestedMove && this.ticket) { const stage = this.requestedMove; this.requestedMove = null; this.move(this.ticket, stage, cx); }
  }
  async refresh() {
    await super.refresh();
    if (!this.projects.some(p => p.id === this.projectId)) this.projectId = this.projects[0]?.id;
    if (this.ticketId) {
      this.ticket = await store.detail(this.ticketId).catch(() => null);
      if (!this.ticket) this.ticketId = null;
    }
    if (this.projectId) this.repos = await store.listRepos(this.projectId);
    const ids = [...new Set([this.projectId, ...this.shown, ...this.data.tickets.map(t => t.projectId)].filter(Boolean))];
    this.ruleMap = new Map();
    for (const id of ids) this.ruleMap.set(id, await store.boardRules(id));
  }
  onBoard(ticket) {
    return ticket.projectId === this.projectId || this.shown.has(ticket.projectId);
  }
  ticketsIn(stage, filtered = true) {
    const own = this.data.tickets.filter(t => this.onBoard(t) && t.stage === stage && (!filtered || matches(t, this.search.value())));
    return sortColumn(own, stage, this.projectId, [...this.shown]);
  }
  waitingTickets() {
    return STAGES.flatMap(stage => this.ticketsIn(stage, false).filter(needsYou));
  }
  jumpToNext(cx) {
    const waiting = this.waitingTickets();
    if (!waiting.length) return;
    this.jumpIndex = (this.jumpIndex + 1) % waiting.length;
    const target = waiting[this.jumpIndex];
    this.jumpId = target.id;
    this.ticketId = null;
    this.form = null;
    if (!matches(target, this.search.value())) this.search.set_value("");
    if (target.stage === "done") {
      const index = this.ticketsIn("done", false).findIndex(t => t.id === target.id);
      if (index >= this.doneLimit) this.doneLimit = index + 1;
    }
    cx.notify();
    cx.spawn(async () => { try { this.jumpFocus.focus(); } catch { /* The highlight is the jump when the card is not mounted yet. */ } });
  }
  submitComposer(cx) {
    const title = this.composer.value().trim();
    if (!title) return;
    if (title.length > 200) { this.error = "Title must contain 1–200 characters"; cx.notify(); return; }
    this.composerOpen = true;
    this.refocusComposer = true;
    this.act(cx, async () => {
      await store.createTicket({ projectId: this.projectId, title, kind: "story" });
      this.composer.set_value("");
      this.composerOpen = true;
      this.refocusComposer = true;
    });
  }
  openLoose(cx) {
    const next = this.ticketId ? true : !this.looseOpen;
    this.ticketId = null;
    this.form = null;
    this.looseOpen = next;
    this.act(cx, () => this.remember());
  }
  openRules(cx) {
    const rules = this.ruleMap.get(this.projectId) ?? { ageWarnDays: AGE_WARN_DAYS, wipLimit: null };
    this.warnDays.set_value(String(rules.ageWarnDays));
    this.wipLimit.set_value(rules.wipLimit == null ? "" : String(rules.wipLimit));
    this.form = "rules";
    cx.notify();
    cx.spawn(async () => { try { this.formFocus.focus(); } catch { /* The form is mounted on the next frame. */ } });
  }
  attentionButtons() {
    const row = h_flex().gap_2().items_center();
    const need = this.waitingTickets();
    const looseCount = this.data.loose.filter(t => t.projectId === this.projectId || this.shown.has(t.projectId)).length;
    if (need.length) {
      const word = need.length === 1 ? "needs" : "need";
      row.child(button("next-needs", `${need.length} ${word} you`, cx => this.jumpToNext(cx)).tooltip("Jump to the next one. Press N."));
    }
    if (looseCount || this.looseOpen) row.child(button("loose-toggle", `${looseCount} loose`, cx => this.openLoose(cx)).tooltip("Show threads on no ticket"));
    return row;
  }
  finishMove(cx, id, stage, resolution) {
    this.act(cx, async () => {
      const moved = await store.moveTicket(id, stage, resolution);
      if (moved && typeof moved.warning === "string") this.note = moved.warning;
    });
  }
  rankAgainst(ticket, side) {
    const peers = this.data.tickets.filter(p => p.projectId === ticket.projectId && p.stage === "backlog" && p.id !== ticket.id).sort(rankOrder);
    const word = side === "before" ? "above" : "below";
    window.open_dialog(() => {
      const dialog = v_flex().gap_3()
        .child(`Rank #${ticket.number} ${word} another ticket in this project.`);
      if (peers.length) dialog.child(select(`rank-${side}:${ticket.id}`, peers.map(p => ({ id: p.id, label: `#${p.number} ${p.title}` })), "Choose a ticket", (id, cx) => {
        window.close_dialog();
        this.act(cx, () => store.rankTicket(ticket.id, side === "before" ? { before: id } : { after: id }));
      }));
      else dialog.child("No other Backlog ticket in this project.");
      return dialog.child(button(`cancel-rank:${ticket.id}`, "Cancel", () => window.close_dialog()));
    });
  }
  pickParent(ticket) {
    const peers = this.data.tickets.filter(p => p.id !== ticket.id && p.projectId === ticket.projectId && !p.proposed);
    window.open_dialog(() => v_flex().gap_3()
      .child(`Set the parent of #${ticket.number}.`)
      .child(select(`parent-pick:${ticket.id}`, [{ id: "none", label: "No parent" }, ...peers.map(p => ({ id: p.id, label: `#${p.number} ${p.title}` }))], "Choose a parent", (id, cx) => {
        window.close_dialog();
        this.act(cx, () => store.setParent(ticket.id, id === "none" ? null : id));
      }))
      .child(button(`cancel-parent:${ticket.id}`, "Cancel", () => window.close_dialog())));
  }
  remember() { return store.kvSet("board", JSON.stringify({ projectId: this.projectId, looseOpen: this.looseOpen, shown: [...this.shown] })); }
  dragSource(el, kind, id) {
    return el.on_drag(`${kind}:${id}`, (event, cx) => {
      if (event.phase === "started") this.drag = { kind, id };
      else { this.drag = null; this.over = null; }
      cx.notify();
    });
  }
  hear(id, decision, event, cx) {
    if (!event.side) {
      if (this.over?.id === id) { this.over = null; cx.notify(); }
      return;
    }
    const label = decision?.label ?? "";
    if (this.over?.id === id && this.over.side === event.side && this.over.label === label) return;
    this.over = label ? { id, side: event.side, label } : null;
    cx.notify();
  }
  dropTarget(el, id, decide) {
    return el
      .on_drag_move((event, cx) => this.hear(id, decide(event.payload, event.side), event, cx))
      .on_drop((event, cx) => {
        const decision = decide(event.payload, event.side);
        this.drag = null;
        this.over = null;
        cx.notify();
        this.applyDrop(decision, cx);
      });
  }
  threadRecord(id) {
    for (const ticket of this.data.tickets) {
      const thread = ticket.threads.find(item => item.id === id);
      if (thread) return thread;
    }
    return this.data.loose.find(thread => thread.id === id) ?? null;
  }
  applyDrop(decision, cx) {
    if (!decision || decision.action === "ignore") return;
    if (decision.action === "refuse") { this.error = decision.reason; cx.notify(); return; }
    if (decision.action === "move") {
      const ticket = this.data.tickets.find(item => item.id === decision.id);
      if (ticket) this.move(ticket, decision.stage, cx);
      return;
    }
    if (decision.action === "rank") { this.act(cx, () => store.rankTicket(decision.id, decision.place)); return; }
    if (decision.action === "nest") { this.act(cx, () => store.setParent(decision.id, decision.parentId)); return; }
    if (decision.action === "attach") { this.act(cx, () => store.attach(decision.ticketId, decision.threadId)); return; }
    if (decision.action === "detach") { this.act(cx, () => store.detach(decision.threadId)); return; }
    if (decision.action === "create") {
      const thread = this.threadRecord(decision.threadId);
      if (!thread) { this.error = "That thread is gone"; cx.notify(); return; }
      this.act(cx, () => store.createTicket({ projectId: thread.projectId, title: thread.title, threadId: thread.id, stage: decision.stage, kind: "story" }));
    }
  }
  looseThreads() {
    return this.data.loose.filter(thread => (thread.projectId === this.projectId || this.shown.has(thread.projectId)) && threadMatches(thread, this.search.value()));
  }
  openTicket(id, cx) {
    this.form = null;
    this.act(cx, async () => { this.ticketId = id; this.ticket = await store.detail(id); });
  }
  async prepare(form, ticket) {
    this.form = form;
    this.personas = await listPersonas();
    this.persona = this.personas.includes(PERSONAS[ticket?.stage ?? "backlog"]) ? PERSONAS[ticket?.stage ?? "backlog"] : "";
    this.prompt.set_value("");
    this.sourceIds = new Set(ticket?.threads.map(t => t.id) ?? []);
    if (form === "handoff") this.sourceIds = new Set(ticket?.threads.slice(0, 1).map(t => t.id));
  }
  move(ticket, stage, cx, resolution = "done") {
    if (ticket.stage === stage && (stage !== "done" || (ticket.resolution ?? "done") === resolution)) return;
    const problem = isGated(ticket.stage, stage, resolution) ? startProblem(ticket) : null;
    if (problem) {
      this.error = `Can't start #${ticket.number}: ${problem}.`;
      cx.notify();
      return;
    }
    if (stage === "done" && ticket.stage !== "done" && ticket.threads.length) {
      const wont = resolution === "wont-do";
      window.open_dialog(() => v_flex().gap_3()
        .child(`Move #${ticket.number} to Done${wont ? " as won't do" : ""}?`)
        .child("This archives every live thread on the ticket. Moving it out of Done brings back the threads this move archived. Won't do ends the ticket the same way.")
        .child(h_flex().gap_2().flex_wrap()
          .child(button(`cancel-done:${ticket.id}`, "Cancel", () => window.close_dialog()))
          .child(button(`alt-done:${ticket.id}`, wont ? "Move to Done and archive threads" : "Archive as won't do", cx => { window.close_dialog(); this.finishMove(cx, ticket.id, "done", wont ? "done" : "wont-do"); }))
          .child(primary(`confirm-done:${ticket.id}`, wont ? "Archive as won't do" : "Move to Done and archive threads", cx => { window.close_dialog(); this.finishMove(cx, ticket.id, "done", resolution); }))));
      return;
    }
    if (resolution !== "wont-do" && ["in-progress", "review"].includes(stage) && ticket.threads.length) {
      window.open_dialog(() => v_flex().gap_3()
        .child(`Move #${ticket.number} to ${TITLES[stage]}?`)
        .child("Move keeps the current threads. Hand off starts a new thread and archives the ones you pick.")
        .child(h_flex().gap_2().flex_wrap()
          .child(button(`cancel-move:${ticket.id}`, "Cancel", () => window.close_dialog()))
          .child(button(`handoff-move:${ticket.id}`, "Hand off…", cx => {
            window.close_dialog();
            this.pendingMove = { id: ticket.id, stage };
            this.ticketId = ticket.id;
            this.act(cx, async () => { await this.prepare("handoff", ticket); this.persona = this.personas.includes(PERSONAS[stage]) ? PERSONAS[stage] : ""; });
          }))
          .child(button(`just-move:${ticket.id}`, "Move without starting a thread", cx => { window.close_dialog(); this.finishMove(cx, ticket.id, stage, "done"); }))));
      return;
    }
    this.finishMove(cx, ticket.id, stage, resolution);
  }
  menu(ticket, _cx) {
    const menu = new DropdownMenu(`ticket-menu:${ticket.id}`, "···");
    menu.item("Open", cx => this.openTicket(ticket.id, cx));
    if (!ticket.proposed) {
      for (const stage of STAGES.filter(s => s !== ticket.stage)) menu.item(`Move to ${TITLES[stage]}`, cx => this.move(ticket, stage, cx));
      if (!(ticket.stage === "done" && ticket.resolution === "wont-do")) menu.item("Won't do", cx => this.move(ticket, "done", cx, "wont-do"));
      if (ticket.stage !== "done") menu.item("Start thread", cx => {
        this.ticketId = ticket.id;
        this.act(cx, () => this.prepare("start", ticket));
      });
      menu.item("Set parent…", () => this.pickParent(ticket));
    }
    if (ticket.stage === "backlog") {
      menu.item("Top of Backlog", cx => this.act(cx, () => store.rankTicket(ticket.id, { top: true })));
      menu.item("Bottom of Backlog", cx => this.act(cx, () => store.rankTicket(ticket.id, { bottom: true })));
      menu.item("Rank above…", cx => this.rankAgainst(ticket, "before"));
      menu.item("Rank below…", cx => this.rankAgainst(ticket, "after"));
    }
    return menu;
  }
  render(cx) {
    const colors = cx.theme().colors;
    const radius = cx.theme().radius;
    const root = v_flex().size_full().min_w_0().min_h_0().bg(colors.background).text_color(colors.foreground).gap_3()
      .track_focus(this.boardFocus).tab_stop(true)
      .on_key_down((event, cx) => {
        if (event.key !== "n" && event.key !== "N") return;
        const mods = event.modifiers;
        if (mods.shift || mods.control || mods.alt || mods.platform || mods.function) return;
        if (this.fields > 0 || this.form || window.has_active_dialog()) return;
        this.jumpToNext(cx);
        cx.stop_propagation();
      });
    if (this.error) {
      root.child(h_flex().gap_2().px_5().pt_3().items_center()
        .child(muted(this.error, cx).flex_1())
        .child(button("retry-board", "Retry", cx => this.act(cx, () => this.refresh()))));
    }
    if (this.note) root.child(h_flex().px_5().child(muted(this.note, cx)));
    if (!this.projectId) return root.child(v_flex().flex_1().items_center().justify_center().child(muted("Open a project to use the board", cx)));
    if (this.ticketId && this.ticket) return root.child(this.renderTicket(cx));

    const projectRows = this.projects.map(p => ({ id: p.id, label: p.name }));
    const more = new DropdownMenu("board-more", "More");
    for (const p of this.projects.filter(p => p.id !== this.projectId)) {
      more.item(`${this.shown.has(p.id) ? "Hide" : "Also show"} ${p.name}`, cx => {
        this.shown.has(p.id) ? this.shown.delete(p.id) : this.shown.add(p.id);
        this.act(cx, () => this.remember());
      });
    }
    const projectName = this.projects.find(p => p.id === this.projectId)?.name ?? "this project";
    const toolbar = h_flex().gap_2().px_5().pt_4().pb_1().items_center().flex_wrap()
      .child(select("board-project", projectRows, projectName, (id, cx) => { this.jumpIndex = -1; this.act(cx, async () => { this.projectId = id; this.form = null; await this.remember(); }); }))
      .child(new Input(this.search).aria_label("Search").flex_1().min_w("6rem").on_change((_, cx) => cx.notify()))
      .child(button("rules", "Rules", cx => this.openRules(cx)))
      .child(button("repos", "Repos", cx => this.act(cx, async () => { this.form = "repos"; await github.maybeAutoLink(this.projectId); })))
      .child(this.attentionButtons());
    if (this.projects.length > 1) toolbar.child(more);
    root.child(toolbar);

    if (this.form) root.child(this.renderForm(cx).mx_5());
    const needle = this.search.value().trim();
    const loose = this.looseThreads();
    const ticketCount = STAGES.reduce((sum, stage) => sum + this.ticketsIn(stage).length, 0);
    if (needle && ticketCount === 0 && loose.length === 0) {
      return root.child(v_flex().flex_1().items_center().justify_center().gap_2()
        .child(muted(`Nothing matches “${needle}”`, cx))
        .child(button("clear-search", "Clear search", cx => { this.search.set_value(""); cx.notify(); })));
    }

    const boardRules = this.ruleMap.get(this.projectId) ?? { ageWarnDays: AGE_WARN_DAYS, wipLimit: null };
    const ownWorking = this.data.tickets.filter(t => t.projectId === this.projectId && t.stage === "in-progress").length;
    const columns = h_flex().items_stretch().flex_1().min_h_0().min_w_0().gap_3().px_5().pb_5().overflow_x_scroll();
    if (this.looseOpen || this.drag?.kind === "thread") columns.child(this.renderLoose(cx, colors, radius, loose));
    columns.children(STAGES.map((stage, ix) => this.renderColumn(stage, ix, cx, colors, radius, boardRules, ownWorking, needle)));
    return root.child(columns);
  }
  renderLoose(cx, colors, radius, loose) {
    const active = this.over?.id === "loose";
    const column = v_flex().id("loose").flex_1().min_w("16rem").max_w("16rem").min_h_0().rounded(radius.lg)
      .border_1().border_dashed().border_color(active ? colors.ring : colors.border).bg(colors.surface);
    this.dropTarget(column, "loose", payload => dropOnLoose(payload, this.data.tickets));
    const heading = h_flex().gap_2().px_3().pt_3().pb_1().items_center()
      .child(div().font_weight(600).text_size(13).child("Loose").flex_1())
      .child(div().text_size(11).text_color(colors.muted_foreground).child(String(loose.length)))
      .child(button("loose-close", "Hide", cx => this.act(cx, async () => { this.looseOpen = false; await this.remember(); })));
    const body = v_flex().gap_1().px_2().pb_3()
      .child(muted("Not on a ticket yet. Drag one onto a ticket or a column.", cx).px_1());
    if (active && this.over.label) body.child(div().px_1().text_size(12).font_weight(600).child(this.over.label));
    for (const thread of loose) {
      const dragged = this.drag?.kind === "thread" && this.drag.id === thread.id;
      const row = this.dragSource(h_flex().id(`thread:${thread.id}`).gap_2().items_center().flex_wrap().px_1().py_1().rounded(radius.md).when(dragged, el => el.opacity(0.4)), "thread", thread.id);
      row.child(new ThreadStatus(thread.id))
        .child(button(`loose-open:${thread.id}`, thread.title, cx => this.act(cx, () => host.openThread(thread.id))).flex_1().min_w_0())
        .child(button(`loose-new:${thread.id}`, "New ticket", cx => this.act(cx, () => store.createTicket({ projectId: thread.projectId, title: thread.title, threadId: thread.id, kind: "story" }))))
        .child(button(`loose-ip:${thread.id}`, "In progress", cx => this.act(cx, () => store.createTicket({ projectId: thread.projectId, title: thread.title, threadId: thread.id, stage: "in-progress", kind: "story" }))))
        .child(button(`loose-review:${thread.id}`, "Review", cx => this.act(cx, () => store.createTicket({ projectId: thread.projectId, title: thread.title, threadId: thread.id, stage: "review", kind: "story" }))));
      body.child(row);
    }
    if (!loose.length) body.child(v_flex().py_6().items_center().child(muted(this.drag?.kind === "thread" ? "Drop to take it off its ticket" : "Every thread is on a ticket", cx)));
    column.child(heading).child(new Scroll(this.scroll).flex_1().min_h_0().child(body));
    return column;
  }
  renderColumn(stage, ix, cx, colors, radius, boardRules, ownWorking, needle) {
    const tickets = this.ticketsIn(stage);
    const visible = stage === "done" && !needle ? tickets.slice(0, this.doneLimit) : tickets;
    const over = stage === "in-progress" && boardRules.wipLimit !== null && ownWorking > boardRules.wipLimit;
    const active = this.over?.id === `column:${stage}`;
    const count = div().text_size(11).child(over ? `${ownWorking} / ${boardRules.wipLimit}` : String(tickets.length));
    count.text_color(over ? colors.primary : colors.muted_foreground);
    if (over) count.font_weight(600);
    const heading = h_flex().gap_2().px_3().pt_3().pb_2().items_baseline()
      .child(div().font_weight(600).text_size(13).child(TITLES[stage]))
      .child(count);
    const column = v_flex().id(`column:${stage}`).flex_1().min_w("16rem").min_h_0().rounded(radius.lg)
      .bg(colors.surface).border_1().border_color(active ? colors.ring : colors.surface);
    this.dropTarget(column, `column:${stage}`, payload => dropOnColumn(payload, stage, this.data.tickets));
    column.child(heading);
    const cards = visible.map(ticket => this.renderCard(ticket, cx, colors, radius));
    const body = v_flex().gap_2().px_2().pb_3().children(cards);
    if (active && this.over.label) body.child(div().px_2().text_size(12).font_weight(600).child(this.over.label));
    else if (!tickets.length && !needle && (stage === "backlog" || this.drag)) {
      body.child(v_flex().py_6().items_center().child(muted(this.drag ? (this.drag.kind === "thread" ? "Drop to make a ticket" : "Drop here") : "Nothing here yet", cx)));
    }
    const dragging = Boolean(this.drag);
    if (stage === "backlog" && !needle && !dragging) {
      if (this.composerOpen) {
        body.child(div().mx_2()
          .on_key_down((event, cx) => {
            if (event.key !== "escape") return;
            this.composerOpen = false;
            this.composer.set_value("");
            this.refocusComposer = false;
            cx.stop_propagation();
            cx.notify();
          })
          .child(new Input(this.composer).aria_label("New ticket title").track_focus(this.composerFocus)));
      } else {
        body.child(button("new-ticket", "New ticket", cx => {
          this.composerOpen = true;
          this.composer.set_value("");
          cx.notify();
          cx.spawn(async () => { try { this.composerFocus.focus(); } catch { /* The field is mounted on the next frame. */ } });
        }).mx_2());
      }
      if (this.repos.length) body.child(button("import-issue", "Import issue", cx => this.act(cx, async () => {
        this.form = "import";
        this.issues = await github.listIssues(this.projectId, { query: this.issueQuery.value(), ...this.issueFilters });
      })).mx_2());
    }
    column.child(new Scroll(this.columns[ix]).flex_1().min_h_0().child(body));
    if (stage === "done" && !needle && visible.length < tickets.length) {
      column.child(button("more-done", `Show ${tickets.length - visible.length} more`, cx => { this.doneLimit += 20; cx.notify(); }).mx_2().mb_2());
    }
    return column;
  }
  pendingMove(t, cx, prefix) {
    const pending = h_flex().gap_2().flex_wrap()
      .child(muted(`Move to ${TITLES[t.pendingStage]}?`, cx))
      .child(button(`${prefix}:accept-move`, "Accept", cx => this.move(t, t.pendingStage, cx)))
      .child(button(`${prefix}:dismiss-move`, "Dismiss", cx => this.act(cx, () => store.dismissMove(t.id))));
    if (t.pendingStage === "done") pending.child(button(`${prefix}:wont`, "Won't do", cx => this.move(t, "done", cx, "wont-do")));
    return pending;
  }
  handoffFailure(t, cx, prefix) {
    const job = t.handoff;
    if (!job || (job.status !== "failed" && !job.error)) return null;
    const colors = cx.theme().colors;
    const box = v_flex().gap_1()
      .child(div().text_size(12).font_weight(600).text_color(colors.destructive).child(job.consolidate ? "Couldn't consolidate" : "Handoff failed"));
    if (job.error) box.child(div().text_size(12).text_color(colors.destructive).child(String(job.error)));
    return box.child(h_flex().gap_2().flex_wrap()
      .child(button(`${prefix}:retry-handoff`, "Retry", cx => this.act(cx, () => handoff.retryHandoff(t.id))))
      .child(button(`${prefix}:start-anyway`, job.consolidate ? "Start anyway" : "Start without handoff", cx => this.act(cx, () => handoff.startWithoutHandoff(t.id)))));
  }
  renderCard(t, cx, colors, radius) {
    const parent = t.parentId ? this.data.tickets.find(p => p.id === t.parentId) : null;
    const children = this.data.tickets.filter(c => c.parentId === t.id);
    const next = NEXT[t.stage];
    const active = this.over?.id === t.id;
    const dragged = this.drag?.kind === "ticket" && this.drag.id === t.id;
    const card = v_flex().id(`ticket:${t.id}`).gap_1().px_3().py_2().rounded(radius.md).bg(colors.background).border_1()
      .border_color(active ? colors.ring : this.jumpId === t.id ? colors.primary : colors.border)
      .when(dragged, el => el.opacity(0.4));
    if (!t.proposed) {
      this.dropTarget(this.dragSource(card, "ticket", t.id), t.id, (payload, side) => dropOnCard(payload, side, t, this.data.tickets, this.data.loose));
    }
    if (t.proposed) card.border_dashed();
    if (active && this.over.side === "top") card.child(div().h(2).w_full().rounded(1).bg(colors.ring));
    const opener = new KgButton(`card:${t.id}`).label(t.title).ghost().compact().flex_1().min_w_0().on_click((a, b) => this.openTicket(t.id, clickCx(a, b)));
    if (this.jumpId === t.id) opener.track_focus(this.jumpFocus);
    const meta = [];
    if (t.stage === "backlog" && needsYou(t) && !t.proposed) {
      meta.push(h_flex().gap_1().items_center()
        .child(div().w(6).h(6).rounded(3).bg(colors.primary))
        .child(div().text_size(11).font_weight(600).text_color(colors.primary).child("Needs you")));
    }
    if (t.kind) meta.push(chip(t.kind, cx));
    if (t.stage === "done" && t.resolution === "wont-do") meta.push(chip("won't do", cx));
    const ac = criteriaLine(t.description, t.kind);
    if (ac) meta.push(div().text_size(11).text_color(colors.muted_foreground).child(ac));
    const age = t.stage === "in-progress" || t.stage === "review" ? daysInStage(t.stageAt) : null;
    if (age !== null) {
      const warn = this.ruleMap.get(t.projectId)?.ageWarnDays ?? AGE_WARN_DAYS;
      const label = div().text_size(11).child(`${age}d`);
      label.text_color(age > warn ? colors.primary : colors.muted_foreground);
      if (age > warn) label.font_weight(600);
      meta.push(label);
    }
    const subs = subTicketLine(children);
    if (subs) meta.push(muted(subs, cx));
    if (parent) meta.push(button(`parent:${t.id}`, `Under #${parent.number}`, cx => this.openTicket(parent.id, cx)));
    if (t.projectId !== this.projectId) meta.push(muted(this.projects.find(p => p.id === t.projectId)?.name ?? "", cx));
    card.child(h_flex().gap_2().items_start()
      .child(v_flex().gap_1().flex_1().min_w_0()
        .child(h_flex().gap_1().items_baseline()
          .child(div().text_color(colors.muted_foreground).text_size(11).child(`#${t.number}`))
          .child(opener))
        .child(h_flex().gap_2().items_center().flex_wrap().children(meta)))
      .child(this.menu(t, cx)));
    const held = t.stage === "backlog" ? startProblem(t) : null;
    if (held) card.child(muted(`Can't leave Backlog yet: ${held}. Won't do is still allowed.`, cx));
    const blockers = openBlockers(t);
    if (blockers.length && t.stage !== "done") {
      card.child(h_flex().gap_1().flex_wrap().items_center()
        .child(muted("Blocked by", cx))
        .children(blockers.map(b => button(`blocked:${t.id}:${b.id}`, `#${b.number} ${b.title}`, cx => this.openTicket(b.id, cx)))));
    }
    if (t.proposed) {
      card.child(h_flex().gap_2()
        .child(primary(`accept:${t.id}`, "Accept", cx => this.act(cx, () => store.acceptTicket(t.id))))
        .child(button(`dismiss:${t.id}`, "Dismiss", cx => this.act(cx, () => store.dismissTicket(t.id)))));
    }
    if (t.pendingStage) card.child(this.pendingMove(t, cx, `card:${t.id}`));
    const failed = this.handoffFailure(t, cx, `card:${t.id}`);
    if (failed) card.child(failed);
    if (!t.proposed && next) {
      card.child(h_flex().justify_end()
        .child(button(`move:${t.id}:${next}`, `→ ${TITLES[next]}`, cx => this.move(t, next, cx))));
    }
    if (active && this.over.label) card.child(div().text_size(12).font_weight(600).child(this.over.label));
    const statusLine = threadStatusLine(t.threads);
    if (statusLine) card.child(muted(statusLine, cx));
    if (t.threads.length) {
      const open = this.openThreads.has(t.id);
      card.child(button(`threads:${t.id}`, `${open ? "Hide" : "Show"} ${t.threads.length} thread${t.threads.length === 1 ? "" : "s"}`, cx => {
        this.openThreads.has(t.id) ? this.openThreads.delete(t.id) : this.openThreads.add(t.id);
        cx.notify();
      }));
      if (open) for (const thread of t.threads) {
        const rowDragged = this.drag?.kind === "thread" && this.drag.id === thread.id;
        const row = this.dragSource(h_flex().id(`thread:${thread.id}`).gap_2().items_center().when(rowDragged, el => el.opacity(0.4)), "thread", thread.id);
        row.child(new ThreadStatus(thread.id)).child(button(`card-thread:${thread.id}`, thread.title, cx => this.act(cx, () => host.openThread(thread.id))).flex_1().min_w_0());
        card.child(row);
      }
    } else if (!t.proposed && t.stage !== "done") {
      card.child(button(`start-card:${t.id}`, "Start thread", cx => {
        this.ticketId = t.id;
        this.act(cx, () => this.prepare("start", t));
      }));
    }
    if (active && this.over.side === "bottom") card.child(div().h(2).w_full().rounded(1).bg(colors.ring));
    return card;
  }
  renderTicket(cx) {
    const t = this.ticket;
    const colors = cx.theme().colors;
    const stageLine = `${TITLES[t.stage]}${t.stage === "done" && t.resolution === "wont-do" ? " · won't do" : ""}`;
    const head = h_flex().gap_3().px_5().pt_4().pb_2().items_center().flex_wrap()
      .child(button("back-board", "Board", cx => { this.ticketId = null; this.form = null; this.pendingMove = null; cx.notify(); }))
      .child(v_flex().gap_1().flex_1().min_w_0()
        .child(div().font_weight(600).text_size(16).child(`#${t.number}  ${t.title}`))
        .child(muted(stageLine, cx)))
      .child(this.attentionButtons())
      .child(this.menu(t, cx));
    const body = v_flex().p_5().gap_4();
    if (looksLikeUserStory(t.title)) body.child(muted(USER_STORY_WARNING, cx));
    if (!t.proposed) body.child(select("ticket-kind", [{ id: "none", label: "No kind" }, ...KINDS.map(kind => ({ id: kind, label: kind[0].toUpperCase() + kind.slice(1) }))], t.kind ? t.kind[0].toUpperCase() + t.kind.slice(1) : "No kind", (id, cx) => this.act(cx, () => store.editTicket(t.id, { kind: id === "none" ? null : id }))));
    const ac = criteriaLine(t.description, t.kind);
    if (ac) body.child(muted(ac, cx));
    const held = t.stage === "backlog" ? startProblem(t) : null;
    if (held) body.child(muted(`Can't leave Backlog yet: ${held}. Won't do is still allowed.`, cx));
    if (t.proposed) body.child(h_flex().gap_2().child(button("accept-ticket", "Accept ticket", cx => this.act(cx, () => store.acceptTicket(t.id)))).child(button("dismiss-ticket", "Dismiss", cx => this.act(cx, async () => { await store.dismissTicket(t.id); this.ticketId = null; }))));
    if (t.pendingStage) body.child(this.pendingMove(t, cx, "detail"));
    const failed = this.handoffFailure(t, cx, "detail");
    if (failed) body.child(failed);
    body.child(new Markdown(`description:${t.id}`, t.description || "No description"));
    body.child(button("edit-ticket", "Edit ticket…", cx => { this.form = "edit"; this.title.set_value(t.title); this.description.set_value(t.description); cx.notify(); }));
    if (t.issue) body.child(button("open-issue", `${t.issue.repo}#${t.issue.number}`, cx => this.act(cx, () => host.openUrl(t.issue.url))));
    const quiet = threadStatusLine(t.threads);
    body.child(div().child(`Threads · ${t.threads.length}`));
    if (quiet) body.child(muted(quiet, cx));
    body.child(muted("Remove a thread here, or drag it from the board onto Loose to take it off the ticket.", cx));
    for (const thread of t.threads) {
      const project = this.projects.find(p => p.id === thread.projectId);
      const menu = new DropdownMenu(`thread-menu:${thread.id}`, "Thread actions")
        .item(thread.pinned ? "Unpin" : "Pin", cx => this.act(cx, () => threads.setPinned(thread.id, !thread.pinned)))
        .item("Remove thread from ticket", cx => this.act(cx, () => store.detach(thread.id)))
        .item("Archive thread", cx => this.act(cx, async () => { await threads.archive(thread.id); store.touch(); }));
      body.child(h_flex().gap_2().child(new ThreadStatus(thread.id)).child(button(`ticket-thread:${thread.id}`, `${thread.title}${thread.projectId !== t.projectId ? ` · ${project?.name ?? thread.projectId}` : ""}`, cx => this.act(cx, () => host.openThread(thread.id)))).child(menu));
    }
    if (!t.proposed && t.stage !== "done") {
      body.child(h_flex().gap_2().child(button("start-thread", "Start thread…", cx => this.act(cx, () => this.prepare("start", t))))
        .child(button("attach-thread", "Attach a thread with no ticket", cx => { this.form = "attach"; cx.notify(); })));
      if (t.threads.length) body.child(h_flex().gap_2().child(button("handoff-thread", "Start new thread from this one", cx => this.act(cx, () => this.prepare("handoff", t))))
        .child(button("consolidate-threads", "Merge threads into one new thread", cx => this.act(cx, () => this.prepare("consolidate", t)))));
      body.child(select("parent-ticket", [{ id: "none", label: "No parent" }, ...this.data.tickets.filter(p => p.id !== t.id && p.projectId === t.projectId && !p.proposed).map(p => ({ id: p.id, label: `#${p.number} ${p.title}` }))], t.parentId ? `Parent #${this.data.tickets.find(p => p.id === t.parentId)?.number}` : "Set parent…", (id, cx) => this.act(cx, () => store.setParent(t.id, id === "none" ? null : id))));
      const childChoices = this.data.tickets.filter(p => p.id !== t.id && p.projectId === t.projectId && !p.proposed && !p.parentId);
      if (childChoices.length) body.child(select("add-sub", childChoices.map(p => ({ id: p.id, label: `#${p.number} ${p.title}` })), "Add sub-ticket", (id, cx) => this.act(cx, () => store.setParent(id, t.id))));
    }
    if (!t.proposed) {
      const blockerChoices = this.data.tickets.filter(p => canBlock(this.data.tickets, t.id, p.id));
      body.child(div().child("Blocked by"));
      for (const blocker of t.blockedBy ?? []) body.child(h_flex().gap_2().items_center()
        .child(button(`open-blocker:${blocker.id}`, `#${blocker.number} ${blocker.title} · ${TITLES[blocker.stage]}`, cx => this.openTicket(blocker.id, cx)).flex_1())
        .child(button(`remove-blocker:${blocker.id}`, "Remove", cx => this.act(cx, () => store.unblockTicket(t.id, blocker.id)))));
      if (blockerChoices.length) body.child(select("add-blocker", blockerChoices.map(p => ({ id: p.id, label: `#${p.number} ${p.title}` })), "Add blocker", (id, cx) => this.act(cx, () => store.blockTicket(t.id, id))));
      if ((t.blocks ?? []).length) {
        body.child(div().child("Blocks"));
        for (const blocked of t.blocks) body.child(button(`blocks:${blocked.id}`, `#${blocked.number} ${blocked.title}`, cx => this.openTicket(blocked.id, cx)));
      }
    }
    const subs = subTicketLine(t.subTickets ?? []);
    if (subs) body.child(muted(subs, cx));
    for (const child of t.subTickets ?? []) body.child(h_flex().gap_2().items_center()
      .child(button(`sub:${child.id}`, `↳ #${child.number} ${child.title} · ${TITLES[child.stage]}${child.resolution === "wont-do" ? " · won't do" : ""}`, cx => this.openTicket(child.id, cx)).flex_1())
      .child(button(`unsub:${child.id}`, "Remove", cx => this.act(cx, () => store.setParent(child.id, null)))));
    if (this.form) body.child(this.renderForm(cx));
    body.child(div().child("Comments"));
    for (const comment of t.comments) body.child(v_flex().gap_2().child(muted(comment.github_login ?? comment.persona ?? comment.thread_id ?? "You", cx)).child(new Markdown(comment.id, comment.body))
      .child(new DropdownMenu(`comment:${comment.id}`, "Comment actions")
        .item("Edit…", cx => { this.editCommentId = comment.id; this.comment.set_value(comment.body); cx.notify(); })
        .item("Delete", cx => this.act(cx, () => store.deleteComment(comment.id)))));
    body.child(new Textarea(this.comment).aria_label(this.editCommentId ? "Edit comment" : "Add comment"));
    body.child(button("save-comment", this.editCommentId ? "Save comment" : "Add comment", cx => this.act(cx, async () => {
      if (this.editCommentId) await store.editComment(this.editCommentId, this.comment.value());
      else await store.addComment(t.id, { body: this.comment.value() });
      this.editCommentId = null; this.comment.set_value("");
    })).disabled(this.busy));
    body.child(button("delete-ticket", "Delete ticket…", cx => {
      window.open_dialog(() => v_flex().gap_3().child(`Delete #${t.number} “${t.title}”?`).child("Its threads will be archived. The ticket and comments will be deleted.")
        .child(h_flex().gap_2().child(button("cancel-delete", "Cancel", () => window.close_dialog()))
          .child(new KgButton("confirm-delete").danger().label("Delete ticket").on_click((a, b) => { window.close_dialog(); this.act(clickCx(a, b), async () => { await store.deleteTicket(t.id); this.ticketId = null; }); }))));
    }));
    return v_flex().size_full().min_h_0().child(head).child(new Scroll(this.scroll).flex_1().min_h_0().child(body));
  }
  renderForm(cx) {
    const colors = cx.theme().colors;
    const form = v_flex().p_4().gap_3().rounded(cx.theme().radius.lg).bg(colors.surface).border_1().border_color(colors.border)
      .track_focus(this.formFocus)
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        this.form = null;
        this.pendingMove = null;
        cx.stop_propagation();
        cx.notify();
      });
    const cancel = button("cancel-form", "Cancel", cx => { this.form = null; this.pendingMove = null; cx.notify(); });
    if (this.form === "new" || this.form === "edit") {
      const projectName = this.projects.find(p => p.id === this.projectId)?.name ?? "this project";
      form.child(div().font_weight(600).child(this.form === "new" ? "New ticket" : "Edit ticket"));
      if (this.form === "new") form.child(muted(`Creates a ticket in ${projectName}. Done archives its threads.`, cx));
      form.child(div().text_size(12).child("Ticket title"));
      form.child(new Input(this.title).aria_label("Ticket title").on_change((_, cx) => cx.notify()));
      if (looksLikeUserStory(this.title.value())) form.child(muted(USER_STORY_WARNING, cx));
      form.child(div().text_size(12).child("Description"));
      form.child(new Textarea(this.description).aria_label("Description"));
      const titleOk = this.title.value().trim().length > 0 && this.title.value().trim().length <= 200;
      form.child(h_flex().gap_2().justify_end().child(cancel).child(new KgButton("save-ticket").primary().compact().label(this.form === "new" ? "Create ticket" : "Save").disabled(this.busy || !titleOk).on_click((a, b) => this.act(clickCx(a, b), async () => {
        if (this.form === "new") await store.createTicket({ projectId: this.projectId, title: this.title.value(), description: this.description.value() });
        else await store.editTicket(this.ticketId, { title: this.title.value(), description: this.description.value() });
        this.form = null;
      }))));
    } else if (["start", "handoff", "consolidate"].includes(this.form)) {
      form.child(div().child(this.form === "start" ? "Start thread" : "Continue from a handoff"));
      form.child(new Textarea(this.prompt).aria_label("Prompt for the new thread"));
      form.child(select("persona", [{ id: "none", label: "No persona" }, ...this.personas.map(name => ({ id: name, label: name }))], this.persona || "No persona", (id, cx) => { this.persona = id === "none" ? "" : id; cx.notify(); }));
      if (this.form !== "start") for (const thread of this.ticket?.threads ?? []) form.child(button(`source:${thread.id}`, `${this.sourceIds.has(thread.id) ? "✓ " : ""}${thread.title}`, cx => {
        if (this.form === "handoff") this.sourceIds = new Set([thread.id]);
        else this.sourceIds.has(thread.id) ? this.sourceIds.delete(thread.id) : this.sourceIds.add(thread.id);
        cx.notify();
      }));
      const actions = h_flex().gap_2().child(cancel);
      if (this.pendingMove) actions.child(button("just-move", "Move without starting a thread", cx => {
        const pending = this.pendingMove;
        this.pendingMove = null;
        this.form = null;
        this.finishMove(cx, pending.id, pending.stage, "done");
      }));
      const canSubmit = this.form === "start" || this.sourceIds.size > 0;
      actions.child(new KgButton("submit-thread").primary().label(this.form === "start" ? "Start thread" : this.form === "consolidate" ? "Merge into new thread" : "Start new thread from sources").disabled(this.busy || !canSubmit).on_click((a, b) => this.act(clickCx(a, b), async () => {
        const options = { persona: this.persona || null, prompt: this.prompt.value() };
        if (this.form === "start") await handoff.startThread(this.ticketId, options);
        else {
          if (this.pendingMove) await store.moveTicket(this.pendingMove.id, this.pendingMove.stage);
          await handoff.startHandoff(this.ticketId, { ...options, sourceThreadIds: [...this.sourceIds], consolidate: this.form === "consolidate" });
        }
        this.form = null; this.pendingMove = null;
      })));
      form.child(actions);
    } else if (this.form === "attach") {
      const loose = this.data.loose.filter(thread => thread.projectId === this.ticket?.projectId);
      for (const thread of loose) form.child(button(`attach:${thread.id}`, thread.title, cx => this.act(cx, async () => { await store.attach(this.ticketId, thread.id); this.form = null; })));
      if (!loose.length) form.child(muted("No threads without a ticket in this project", cx));
      form.child(cancel);
    } else if (this.form === "rules") {
      form.child(div().font_weight(600).child("Rules"));
      form.child(muted("For this project's tickets. A full In progress column warns. It does not block a move.", cx));
      form.child(div().text_size(12).child("Days in a column before a warning"));
      form.child(new Input(this.warnDays).aria_label("Warning days"));
      form.child(div().text_size(12).child("Most tickets in In progress"));
      form.child(new Input(this.wipLimit).aria_label("Work in progress limit"));
      form.child(h_flex().gap_2().justify_end().child(cancel).child(primary("save-rules", "Save", cx => this.act(cx, async () => {
        const days = Number(this.warnDays.value());
        const raw = this.wipLimit.value().trim();
        const limit = raw === "" || raw.toLowerCase() === "off" ? null : Number(raw);
        await store.setBoardRules(this.projectId, { ageWarnDays: days, wipLimit: limit });
        this.form = null;
      }))));
    } else if (this.form === "repos" || this.form === "import") {
      if (this.form === "import") {
        form.child(div().font_weight(600).child("Import issue"));
        form.child(muted("Copies the issue onto the bottom of Backlog. Nothing is written to GitHub.", cx));
      } else {
        for (const repo of this.repos) form.child(h_flex().gap_2().child(repo).child(button(`unlink:${repo}`, "Unlink", cx => this.act(cx, () => store.unlinkRepo(this.projectId, repo)))));
        form.child(h_flex().gap_2().child(new Input(this.repo).aria_label("GitHub repository")).child(button("link-repo", "Link", cx => this.act(cx, async () => { await store.linkRepo(this.projectId, await github.normalizeRepo(this.repo.value())); this.repo.set_value(""); }))));
      }
      form.child(new Input(this.issueQuery).aria_label("Search open issues"));
      for (const field of ["label", "assignee", "author"]) {
        const values = new Set(this.issues.flatMap(issue => field === "label" ? issue.labels?.map(l => l.name) ?? [] : field === "assignee" ? issue.assignees?.map(a => a.login) ?? [] : [issue.author?.login]).filter(Boolean));
        form.child(select(`issue-${field}`, [{ id: "all", label: `All ${field}s` }, ...[...values].map(value => ({ id: value, label: value }))], this.issueFilters[field] || `All ${field}s`, (value, cx) => { this.issueFilters[field] = value === "all" ? "" : value; cx.notify(); }));
      }
      form.child(button("search-issues", "Search issues", cx => this.act(cx, async () => { this.issues = await github.listIssues(this.projectId, { query: this.issueQuery.value(), ...this.issueFilters }); })));
      for (const issue of this.issues) form.child(button(`import:${issue.repo}:${issue.number}`, `Import ${issue.repo}#${issue.number} · ${issue.title}`, cx => this.act(cx, async () => { const ticket = await github.importIssue(this.projectId, issue.repo, issue.number); this.ticketId = ticket.id; this.form = null; })));
      form.child(cancel);
    }
    return form.on_key_down((event, cx) => { if (event.key === "escape") { this.form = null; this.pendingMove = null; cx.notify(); } });
  }
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
    this.act(cx, () => row.project ? boardLink(row.project.id) : row.thread ? host.openThread(row.thread.id) : boardLink(row.ticket.projectId, row.ticket.id));
  }
  rowActions(row, line) {
    const ticket = row.ticket && !row.id.startsWith("child:") ? row.ticket : null;
    if (ticket && !ticket.proposed) {
      for (const stage of STAGES) {
        if (stage === ticket.stage) continue;
        line.child(button(`side-move:${row.id}:${stage}`, TITLES[stage], cx => this.act(cx, () => store.moveTicket(ticket.id, stage))));
      }
      if (ticket.stage !== "done") line.child(button(`side-start:${row.id}`, "Start thread", cx => this.act(cx, () => handoff.startThread(ticket.id, {}))));
    }
    const unpin = ticket ? (row.threads ?? []).filter(thread => thread.pinned) : [];
    const pinTarget = row.thread;
    if (!pinTarget && !unpin.length) return;
    const pinned = ticket ? Boolean(row.pinned) : Boolean(pinTarget.pinned);
    line.child(button(`side-pin:${row.id}`, pinned ? "Unpin" : "Pin", cx => this.act(cx, async () => {
      if (pinned && unpin.length) {
        for (const thread of unpin) await threads.setPinned(thread.id, false);
      } else if (pinTarget) {
        await threads.setPinned(pinTarget.id, !pinTarget.pinned);
      }
      store.touch();
    })));
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
      .on_key_down((event, cx) => {
        const ix = Math.max(0, rows.findIndex(r => r.id === this.selected));
        if (event.key === "down" || event.key === "up") { this.selected = rows[Math.max(0, Math.min(rows.length - 1, ix + (event.key === "down" ? 1 : -1)))]?.id; cx.notify(); }
        else if (event.key === "enter" && rows[ix]) this.open(rows[ix], cx);
        else if (event.key === "n") { const need = [...rows.slice(ix + 1), ...rows.slice(0, ix + 1)].find(r => r.needs && !r.project); if (need) { this.selected = need.id; this.open(need, cx); } }
        else if (["left", "right"].includes(event.key) && rows[ix]?.ticket) { event.key === "right" ? this.expanded.add(rows[ix].ticket.id) : this.expanded.delete(rows[ix].ticket.id); cx.notify(); }
      })
      .child(this.error ? muted(this.error, cx) : "")
      .child(h_flex().px_2().py_1().child(button("sidebar-focus", this.onlyNeeds ? "Show all" : "Focus", cx => this.act(cx, async () => {
        this.onlyNeeds = !this.onlyNeeds;
        await store.kvSet("sidebar-focus", JSON.stringify(this.onlyNeeds));
      }))))
      .child(quiet ? muted(`${quiet} quiet`, cx).px_2() : "")
      .child(new Scroll(this.scroll).flex_1().min_h_0().child(v_flex().id("kanban-sidebar").children(rows.map(row => {
        if (row.project) return h_flex().w_full().h_8().px_2().gap_2()
          .child(button(`collapse:${row.id}`, this.collapsed.has(row.id) ? "Expand project" : "Collapse project", cx => this.act(cx, async () => { this.collapsed.has(row.id) ? this.collapsed.delete(row.id) : this.collapsed.add(row.id); await store.kvSet("sidebar", JSON.stringify([...this.collapsed])); })))
          .child(button(`project:${row.id}`, `${row.project.name}${row.needs ? ` · ${row.needs} need you` : ""}`, cx => this.open(row, cx)).flex_1());
        const title = row.ticket && !row.id.startsWith("child:") ? `${GLYPHS[row.ticket.stage]} #${row.ticket.number} ${row.ticket.title}` : `· ${row.thread.title}${row.thread.projectId !== row.ticket?.projectId && row.ticket ? ` · ${this.projects.find(p => p.id === row.thread.projectId)?.name ?? ""}` : ""}`;
        const line = h_flex().w_full().min_h(32).flex_wrap().items_center().gap_1().px_2().py_1().pl(`${(row.depth + 1) * 0.75}rem`).bg(row.id === this.selected || row.thread?.id === host.context().threadId ? colors.selection : colors.surface)
          .child(div().flex_1().min_w_0().overflow_hidden().child(button(`row:${row.id}`, title, cx => { this.selected = row.id; this.open(row, cx); })));
        if (row.thread) line.child(new ThreadStatus(row.thread.id));
        if (row.ticket?.proposed) line.child(muted("Proposed", cx));
        if (row.threads?.length > 1) line.child(button(`expand:${row.id}`, `Show ${row.threads.length} threads`, cx => { this.expanded.has(row.id) ? this.expanded.delete(row.id) : this.expanded.add(row.id); cx.notify(); }));
        if (row.ticket && !row.ticket.proposed) line.child(button(`board:${row.id}`, "Open on board", cx => this.act(cx, () => boardLink(row.ticket.projectId, row.ticket.id))));
        this.rowActions(row, line);
        if (row.thread) line.child(button(`archive:${row.id}`, "Archive thread", cx => this.act(cx, async () => { await threads.archive(row.thread.id); store.touch(); })));
        if (row.thread && !row.ticket) line.child(button(`newtkt:${row.id}`, "Create ticket", cx => this.act(cx, () => store.createTicket({ projectId: row.thread.projectId, title: row.thread.title, threadId: row.thread.id }))));
        return line;
      }))));
  }
}
