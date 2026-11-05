// @ts-check
import { KINDS, USER_STORY_WARNING, looksLikeUserStory, startProblem } from "./rules.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { DropdownMenu, Markdown, Scroll, Textarea, ThreadStatus } from "gpui-component";
import * as host from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import * as boardData from "./board-data.js";
import * as github from "./github.js";
import { briefingOf } from "./briefing.js";
import { TITLES, canBlock, commentWhen, criteriaLine, descriptionPreview, threadStatusLine } from "./model.js";
import { STATUS_WORD, button, divider, primary, select, tiny } from "./ui.js";
import { ago, threadTree } from "./ui-model.js";
import { renderHandoffState, renderPendingMove } from "./cards.js";
import { renderForm } from "./forms.js";

export async function refreshTicket(view) {
  if (view.ticketId) {
  const before = view.ticket?.updatedAt;
  try {
    view.ticket = await boardData.detail(view.ticketId);
  } catch (error) {
    view.error = `Couldn't read #${view.ticketId}: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (before !== view.ticket.updatedAt) await loadTicketExtras(view, view.ticket);
  } else {
  view.briefing = null;
  view.pulls = [];
  }
}
export async function loadTicketExtras(view, ticket) {
  const key = `seen:${ticket.id}`;
  const since = Number(await store.kvGet(key)) || 0;
  if (!since) {
    await store.kvSet(key, String(Date.now()));
    view.briefing = null;
    view.seenAt = 0;
  } else {
    const comments = (ticket.comments ?? []).filter(c => Number(c.createdAt) > since)
      .map(c => ({ body: String(c.body), createdAt: Number(c.createdAt), persona: c.persona ?? null }));
    const events = [];
    for (const thread of ticket.threads.slice(0, 6)) {
      const found = await threads.events(thread.id, { limit: 24, order: "desc" }).catch(() => []);
      for (const event of found) {
        const data = /** @type {any} */ (event.data ?? {});
        if (data.role === "user" && typeof data.text === "string" && Number(event.at) > since) events.push({ text: data.text, at: Number(event.at), role: "user" });
      }
    }
    view.briefing = briefingOf({
      comments,
      events,
      threads: ticket.threads.filter(thread => (thread.lastReadAt ?? 0) < thread.latestAttentionAt || thread.status === "error")
        .map(thread => ({ id: thread.id, title: thread.title, attention: thread.status === "error" ? "error" : "unread", at: thread.updatedAt })),
    });
    view.seenAt = since;
  }
  const pulse = await github.pullRequests(ticket).catch((error) => ({ pulls: [], error: String(error) }));
  view.pulls = pulse.pulls;
  view.pullsError = pulse.error;
  view.ticketRepos = await store.listRepos(ticket.projectId);
  view.changes = [];
  for (const thread of ticket.threads) {
    const changed = await threads.changes(thread.id, "branch").catch(() => null);
    if (changed?.repository) view.changes.push({ threadId: thread.id, title: thread.title, added: changed.added, removed: changed.removed, base: changed.base });
  }
  }
export function dismissBriefing(view) {
  view.briefing = null;
  if (view.ticket) return store.kvSet(`seen:${view.ticket.id}`, String(Date.now()));
  }
export function renderTicket(view, cx) {
  const t = view.ticket;
  const colors = cx.theme().colors;
  const stageLine = `${TITLES[t.stage]}${t.stage === "done" && t.resolution === "wont-do" ? " · won't do" : ""}${t.pendingStage ? ` · Move to ${TITLES[t.pendingStage]} awaiting approval` : ""}`;
  const head = h_flex().gap_3().px_5().pt_4().pb_2().items_center().flex_wrap()
    .child(button("back-board", "Board", cx => { view.ticketId = null; view.form = null; view.pendingMove = null; cx.notify(); }))
    .child(v_flex().gap_1().flex_1().min_w_0()
      .child(h_flex().gap_2().items_baseline()
        .child(tiny(`#${t.number}`, cx).text_size(15))
        .child(div().font_weight(600).text_size(16).child(t.title)))
      .child(tiny(stageLine, cx)))
    .child(select("ticket-kind", [{ id: "none", label: "No kind" }, ...KINDS.map(kind => ({ id: kind, label: kind[0].toUpperCase() + kind.slice(1) }))], t.kind ? t.kind[0].toUpperCase() + t.kind.slice(1) : "No kind", (id, cx) => view.act(cx, () => store.editTicket(t.id, { kind: id === "none" ? null : id }))))
    .child(view.attentionButtons(cx))
    .child(view.menu(t, cx));
  const tabs = h_flex().gap_1().px_5().items_center()
    .child(button("tab-overview", "Overview", cx => { view.section = "overview"; view.form = null; cx.notify(); }))
    .child(button("tab-activity", `Activity${t.comments.length ? ` · ${t.comments.length}` : ""}`, cx => { view.section = "activity"; cx.notify(); }))
    .child(button("tab-reviews", `Reviews${view.pulls.length ? ` · ${view.pulls.length}` : ""}`, cx => { view.section = "reviews"; cx.notify(); }));
  const body = v_flex().p_5().gap_4();
  if (looksLikeUserStory(t.title)) body.child(tiny(USER_STORY_WARNING, cx));
  if (t.proposed) body.child(h_flex().gap_2().child(button("accept-ticket", "Accept ticket", cx => view.act(cx, () => store.acceptTicket(t.id)))).child(button("dismiss-ticket", "Dismiss", cx => view.act(cx, async () => { await store.dismissTicket(t.id); view.ticketId = null; }))));
  if (t.pendingStage) body.child(renderPendingMove(view, t, cx, "detail"));
  const job = renderHandoffState(view, t, cx, "detail");
  if (job) body.child(job);

  if (view.section === "overview") {
    if (view.briefing) body.child(renderBriefing(view, cx));
    if (t.proposed) body.child(tiny(descriptionPreview(t.description) ?? "No description", cx));
    else {
      const ac = criteriaLine(t.description, t.kind);
      if (ac) body.child(tiny(ac, cx));
      const held = t.stage === "backlog" ? startProblem(t) : null;
      if (held) body.child(tiny(`Can't leave Backlog yet: ${held}.`, cx));
      body.child(new Markdown(`description:${t.id}`, t.description || "Add a description"));
      body.child(h_flex().gap_2()
        .child(button("edit-ticket", "Edit ticket…", cx => { view.form = "edit"; view.title.set_value(t.title); view.description.set_value(t.description); cx.notify(); }))
        .child(button("start-thread", "Start thread", cx => view.act(cx, () => view.prepare("start", t)))));
    }
    if (view.form) body.child(renderForm(view, cx));
    if (!t.proposed) {
      body.child(renderRelationships(view, cx, t));
      body.child(renderThreads(view, cx, t));
    }
  } else if (view.section === "activity") {
    body.child(renderComments(view, cx, t));
  } else {
    body.child(renderReviews(view, cx, t));
  }
  return v_flex().size_full().min_h_0().child(head).child(tabs).child(new Scroll(view.scroll).flex_1().min_h_0().child(body));
  }
