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
import { STAGES, TITLES, PERSONAS, GLYPHS, attention, needsYou, target, matches, sidebarRows } from "./model.js";

function clickCx(a, b) { return b ?? a; }
function button(id, label, callback) {
  return new KgButton(id).label(label).ghost().on_click((a, b) => callback(clickCx(a, b)));
}
function muted(message, cx) { return div().text_color(cx.theme().colors.muted_foreground).child(message); }
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
    cx.notify();
    cx.spawn(async cx => {
      try { await fn(); await this.refresh(); }
      catch (error) { this.error = String(error); }
      finally { this.busy = false; cx.notify(); }
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
    this.search = InputState("Search tickets and threads");
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
    this.columns = STAGES.map(() => ScrollbarHandle());
    this.pendingMove = null;
    this.sourceIds = new Set();
    super.init(props, cx);
    this.contextTask = cx.spawn(async cx => {
      const state = await store.kvJson("board", {});
      this.projectId ??= state.projectId;
      this.looseOpen = Boolean(state.looseOpen);
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
  }
  remember() { return store.kvSet("board", JSON.stringify({ projectId: this.projectId, looseOpen: this.looseOpen })); }
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
  move(ticket, stage, cx) {
    if (stage === "done" && ticket.threads.length) {
      window.open_dialog(() => v_flex().gap_3()
        .child(`Move #${ticket.number} to Done?`)
        .child("This archives every live thread on the ticket.")
        .child(h_flex().gap_2()
          .child(button(`cancel-done:${ticket.id}`, "Cancel", () => window.close_dialog()))
          .child(button(`confirm-done:${ticket.id}`, "Move to Done and archive threads", cx => { window.close_dialog(); this.act(cx, () => store.moveTicket(ticket.id, stage)); }))));
    } else if (["in-progress", "review"].includes(stage) && ticket.threads.length) {
      window.open_dialog(() => v_flex().gap_3()
        .child(`Move #${ticket.number} to ${TITLES[stage]}?`)
        .child("Move keeps the current threads. Hand off starts a new thread and archives the ones you pick.")
        .child(h_flex().gap_2()
          .child(button(`cancel-move:${ticket.id}`, "Cancel", () => window.close_dialog()))
          .child(button(`handoff-move:${ticket.id}`, "Hand off…", cx => {
            window.close_dialog();
            this.pendingMove = { id: ticket.id, stage };
            this.ticketId = ticket.id;
            this.act(cx, async () => { await this.prepare("handoff", ticket); this.persona = this.personas.includes(PERSONAS[stage]) ? PERSONAS[stage] : ""; });
          }))
          .child(button(`just-move:${ticket.id}`, "Move without starting a thread", cx => { window.close_dialog(); this.act(cx, () => store.moveTicket(ticket.id, stage)); }))));
    } else this.act(cx, () => store.moveTicket(ticket.id, stage));
  }
  menu(ticket, cx) {
    const menu = new DropdownMenu(`ticket-menu:${ticket.id}`, "Ticket actions");
    menu.item(`Open ticket #${ticket.number}`, cx => this.openTicket(ticket.id, cx));
    if (!ticket.proposed) {
      for (const stage of STAGES.filter(s => s !== ticket.stage)) menu.item(`Move to ${TITLES[stage]}`, cx => this.move(ticket, stage, cx));
      if (ticket.stage !== "done") menu.item("Start thread…", cx => {
        this.ticketId = ticket.id;
        this.act(cx, () => this.prepare("start", ticket));
      });
    }
    return menu;
  }
  render(cx) {
    const colors = cx.theme().colors;
    const root = v_flex().size_full().min_w_0().min_h_0().bg(colors.background).text_color(colors.foreground).gap_2();
    if (this.error) root.child(h_flex().gap_2().px_4().child(muted(this.error, cx)).child(button("retry-board", "Retry", cx => this.act(cx, () => this.refresh()))));
    if (!this.projectId) return root.child(muted("Open or create a project to use the board", cx));
    if (this.ticketId && this.ticket) return root.child(this.renderTicket(cx));
    const projectRows = this.projects.map(p => ({ id: p.id, label: p.name }));
    const own = this.data.tickets.filter(t => (t.projectId === this.projectId || this.shown.has(t.projectId)) && matches(t, this.search.value()));
    const need = own.filter(needsYou);
    const looseCount = this.data.loose.filter(t => t.projectId === this.projectId).length;
    root.child(h_flex().gap_2().px_4().py_2().flex_wrap()
      .child(select("board-project", projectRows, this.projects.find(p => p.id === this.projectId)?.name ?? "Project", (id, cx) => this.act(cx, async () => { this.projectId = id; this.form = null; await this.remember(); })))
      .child(new Input(this.search).aria_label("Search tickets").flex_1().min_w("10rem").on_change((_, cx) => cx.notify()))
      .child(button("new-ticket", "Create ticket", cx => { this.form = "new"; this.title.set_value(""); this.description.set_value(""); cx.notify(); }))
      .child(button("repos", "Link GitHub repos", cx => this.act(cx, async () => { this.form = "repos"; await github.maybeAutoLink(this.projectId); })))
      .child(button("loose-toggle", looseCount ? `Show ${looseCount} threads with no ticket` : "No threads without a ticket", cx => this.act(cx, async () => { this.looseOpen = !this.looseOpen; await this.remember(); })).disabled(looseCount === 0)));
    root.child(h_flex().gap_2().px_4().flex_wrap()
      .child(button("next-needs", need.length ? `Open next ticket that needs you (${need.length})` : "No tickets need you", cx => { if (need.length) this.openTicket(need[0].id, cx); }).disabled(need.length === 0))
      .child(new DropdownMenu("show-projects", "Show other projects").map(menu => {
        for (const p of this.projects.filter(p => p.id !== this.projectId)) menu.item(`${this.shown.has(p.id) ? "Hide" : "Show"} ${p.name}`, cx => { this.shown.has(p.id) ? this.shown.delete(p.id) : this.shown.add(p.id); cx.notify(); });
        return menu;
      })));
    if (this.form) root.child(this.renderForm(cx));
    if (this.looseOpen) root.child(new Scroll(this.scroll).max_h("10rem").child(v_flex().px_4().children(this.data.loose.filter(t => t.projectId === this.projectId).map(t => h_flex().gap_2()
      .child(button(`loose-open:${t.id}`, t.title, cx => this.act(cx, () => host.openThread(t.id))))
      .child(button(`loose-new:${t.id}`, "Create ticket from thread", cx => this.act(cx, () => store.createTicket({ projectId: this.projectId, title: t.title, threadId: t.id }))))))));
    root.child(h_flex().items_stretch().flex_1().min_h_0().min_w_0().gap_2().px_3().pb_3().overflow_x_scroll().children(STAGES.map((stage, ix) => {
      const tickets = own.filter(t => t.stage === stage).sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || b.updatedAt - a.updatedAt);
      const visible = stage === "done" ? tickets.slice(0, this.doneLimit) : tickets;
      const heading = h_flex().gap_2().px_3().pt_3().pb_1().items_center()
        .child(div().child(TITLES[stage]));
      if (tickets.length) heading.child(div().text_color(colors.muted_foreground).child(String(tickets.length)));
      const column = v_flex().flex_1().min_w("12rem").max_w("24rem").min_h_0().rounded(cx.theme().radius.md).bg(colors.surface).child(heading);
      const cards = visible.map(t => {
        const parent = t.parentId ? this.data.tickets.find(p => p.id === t.parentId) : null;
        const children = this.data.tickets.filter(c => c.parentId === t.id);
        const card = v_flex().gap_1().px_3().py_2().border_1().border_color(colors.border).rounded(cx.theme().radius.md).bg(colors.background);
        if (t.proposed) card.border_dashed();
        card.child(h_flex().gap_2().items_start()
          .child(div().text_color(colors.muted_foreground).child(`#${t.number}`))
          .child(new KgButton(`card:${t.id}`).label(t.title).ghost().flex_1().min_w_0().on_click((a, b) => this.openTicket(t.id, clickCx(a, b))))
          .child(this.menu(t, cx)));
        if (!t.proposed) {
          const moves = STAGES.filter(s => s !== t.stage).map(s => button(`move:${t.id}:${s}`, `Move to ${TITLES[s]}`, cx => this.move(t, s, cx)));
          card.child(h_flex().gap_1().flex_wrap().children(moves));
        }
        if (t.proposed) card.child(h_flex().gap_2()
          .child(button(`accept:${t.id}`, "Accept ticket", cx => this.act(cx, () => store.acceptTicket(t.id))))
          .child(button(`dismiss:${t.id}`, "Dismiss proposal", cx => this.act(cx, () => store.dismissTicket(t.id)))));
        if (needsYou(t) && !t.proposed) card.child(muted("Needs you", cx));
        if (parent) card.child(muted(`Sub-ticket of #${parent.number}`, cx));
        if (children.length) card.child(muted(`${children.filter(c => c.stage === "done").length} of ${children.length} sub-tickets done`, cx));
        if (t.projectId !== this.projectId) card.child(muted(this.projects.find(p => p.id === t.projectId)?.name ?? t.projectId, cx));
        const thread = target(t.threads);
        if (thread) card.child(h_flex().gap_2().child(new ThreadStatus(thread.id)).child(button(`card-thread:${thread.id}`, thread.title, cx => this.act(cx, () => host.openThread(thread.id)))));
        return card;
      });
      const body = v_flex().gap_2().px_2().py_2().children(cards);
      if (stage === "backlog" && !tickets.length && !this.search.value().trim()) {
        body.child(button("empty-create", "Create your first ticket", cx => { this.form = "new"; this.title.set_value(""); this.description.set_value(""); cx.notify(); }));
      }
      column.child(new Scroll(this.columns[ix]).flex_1().min_h_0().child(body));
      if (stage === "done" && visible.length < tickets.length) column.child(button("more-done", `Show ${tickets.length - visible.length} more`, cx => { this.doneLimit += 20; cx.notify(); }));
      return column;
    })));
    return root;
  }
  renderTicket(cx) {
    const t = this.ticket;
    const head = h_flex().gap_2().px_4().py_2()
      .child(button("back-board", "Back to board", cx => { this.ticketId = null; this.form = null; this.pendingMove = null; cx.notify(); }))
      .child(div().flex_1().child(`#${t.number} ${t.title}`)).child(this.menu(t, cx));
    const body = v_flex().p_4().gap_3();
    body.child(muted(TITLES[t.stage], cx));
    if (t.proposed) body.child(h_flex().gap_2().child(button("accept-ticket", "Accept ticket", cx => this.act(cx, () => store.acceptTicket(t.id)))).child(button("dismiss-ticket", "Dismiss", cx => this.act(cx, async () => { await store.dismissTicket(t.id); this.ticketId = null; }))));
    if (t.pendingStage) body.child(h_flex().gap_2().child(`Move to ${TITLES[t.pendingStage]}?`)
      .child(button("accept-move", "Move", cx => this.move(t, t.pendingStage, cx)))
      .child(button("dismiss-move", "Dismiss", cx => this.act(cx, () => store.dismissMove(t.id)))));
    body.child(new Markdown(`description:${t.id}`, t.description || "No description"));
    body.child(button("edit-ticket", "Edit ticket…", cx => { this.form = "edit"; this.title.set_value(t.title); this.description.set_value(t.description); cx.notify(); }));
    if (t.issue) body.child(button("open-issue", `${t.issue.repo}#${t.issue.number}`, cx => this.act(cx, () => host.openUrl(t.issue.url))));
    body.child(div().child(`Threads · ${t.threads.length}`));
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
    }
    for (const child of t.subTickets) body.child(button(`sub:${child.id}`, `↳ #${child.number} ${child.title} · ${TITLES[child.stage]}`, cx => this.openTicket(child.id, cx)));
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
    const form = v_flex().p_4().gap_2().border_1().border_color(cx.theme().colors.border);
    const cancel = button("cancel-form", "Cancel", cx => { this.form = null; this.pendingMove = null; cx.notify(); });
    if (this.form === "new" || this.form === "edit") {
      form.child(div().id("ticket-title").child(new Input(this.title).aria_label("Ticket title").on_change((_, cx) => cx.notify()))).child(new Textarea(this.description).aria_label("Description"));
      const titleOk = this.title.value().trim().length > 0 && this.title.value().trim().length <= 200;
      form.child(h_flex().gap_2().child(cancel).child(new KgButton("save-ticket").primary().label(this.form === "new" ? "Create ticket" : "Save ticket").disabled(this.busy || !titleOk).on_click((a, b) => this.act(clickCx(a, b), async () => {
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
      if (this.pendingMove) actions.child(button("just-move", "Move without starting a thread", cx => this.act(cx, async () => { await store.moveTicket(this.pendingMove.id, this.pendingMove.stage); this.pendingMove = null; this.form = null; })));
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
    } else if (this.form === "repos") {
      for (const repo of this.repos) form.child(h_flex().gap_2().child(repo).child(button(`unlink:${repo}`, "Unlink", cx => this.act(cx, () => store.unlinkRepo(this.projectId, repo)))));
      form.child(h_flex().gap_2().child(new Input(this.repo).aria_label("GitHub repository")).child(button("link-repo", "Link", cx => this.act(cx, async () => { await store.linkRepo(this.projectId, await github.normalizeRepo(this.repo.value())); this.repo.set_value(""); }))));
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
    this.frozen = [];
    this.selected = null;
    this.focus = cx.focus_handle();
    super.init(props, cx);
    this.context = followContext(cx);
    this.preferences = cx.spawn(async cx => {
      const saved = await store.kvJson("sidebar", []);
      this.collapsed = new Set(saved);
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
  render(cx) {
    const rows = this.rows();
    const colors = cx.theme().colors;
    return v_flex().size_full().min_h_0().track_focus(this.focus).tab_stop(true)
      .on_hover((hover, cx) => { this.frozen = hover ? rows.map(r => r.id) : []; cx.notify(); })
      .on_key_down((event, cx) => {
        const ix = Math.max(0, rows.findIndex(r => r.id === this.selected));
        if (event.key === "down" || event.key === "up") { this.selected = rows[Math.max(0, Math.min(rows.length - 1, ix + (event.key === "down" ? 1 : -1)))]?.id; cx.notify(); }
        else if (event.key === "enter" && rows[ix]) this.open(rows[ix], cx);
        else if (event.key === "n") { const need = [...rows.slice(ix + 1), ...rows.slice(0, ix + 1)].find(r => r.needs && !r.project); if (need) { this.selected = need.id; this.open(need, cx); } }
        else if (["left", "right"].includes(event.key) && rows[ix]?.ticket) { event.key === "right" ? this.expanded.add(rows[ix].ticket.id) : this.expanded.delete(rows[ix].ticket.id); cx.notify(); }
      })
      .child(this.error ? muted(this.error, cx) : "")
      .child(new Scroll(this.scroll).flex_1().min_h_0().child(v_flex().id("kanban-sidebar").children(rows.map(row => {
        if (row.project) return h_flex().w_full().h_8().px_2().gap_2()
          .child(button(`collapse:${row.id}`, this.collapsed.has(row.id) ? "Expand project" : "Collapse project", cx => this.act(cx, async () => { this.collapsed.has(row.id) ? this.collapsed.delete(row.id) : this.collapsed.add(row.id); await store.kvSet("sidebar", JSON.stringify([...this.collapsed])); })))
          .child(button(`project:${row.id}`, `${row.project.name}${row.needs ? ` · ${row.needs} need you` : ""}`, cx => this.open(row, cx)).flex_1());
        const title = row.ticket && !row.id.startsWith("child:") ? `${GLYPHS[row.ticket.stage]} #${row.ticket.number} ${row.ticket.title}` : `· ${row.thread.title}${row.thread.projectId !== row.ticket?.projectId && row.ticket ? ` · ${this.projects.find(p => p.id === row.thread.projectId)?.name ?? ""}` : ""}`;
        const line = h_flex().w_full().h_8().gap_1().px_2().pl(`${(row.depth + 1) * 0.75}rem`).bg(row.id === this.selected || row.thread?.id === host.context().threadId ? colors.selection : colors.surface)
          .child(div().flex_1().min_w_0().overflow_hidden().child(button(`row:${row.id}`, title, cx => { this.selected = row.id; this.open(row, cx); })));
        if (row.thread) line.child(new ThreadStatus(row.thread.id));
        if (row.ticket?.proposed) line.child(muted("Proposed", cx));
        if (row.threads?.length > 1) line.child(button(`expand:${row.id}`, `Show ${row.threads.length} threads`, cx => { this.expanded.has(row.id) ? this.expanded.delete(row.id) : this.expanded.add(row.id); cx.notify(); }));
        if (row.ticket && !row.ticket.proposed) line.child(button(`board:${row.id}`, "Open on board", cx => this.act(cx, () => boardLink(row.ticket.projectId, row.ticket.id))));
        if (row.thread) line.child(button(`archive:${row.id}`, "Archive thread", cx => this.act(cx, async () => { await threads.archive(row.thread.id); store.touch(); })));
        if (row.thread && !row.ticket) line.child(button(`newtkt:${row.id}`, "Create ticket", cx => this.act(cx, () => store.createTicket({ projectId: row.thread.projectId, title: row.thread.title, threadId: row.thread.id }))));
        return line;
      }))));
  }
}
