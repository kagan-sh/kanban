// @ts-check
import { AGE_WARN_DAYS } from "./rules.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { DropdownMenu, Input, InputState, KgButton, Scroll, ScrollbarHandle, TextareaState } from "gpui-component";
import * as host from "kagan/host";
import * as store from "./store.js";
import * as github from "./github.js";
import * as handoff from "./handoff.js";
import { PERSONAS, STAGES, TITLES, dropOnColumn, handoffSources, moveWarning, needsYou, planMove, rankOrder, sortColumn, threadMatches, ticketMatches } from "./model.js";
import { listPersonas } from "./personas.js";
import { WatchedView, button, clickCx, dot, focusWhenMounted, muted, primary, select, tiny } from "./ui.js";
import { loadTicketExtras, refreshTicket, renderTicket } from "./ticket.js";
import * as boardData from "./board-data.js";
import { renderCard } from "./cards.js";
import { renderLoose } from "./loose.js";
import { renderForm } from "./forms.js";

export class BoardPanel extends WatchedView {
  init(props, cx) {
    this.projectId = host.context().projectId;
    this.ticketId = null;
    this.ticket = null;
    this.section = "overview";
    this.pulls = [];
    this.pullsError = null;
    this.ticketRepos = [];
    this.changes = [];
    this.briefing = null;
    this.seenAt = 0;
    this.editCommentId = null;
    this.form = null;
    this.pendingMove = null;
    this.sourceIds = new Set();
    this.personas = [];
    this.persona = "";
    this.formFocus = cx.focus_handle();
    this.title = InputState("Ticket title");
    this.description = TextareaState();
    this.comment = TextareaState();
    this.prompt = TextareaState();
    this.shown = new Set();
    this.search = InputState("Search");
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
    this.repo = InputState("owner/name");
    this.issueQuery = InputState("Search open issues");
    this.issueFilters = { label: "", assignee: "", author: "" };
    this.repos = [];
    this.issues = [];
    this.looseOpen = false;
    this.doneLimit = 5;
    this.drag = null;
    this.over = null;
    this.openThreads = new Set();
    this.columns = STAGES.map(() => ScrollbarHandle());
    this.looseLimit = 20;
    const typing = (state) => {
      state.on("focus", () => { this.fields += 1; });
      state.on("blur", () => { this.fields = Math.max(0, this.fields - 1); });
    };
    for (const state of [this.search, this.composer, this.repo, this.issueQuery, this.warnDays, this.wipLimit, this.title, this.description, this.comment, this.prompt]) typing(state);
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
      this.consumeStart(cx);
      cx.notify();
      for (;;) {
        this.applyContext(await host.onContextChanged());
        await this.refresh();
        this.consumeMove(cx);
        this.consumeStart(cx);
        cx.notify();
      }
    });
  }
  applyContext(context) {
    const props = context.props;
    if (props?.projectId) this.projectId = props.projectId;
    if (props && Object.hasOwn(props, "ticketId")) this.ticketId = props.ticketId ?? null;
    const request = props?.move ? `${props.ticketId}:${props.move}:${props.moveAt ?? ""}` : null;
    if (request !== this.lastMoveRequest) {
      this.requestedMove = props?.move ? { stage: props.move, ticketId: props.ticketId } : null;
      this.lastMoveRequest = request;
    }
    const start = props?.start ? `${props.ticketId}:${props.startAt ?? ""}` : null;
    if (start !== this.lastStartRequest) {
      this.requestedStart = props?.start ? { ticketId: props.ticketId } : null;
      this.lastStartRequest = start;
    }
  }
  consumeMove(cx) {
    const request = this.requestedMove;
    if (!request) return;
    this.requestedMove = null;
    if (!this.ticket || this.ticket.id !== request.ticketId) return;
    this.move(this.ticket, request.stage, cx);
  }
  consumeStart(cx) {
    const request = this.requestedStart;
    if (!request) return;
    this.requestedStart = null;
    if (!this.ticket || this.ticket.id !== request.ticketId) return;
    this.act(cx, () => this.prepare("start", this.ticket));
  }
  openTicket(id, cx) {
    this.form = null;
    this.section = "overview";
    this.act(cx, async () => { this.ticketId = id; this.ticket = await boardData.detail(id); await loadTicketExtras(this, this.ticket); });
  }
  async prepare(form, ticket) {
    this.form = form;
    this.personas = await listPersonas();
    this.persona = this.personas.includes(PERSONAS[ticket?.stage ?? "backlog"]) ? PERSONAS[ticket?.stage ?? "backlog"] : "";
    this.prompt.set_value("");
    const sources = ticket ? handoffSources(ticket) : [];
    this.sourceIds = new Set(sources.map(t => t.id));
    if (form === "handoff") this.sourceIds = new Set(sources.slice(0, 1).map(t => t.id));
  }
  async refresh() {
    await super.refresh();
    try {
      if (!this.projects.some(p => p.id === this.projectId)) this.projectId = this.projects[0]?.id;
      await refreshTicket(this);
      if (this.projectId) this.repos = await store.listRepos(this.projectId);
      const ids = [...new Set([this.projectId, ...this.shown, ...this.data.tickets.map(t => t.projectId)].filter(Boolean))];
      this.ruleMap = new Map();
      for (const id of ids) this.ruleMap.set(id, await store.boardRules(id));
      // A handoff nobody answered fails after an hour, so the card can offer Retry.
      await handoff.expireHandoffs().catch((error) => host.log("warn", `Couldn't expire handoffs: ${error}`));
    } catch (error) {
      this.error = String(error);
    }
  }
  onBoard(ticket) {
    return ticket.projectId === this.projectId || this.shown.has(ticket.projectId);
  }
  ticketsIn(stage, filtered = true) {
    const own = this.data.tickets.filter(t => this.onBoard(t) && t.stage === stage && (!filtered || ticketMatches(t, this.search.value())));
    return sortColumn(own, stage, this.projectId, [...this.shown]);
  }
  waitingTickets() {
    return STAGES.flatMap(stage => this.ticketsIn(stage, false).filter(t => !t.proposed && needsYou(t)));
  }
  jumpToNext(cx) {
    const waiting = this.waitingTickets();
    if (!waiting.length) return;
    this.jumpIndex = (this.jumpIndex + 1) % waiting.length;
    const target = waiting[this.jumpIndex];
    this.jumpId = target.id;
    this.ticketId = null;
    this.form = null;
    if (!ticketMatches(target, this.search.value())) this.search.set_value("");
    if (target.stage === "done") {
      const index = this.ticketsIn("done", false).findIndex(t => t.id === target.id);
      if (index >= this.doneLimit) this.doneLimit = index + 1;
    }
    cx.notify();
    cx.spawn(async () => { focusWhenMounted(this.jumpFocus); });
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
    cx.spawn(async () => { focusWhenMounted(this.formFocus); });
  }
  attentionButtons(cx) {
    const row = h_flex().gap_2().items_center();
    const need = this.waitingTickets();
    const looseCount = this.data.loose.filter(t => t.projectId === this.projectId || this.shown.has(t.projectId)).length;
    if (need.length) {
      const word = need.length === 1 ? "needs" : "need";
      row.child(h_flex().gap_1().items_center()
        .child(dot(cx, cx.theme().colors.primary))
        .child(button("next-needs", `${need.length} ${word} you`, cx => this.jumpToNext(cx)).tooltip("Jump to the next one. Press N.")));
    }
    if (looseCount || this.looseOpen) row.child(button("loose-toggle", `${looseCount} loose`, cx => this.openLoose(cx)).tooltip("Show threads on no ticket"));
    return row;
  }
  finishMove(cx, id, stage, resolution) {
    this.act(cx, async () => {
      const moved = await store.moveTicket(id, stage, resolution);
      const warning = moveWarning(moved);
      if (warning) this.note = warning;
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
  attachDialog(projectId, threadId) {
    const choices = this.data.tickets.filter(t => t.projectId === projectId && !t.proposed && t.stage !== "done");
    window.open_dialog(() => v_flex().gap_3()
      .child("Add this thread to a ticket.")
      .child(select(`attach-thread:${threadId}`, choices.map(t => ({ id: t.id, label: `#${t.number} ${t.title}` })), "Choose a ticket", (id, cx) => {
        window.close_dialog();
        this.act(cx, () => store.attach(id, threadId));
      }))
      .child(button(`cancel-attach:${threadId}`, "Cancel", () => window.close_dialog())));
  }
  remember() { return store.kvSet("board", JSON.stringify({ projectId: this.projectId, looseOpen: this.looseOpen, shown: [...this.shown] })); }
  dragSource(el, kind, id) {
    return el.on_drag(`${kind}:${id}`, (event, cx) => {
      if (event.phase === "started") this.drag = { kind, id };
      else { this.drag = null; this.over = null; }
      cx.notify();
    });
  }
  showDropHint(id, decision, event, cx) {
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
      .on_drag_move((event, cx) => this.showDropHint(id, decide(event.payload, event.side), event, cx))
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
  move(ticket, stage, cx, resolution = "done") {
    const plan = planMove(ticket, stage, resolution);
    if (plan.action === "ignore") return;
    if (plan.action === "refuse") { this.error = plan.reason; cx.notify(); return; }
    if (plan.action === "confirm-done") {
      const wont = plan.resolution === "wont-do";
      window.open_dialog(() => v_flex().gap_3()
        .child(`Move #${ticket.number} to Done${wont ? " as won't do" : ""}?`)
        .child("This archives every live thread on the ticket. Moving it out of Done brings back the threads this move archived. Won't do ends the ticket the same way.")
        .child(h_flex().gap_2().flex_wrap()
          .child(button(`cancel-done:${ticket.id}`, "Cancel", () => window.close_dialog()))
          .child(button(`alt-done:${ticket.id}`, wont ? "Move to Done and archive threads" : "Archive as won't do", cx => { window.close_dialog(); this.finishMove(cx, ticket.id, "done", wont ? "done" : "wont-do"); }))
          .child(primary(`confirm-done:${ticket.id}`, wont ? "Archive as won't do" : "Move to Done and archive threads", cx => { window.close_dialog(); this.finishMove(cx, ticket.id, "done", plan.resolution); }))));
      return;
    }
    if (plan.action === "handoff") {
      window.open_dialog(() => v_flex().gap_3()
        .child(`Move #${ticket.number} to ${TITLES[plan.stage]}?`)
        .child("Move keeps the current threads. Hand off asks a thread to write a handoff and starts a new one from it.")
        .child(h_flex().gap_2().flex_wrap()
          .child(button(`cancel-move:${ticket.id}`, "Cancel", () => window.close_dialog()))
          .child(button(`handoff-move:${ticket.id}`, "Hand off…", cx => {
            window.close_dialog();
            this.pendingMove = { id: ticket.id, stage: plan.stage };
            this.ticketId = ticket.id;
            this.act(cx, async () => { await this.prepare("handoff", ticket); this.persona = this.personas.includes(PERSONAS[plan.stage]) ? PERSONAS[plan.stage] : ""; });
          }))
          .child(button(`just-move:${ticket.id}`, "Move without starting a thread", cx => { window.close_dialog(); this.finishMove(cx, ticket.id, plan.stage, "done"); }))));
      return;
    }
    this.finishMove(cx, ticket.id, plan.stage, plan.resolution);
  }
  menu(ticket, _cx) {
    const menu = new DropdownMenu(`ticket-menu:${ticket.id}`, "···");
    menu.item("Open", cx => this.openTicket(ticket.id, cx));
    if (!ticket.proposed) {
      for (const stage of STAGES.filter(s => s !== ticket.stage)) menu.item(`Move to ${TITLES[stage]}`, cx => this.move(ticket, stage, cx));
      if (!(ticket.stage === "done" && ticket.resolution === "wont-do")) menu.item("Won't do", cx => this.move(ticket, "done", cx, "wont-do"));
      if (ticket.stage !== "done") menu.item("Start thread…", cx => {
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
    menu.item("Delete ticket…", cx => this.confirmDelete(ticket, cx));
    return menu;
  }
  confirmDelete(ticket, cx) {
    const count = ticket.threads.length;
    window.open_dialog(() => v_flex().gap_3()
      .child(`Delete #${ticket.number}?`)
      .child(count ? `Its ${count} thread${count === 1 ? "" : "s"} will be archived. You can unarchive them from kagan later.` : "The ticket and its comments will be deleted.")
      .child(h_flex().gap_2().justify_end()
        .child(button(`cancel-delete:${ticket.id}`, "Cancel", () => window.close_dialog()))
        .child(new KgButton(`confirm-delete:${ticket.id}`).danger().compact().label("Delete ticket").on_click((a, b) => {
          window.close_dialog();
          this.act(clickCx(a, b), async () => { await store.deleteTicket(ticket.id); this.ticketId = null; });
        }))));
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
    if (!this.projectId) return root.child(v_flex().flex_1().items_center().justify_center().child(muted("Create a project to see its tickets here.", cx)));
    if (this.ticketId && this.ticket) return root.child(renderTicket(this, cx));

    const projectRows = this.projects.map(p => ({ id: p.id, label: p.name }));
    const more = new DropdownMenu("board-more", "More");
    for (const p of this.projects.filter(p => p.id !== this.projectId)) {
      more.item(`${this.shown.has(p.id) ? "Hide" : "Also show"} ${p.name}`, cx => {
        this.shown.has(p.id) ? this.shown.delete(p.id) : this.shown.add(p.id);
        this.act(cx, () => this.remember());
      });
    }
    const projectName = this.projects.find(p => p.id === this.projectId)?.name ?? "this project";
    const left = h_flex().gap_1().items_center().min_w_0()
      .child(select("board-project", projectRows, projectName, (id, cx) => { this.jumpIndex = -1; this.act(cx, async () => { this.projectId = id; this.form = null; await this.remember(); }); }))
      .child(button("repos", this.repos.length ? `Repos ${this.repos.length}` : "Repos", cx => this.act(cx, async () => { this.form = "repos"; await github.maybeAutoLink(this.projectId); })).text_color(colors.muted_foreground))
      .child(button("rules", "Rules", cx => this.openRules(cx)).text_color(colors.muted_foreground));
    if (this.projects.length > 1) left.child(more);
    const toolbar = h_flex().gap_2().px_5().pt_4().pb_2().items_center()
      .child(left.flex_1())
      .child(this.attentionButtons(cx))
      .child(new Input(this.search).aria_label("Search tickets and threads").min_w("6rem").max_w("16rem").on_change((_, cx) => cx.notify()));
    root.child(toolbar);

    if (this.form) root.child(renderForm(this, cx).mx_5());
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
    const columns = h_flex().items_stretch().flex_1().min_h_0().min_w_0().gap_2().px_5().pb_3().overflow_x_scroll();
    if (this.looseOpen || this.drag?.kind === "thread") columns.child(renderLoose(this, cx, colors, radius, loose));
    columns.children(STAGES.map((stage, ix) => this.renderColumn(stage, ix, cx, colors, radius, boardRules, ownWorking, needle)));
    return root.child(columns);
  }
  renderColumn(stage, ix, cx, colors, radius, boardRules, ownWorking, needle) {
    const tickets = this.ticketsIn(stage);
    const visible = stage === "done" && !needle ? tickets.slice(0, this.doneLimit) : tickets;
    const over = stage === "in-progress" && boardRules.wipLimit !== null && ownWorking > boardRules.wipLimit;
    const active = this.over?.id === `column:${stage}`;
    const count = tiny(over ? `${ownWorking} / ${boardRules.wipLimit}` : String(tickets.length), cx, over ? colors.primary : colors.muted_foreground);
    if (over) count.font_weight(600);
    const heading = h_flex().gap_2().px_3().pt_3().pb_2().items_baseline()
      .child(div().font_weight(600).text_size(12).child(TITLES[stage]));
    if (over || tickets.length) heading.child(count);
    const column = v_flex().id(`column:${stage}`).flex_1().min_w("16rem").min_h_0().rounded(radius.lg)
      .bg(colors.surface).border_1().border_color(active ? colors.ring : colors.surface);
    this.dropTarget(column, `column:${stage}`, payload => dropOnColumn(payload, stage, this.data.tickets));
    column.child(heading);
    const cards = visible.map(ticket => renderCard(this, ticket, cx, colors, radius));
    const body = v_flex().gap_1().px_2().pb_2().children(cards);
    if (active && this.over.label) body.child(tiny(this.over.label, cx, colors.foreground).px_2().font_weight(600));
    else if (!tickets.length && !needle && this.drag) {
      body.child(v_flex().mx_1().py_6().items_center().rounded(radius.md)
        .border_1().border_dashed().border_color(colors.border)
        .child(tiny(this.drag.kind === "thread" ? "Drop to make a ticket" : "Drop here", cx)));
    }
    const dragging = Boolean(this.drag);
    if (stage === "backlog" && !needle && !dragging) {
      if (this.composerOpen) {
        body.child(div().mx_1()
          .on_key_down((event, cx) => {
            if (event.key !== "escape") return;
            this.composerOpen = false;
            this.composer.set_value("");
            this.refocusComposer = false;
            cx.stop_propagation();
            cx.notify();
          })
          .child(new Input(this.composer).aria_label("New ticket title")));
      } else {
        body.child(button("new-ticket", "+  New ticket", cx => {
          this.composerOpen = true;
          this.composer.set_value("");
          cx.notify();
          cx.spawn(async () => { focusWhenMounted(this.composerFocus); });
        }).mx_1());
      }
      if (this.repos.length) body.child(button("import-issue", "Import issue", cx => this.act(cx, async () => {
        this.form = "import";
        this.issues = await github.listIssues(this.projectId, { query: this.issueQuery.value(), ...this.issueFilters });
      })).mx_1());
    }
    column.child(new Scroll(this.columns[ix]).flex_1().min_h_0().child(body));
    if (stage === "done" && !needle && visible.length < tickets.length) {
      column.child(button("more-done", `Show ${tickets.length - visible.length} more`, cx => { this.doneLimit += 20; cx.notify(); }).mx_2().mb_2());
    }
    return column;
  }
}