export function renderBriefing(view, cx) {
  const colors = cx.theme().colors;
  const b = view.briefing;
  const card = v_flex().gap_2().p_3().rounded(cx.theme().radius.md).border_1().border_color(colors.border);
  card.child(h_flex().gap_2().items_baseline()
    .child(div().font_weight(600).text_size(13).child("Since you were here"))
    .child(tiny(ago(view.seenAt), cx))
    .child(div().flex_1())
    .child(button("dismiss-briefing", "Got it", cx => view.act(cx, () => dismissBriefing(view)))));
  if (b.you) card.child(v_flex().gap_1()
    .child(tiny(`You last said · ${ago(b.you.at)}`, cx))
    .child(div().text_size(12).child(b.you.text)));
  for (const note of b.notes) {
    card.child(tiny(`${note.persona ?? "A thread"} handed off · ${ago(note.at)}`, cx));
    for (const line of note.done) card.child(tiny(`• ${line}`, cx));
    for (const line of note.verified) card.child(tiny(`✓ ${line}`, cx));
    if (note.unverified.length) {
      card.child(tiny("Not verified", cx));
      for (const line of note.unverified) card.child(tiny(`• ${line}`, cx));
    }
  }
  if (b.blocked) {
    card.child(tiny("Blocked", cx, colors.destructive));
    card.child(div().text_size(12).child(b.blocked));
  }
  if (b.waiting) {
    card.child(v_flex().gap_1().p_2().rounded(cx.theme().radius.sm).border_1().border_color(colors.primary)
      .child(tiny(`${STATUS_WORD[b.waiting.attention] ?? "Needs you"} · ${b.waiting.title}`, cx))
      .child(button("briefing-open", "Open thread", cx => view.act(cx, () => host.openThread(b.waiting.id)))));
  } else if (b.next) {
    card.child(h_flex().gap_1().items_baseline().child(tiny("Next", cx)).child(div().text_size(12).child(b.next)));
  }
  return card;
  }
export function renderRelationships(view, cx, t) {
  const colors = cx.theme().colors;
  const section = v_flex().gap_2().pt_3();
  section.child(divider(colors));
  section.child(div().font_weight(600).text_size(12).child("Relationships"));
  section.child(tiny("Parent", cx));
  if (t.parent) section.child(h_flex().gap_2().items_center()
    .child(button(`parent-open:${t.parent.id}`, `#${t.parent.number} ${t.parent.title}`, cx => view.openTicket(t.parent.id, cx)).flex_1())
    .child(button(`unparent:${t.id}`, "×", cx => view.act(cx, () => store.setParent(t.id, null))).tooltip("Take it out of its parent")));
  else {
    const choices = view.data.tickets.filter(p => p.id !== t.id && p.projectId === t.projectId && !p.proposed);
    if (choices.length) section.child(select("parent-ticket", choices.map(p => ({ id: p.id, label: `#${p.number} ${p.title}` })), "Set parent…", (id, cx) => view.act(cx, () => store.setParent(t.id, id))));
  }
  section.child(tiny("Sub-tickets", cx));
  for (const child of t.subTickets ?? []) section.child(h_flex().gap_2().items_center()
    .child(button(`sub:${child.id}`, `#${child.number} ${child.title} · ${TITLES[child.stage]}${child.resolution === "wont-do" ? " · won't do" : ""}`, cx => view.openTicket(child.id, cx)).flex_1())
    .child(button(`unsub:${child.id}`, "×", cx => view.act(cx, () => store.setParent(child.id, null))).tooltip("Take it out of this ticket")));
  const childChoices = view.data.tickets.filter(p => p.id !== t.id && p.projectId === t.projectId && !p.proposed && !p.parentId);
  if (childChoices.length) section.child(select("add-sub", childChoices.map(p => ({ id: p.id, label: `#${p.number} ${p.title}` })), "Add sub-ticket", (id, cx) => view.act(cx, () => store.setParent(id, t.id))));
  section.child(tiny("Blocked by", cx));
  for (const blocker of t.blockedBy ?? []) section.child(h_flex().gap_2().items_center()
    .child(button(`open-blocker:${blocker.id}`, `#${blocker.number} ${blocker.title} · ${TITLES[blocker.stage]}`, cx => view.openTicket(blocker.id, cx)).flex_1())
    .child(button(`remove-blocker:${blocker.id}`, "×", cx => view.act(cx, () => store.unblockTicket(t.id, blocker.id))).tooltip("Remove blocker")));
  const blockerChoices = view.data.tickets.filter(p => canBlock(view.data.tickets, t.id, p.id));
  if (blockerChoices.length) section.child(select("add-blocker", blockerChoices.map(p => ({ id: p.id, label: `#${p.number} ${p.title}` })), "Add blocker", (id, cx) => view.act(cx, () => store.blockTicket(t.id, id))));
  if ((t.blocks ?? []).length) {
    section.child(tiny("Blocks", cx));
    for (const blocked of t.blocks) section.child(button(`blocks:${blocked.id}`, `#${blocked.number} ${blocked.title}`, cx => view.openTicket(blocked.id, cx)));
  }
  if (t.issue) section.child(button("open-issue", `Copied from ${t.issue.repo}#${t.issue.number}`, cx => view.act(cx, () => host.openUrl(t.issue.url))));
  return section;
  }
export function renderThreads(view, cx, t) {
  const colors = cx.theme().colors;
  const section = v_flex().gap_2().pt_3();
  section.child(divider(colors));
  const quiet = threadStatusLine(t.threads);
  section.child(h_flex().gap_2().items_baseline()
    .child(div().font_weight(600).text_size(12).child(`Threads · ${t.threads.length}`))
    .when(Boolean(quiet), el => el.child(tiny(String(quiet).replace("Thread status · ", ""), cx))));
  const archived = (t.archivedByDone ?? []).filter(thread => !t.threads.some(live => live.id === thread.id));
  if (archived.length) section.child(tiny(`${archived.length} archived by Done · moving out of Done brings them back`, cx));
  for (const [thread, depth] of threadTree(t.threads)) {
    const project = view.projects.find(p => p.id === thread.projectId);
    const link = (t.links ?? []).find(item => item.threadId === thread.id);
    const menu = new DropdownMenu(`thread-menu:${thread.id}`, "···")
      .item(thread.pinned ? "Unpin" : "Pin", cx => view.act(cx, () => threads.setPinned(thread.id, !thread.pinned)))
      .item("Remove thread from ticket", cx => view.act(cx, () => store.detach(thread.id)))
      .item("Archive thread", cx => view.act(cx, async () => { await threads.archive(thread.id); store.touch(); }));
    section.child(h_flex().gap_2().items_center().pl(`${depth * 0.75}rem`)
      .child(new ThreadStatus(thread.id))
      .child(button(`ticket-thread:${thread.id}`, `${depth ? "↳ " : ""}${thread.title}${thread.projectId !== t.projectId ? ` · ${project?.name ?? thread.projectId}` : ""}${link?.persona ? ` · ${link.persona}` : ""}`, cx => view.act(cx, () => host.openThread(thread.id))).flex_1().min_w_0())
      .child(menu));
  }
  if (!t.threads.length) section.child(tiny("No live thread.", cx));
  if (t.stage !== "done") {
    section.child(h_flex().gap_2().flex_wrap()
      .child(button("attach-thread", "Attach a thread with no ticket", cx => { view.form = "attach"; cx.notify(); }))
      .when(t.handoffSources.length > 0, el => el.child(button("handoff-thread", "Hand off…", cx => view.act(cx, () => view.prepare("handoff", t)))))
      .when(t.handoffSources.length > 1, el => el.child(button("consolidate-threads", "Consolidate…", cx => view.act(cx, () => view.prepare("consolidate", t))))));
  }
  return section;
  }
export function renderComments(view, cx, t) {
  const colors = cx.theme().colors;
  const section = v_flex().gap_3().pt_3();
  section.child(divider(colors));
  if (!t.comments.length) section.child(tiny("No comments yet.", cx));
  for (const comment of t.comments) {
    const who = comment.githubLogin ? `@${comment.githubLogin} on GitHub` : comment.persona ?? comment.threadId ?? "You";
    const when = commentWhen(comment.createdAt);
    const head = h_flex().gap_2().items_baseline()
      .child(tiny(who, cx, colors.foreground).font_weight(600))
      .when(Boolean(comment.threadId), el => el.child(button(`comment-thread:${comment.id}`, "Open thread", cx => view.act(cx, () => host.openThread(comment.threadId))).text_size(11)))
      .when(Boolean(when), el => el.child(tiny(when, cx)))
      .when(comment.updatedAt !== comment.createdAt, el => el.child(tiny("· edited", cx)))
      .child(h_flex().flex_1().justify_end()
        .child(button(`comment-edit:${comment.id}`, "Edit", cx => { view.editCommentId = comment.id; view.comment.set_value(comment.body); cx.notify(); }))
        .child(button(`comment-delete:${comment.id}`, "Delete", cx => view.act(cx, () => store.deleteComment(comment.id)))));
    section.child(v_flex().gap_1().child(head).child(new Markdown(comment.id, comment.body)));
  }
  section.child(new Textarea(view.comment).aria_label(view.editCommentId ? "Edit comment" : "Add a comment"));
  section.child(h_flex().gap_2().justify_end()
    .when(Boolean(view.editCommentId), el => el.child(button("cancel-comment", "Cancel", cx => { view.editCommentId = null; view.comment.set_value(""); cx.notify(); })))
    .child(primary("save-comment", view.editCommentId ? "Save" : "Comment", cx => view.act(cx, async () => {
      if (view.editCommentId) await store.editComment(view.editCommentId, view.comment.value());
      else await store.addComment(t.id, { body: view.comment.value() });
      view.editCommentId = null; view.comment.set_value("");
    })).disabled(view.busy)));
  return section;
  }
export function renderReviews(view, cx, t) {
  const colors = cx.theme().colors;
  const section = v_flex().gap_3().pt_3();
  section.child(divider(colors));
  section.child(div().font_weight(600).text_size(12).child("Changes"));
  if (!view.changes.length) section.child(tiny("No changed repo is readable for this ticket's threads.", cx));
  for (const change of view.changes) section.child(h_flex().gap_2().items_center()
    .child(button(`change:${change.threadId}`, change.title, cx => view.act(cx, () => host.openThread(change.threadId))).flex_1().min_w_0())
    .child(tiny(`+${change.added} −${change.removed}`, cx))
    .when(Boolean(change.base), el => el.child(tiny(`vs ${change.base}`, cx))));
  section.child(div().font_weight(600).text_size(12).child("Repos"));
  if (!view.ticketRepos.length) section.child(tiny("No repo is linked. Use Repos above to link one.", cx));
  for (const repo of view.ticketRepos) section.child(h_flex().gap_2().items_center()
    .child(tiny(repo, cx, colors.foreground).flex_1())
    .child(button(`unlink:${repo}`, "Unlink", cx => view.act(cx, () => store.unlinkRepo(t.projectId, repo)))));
  section.child(div().font_weight(600).text_size(12).child("Pull requests"));
  if (view.pullsError) section.child(tiny(`Couldn't read pull requests: ${view.pullsError}`, cx, colors.destructive));
  else if (!view.pulls.length) section.child(tiny("No pull request for this ticket's branch.", cx));
  for (const pull of view.pulls) {
    const checks = `${pull.checks.passed} passed${pull.checks.failed ? ` · ${pull.checks.failed} failed` : ""}${pull.checks.pending ? ` · ${pull.checks.pending} pending` : ""}`;
    section.child(h_flex().gap_2().items_center()
      .child(button(`pull:${pull.url}`, `${pull.repo.split("/").at(-1)}#${pull.number} ${pull.title}`, cx => view.act(cx, () => host.openUrl(pull.url))).flex_1().min_w_0())
      .child(tiny(`${pull.isDraft ? "Draft" : pull.state}${pull.mergedAt ? " · merged" : ""}`, cx))
      .child(tiny(checks, cx, pull.checks.failed ? colors.destructive : colors.muted_foreground)));
  }
  section.child(div().font_weight(600).text_size(12).child("Stage history"));
  for (const entry of t.stageHistory ?? []) {
    section.child(h_flex().gap_2().items_baseline()
      .child(tiny(TITLES[entry.stage] ?? entry.stage, cx, colors.foreground))
      .when(entry.resolution === "wont-do", el => el.child(tiny("won't do", cx)))
      .child(tiny(new Date(entry.at).toLocaleString(), cx)));
  }
  return section;
}
