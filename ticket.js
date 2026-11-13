// @ts-check
import { KINDS, USER_STORY_WARNING, kindWord, looksLikeUserStory, startProblem } from "./rules.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { DropdownMenu, KgButton, Markdown, Scroll, Textarea, ThreadStatus, WarningAlert } from "gpui-component";
import * as host from "kagan/host";
import * as threads from "kagan/threads";
import * as store from "./store.js";
import * as boardData from "./board-data.js";
import * as github from "./github.js";
import { briefingOf } from "./briefing.js";
import { TITLES, canBlock, canNest, commentWhen, criteriaLine, descriptionPreview, threadStatusLine } from "./model.js";
import { HANDING_OFF, STATUS_WORD, button, clickCx, focusWhenMounted, link, primary, tiny } from "./ui.js";
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
const SECTIONS = ["overview", "activity", "reviews"];

function sheet() {
  return v_flex().w_full().max_w("42rem").mx_auto().px_6();
}
/** bb's ticket is flat: sections sit on the page, split by a hairline, not boxed. */
function surface(cx) {
  const colors = cx.theme().colors;
  return v_flex().gap_2().pt_4().border_t_1().border_color(colors.border);
}
/** A section heading in bb's small muted type. */
function heading(text, cx) {
  return div().font_weight(500).text_size(12).text_color(cx.theme().colors.muted_foreground).child(text);
}
/** A row that opens a ticket or a thread: wrapping is cut with an ellipsis, and the row is left-aligned. */
function rowLink(id, label, cx, onOpen) {
  const colors = cx.theme().colors;
  return h_flex().id(id).role("button").accessibility_label(label).flex_1().min_w_0().px_1().py(2).rounded(cx.theme().radius.sm)
    .cursor_pointer().hover(el => el.bg(colors.muted))
    .on_click((_event, cx) => onOpen(cx))
    .child(div().flex_1().min_w_0().truncate().text_size(13).text_color(colors.foreground).child(label));
}
function beginEdit(view, cx) {
  view.section = "overview";
  view.form = "edit";
  view.title.set_value(view.ticket.title);
  view.description.set_value(view.ticket.description ?? "");
  cx.notify();
  if (view.formFocus && cx.spawn) cx.spawn(() => focusWhenMounted(view.formFocus));
}
function kindMenu(view, ticket) {
  const menu = new DropdownMenu("ticket-kind", ticket.kind ? kindWord(ticket.kind) : "No kind");
  menu.item("No kind", cx => view.act(cx, () => store.editTicket(ticket.id, { kind: null })));
  for (const kind of KINDS) menu.item(kindWord(kind), cx => view.act(cx, () => store.editTicket(ticket.id, { kind })));
  return menu;
}
function pickMenu(id, label, choices, onPick) {
  if (!choices.length) return null;
  const menu = new DropdownMenu(id, `+ ${label}`);
  for (const choice of choices) menu.item(`#${choice.number} ${choice.title}`, cx => onPick(choice, cx));
  // Left-aligned at its own width, as bb's picker; a stretched trigger reads as a primary action.
  return h_flex().child(menu);
}
function sectionLabel(view, ticket, name) {
  if (name === "activity" && ticket.comments.length) return `Activity · ${ticket.comments.length}`;
  if (name === "reviews" && view.pulls.length) return `Reviews · ${view.pulls.length}`;
  return name[0].toUpperCase() + name.slice(1);
}

function sectionTabs(view, t) {
  const row = h_flex().gap_1().items_center();
  for (const name of SECTIONS) {
    row.child(new KgButton(`tab-${name}`).label(sectionLabel(view, t, name)).ghost().size("small")
      .selected(view.section === name)
      .on_click((a, b) => {
        const next = clickCx(a, b);
        if (name === "overview") view.form = null;
        view.section = name;
        next.notify();
      }));
  }
  return row;
}
export function renderTicket(view, cx) {
  const t = view.ticket;
  const colors = cx.theme().colors;
  const chrome = sheet().pt_4().gap_3()
    .child(h_flex().gap_2().items_center()
      .child(link("back-board", "← All tickets", cx => { view.ticketId = null; view.form = null; view.pendingMove = null; cx.notify(); }, cx))
      .child(div().flex_1())
      .child(view.attentionButtons(cx, { loose: false }))
      .child(view.menu(t, cx, "···")))
    // bb's title: the number muted, then the title, left-aligned and wrapping. Clicking it edits.
    .child(h_flex().id("edit-title").role("button").accessibility_label(`Edit title of #${t.number}`).gap_2().items_baseline()
      .cursor_pointer().on_click((_event, cx) => beginEdit(view, cx))
      .child(div().flex_none().text_size(18).text_color(colors.muted_foreground).child(`#${t.number}`))
      .child(div().flex_1().min_w_0().whitespace_normal().text_size(18).font_weight(500).text_color(colors.foreground).child(t.title)))
    .child(metaRow(view, cx, t))
    .child(v_flex().gap_2().child(sectionTabs(view, t)).child(div().h(1).w_full().bg(colors.border)));
  const page = view.section === "activity" ? renderComments(view, cx, t) : view.section === "reviews" ? renderReviews(view, cx, t) : renderOverview(view, cx, t);
  return v_flex().size_full().min_h_0().child(chrome).child(new Scroll(view.scroll).flex_1().min_h_0().child(sheet().pt_3().pb_8().child(page)));
}
function metaRow(view, cx, t) {
  // bb's meta line: the kind picker, then one muted line for stage, criteria and a waiting move.
  const facts = [TITLES[t.stage]];
  if (t.stage === "done" && t.resolution === "wont-do") facts.push("won't do");
  const ac = criteriaLine(t.description, t.kind);
  if (ac) facts.push(ac);
  if (t.pendingStage) facts.push(`Move to ${TITLES[t.pendingStage]} awaiting approval`);
  const row = h_flex().gap_2().items_center().flex_wrap()
    .child(div().flex_shrink_0().child(kindMenu(view, t)))
    .child(div().flex_1().min_w_0().text_size(12).text_color(cx.theme().colors.muted_foreground).child(facts.join(" · ")));
  if (!t.proposed && t.stage !== "done") row.child(primary("start-thread", "Start thread", cx => view.act(cx, () => view.prepare("start", t))).size("small").flex_shrink_0());
  return row;
}
function renderOverview(view, cx, t) {
  const body = v_flex().gap_4();
  if (looksLikeUserStory(t.title)) body.child(new WarningAlert("title-note", USER_STORY_WARNING).size("small"));
  if (t.proposed) body.child(h_flex().gap_2()
    .child(primary("accept-ticket", "Accept ticket", cx => view.act(cx, () => store.acceptTicket(t.id))))
    .child(button("dismiss-ticket", "Dismiss", cx => view.act(cx, async () => { await store.dismissTicket(t.id); view.ticketId = null; }))));
  if (t.pendingStage) body.child(renderPendingMove(view, t, cx, "detail"));
  const job = renderHandoffState(view, t, cx, "detail");
  if (job) body.child(job);
  if (view.briefing) body.child(renderBriefing(view, cx));
  if (t.proposed) {
    body.child(tiny(descriptionPreview(t.description) ?? "No description", cx));
    return body;
  }
  const held = t.stage === "backlog" ? startProblem(t) : null;
  if (held) body.child(new WarningAlert("start-gate", `Can't leave Backlog yet: ${held}.`).size("small"));
  if (view.form === "edit") body.child(renderForm(view, cx));
  else body.child(renderDescription(view, cx, t));
  if (view.form && view.form !== "edit" && view.form !== "attach") body.child(renderForm(view, cx));
  const relationships = renderRelationships(view, cx, t);
  if (relationships) body.child(relationships);
  body.child(renderThreads(view, cx, t));
  return body;
}
function renderDescription(view, cx, t) {
  const block = v_flex().gap_2();
  if (!t.description) {
    block.child(link("edit-ticket", "+ Add a description", cx => beginEdit(view, cx), cx));
    if (t.kind === "story") block.child(tiny("Put the story here, including a ## Acceptance criteria checklist.", cx));
    else if (t.kind === "bug") block.child(tiny("Fill in steps to reproduce, expected, and actual.", cx));
    return block;
  }
  block.child(new Markdown(`description:${t.id}`, t.description).text_size(14));
  block.child(link("edit-ticket", "Edit description", cx => beginEdit(view, cx), cx));
  return block;
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
function linkedTicket(view, cx, ticket, openId, unlinkId, unlinkTip, unlink) {
  const stage = `${TITLES[ticket.stage] ?? ""}${ticket.resolution === "wont-do" ? " · won't do" : ""}`;
  const row = h_flex().gap_2().items_center().group("linked")
    .child(rowLink(openId, `#${ticket.number} ${ticket.title}`, cx, cx => view.openTicket(ticket.id, cx)))
    .child(tiny(stage, cx).flex_none());
  if (unlinkId) row.child(div().flex_none().opacity(0).group_hover("linked", el => el.opacity(1))
    .child(link(unlinkId, "Remove", cx => view.act(cx, unlink), cx).tooltip(unlinkTip)));
  return row;
}
/** One kind of link: its heading and rows when it has any. Its picker joins the shared row at the end. */
function relationGroup(section, pickers, cx, label, rows, menu) {
  if (rows.length) section.child(heading(label, cx));
  for (const row of rows) section.child(row);
  if (menu) pickers.push(menu);
}
export function renderRelationships(view, cx, t) {
  const parentChoices = t.parent ? [] : view.data.tickets.filter(p => canNest(view.data.tickets, t.id, p.id));
  const childChoices = view.data.tickets.filter(p => !p.parentId && canNest(view.data.tickets, p.id, t.id));
  const blockerChoices = view.data.tickets.filter(p => canBlock(view.data.tickets, t.id, p.id));
  const subs = t.subTickets ?? [];
  const blockedBy = t.blockedBy ?? [];
  const blocks = t.blocks ?? [];
  if (!t.parent && !subs.length && !blockedBy.length && !blocks.length && !t.issue && !parentChoices.length && !childChoices.length && !blockerChoices.length) return null;
  const section = surface(cx).child(heading("Relationships", cx));
  const pickers = [];
  relationGroup(section, pickers, cx, "Parent", t.parent ? [linkedTicket(view, cx, t.parent, `parent-open:${t.parent.id}`, `unparent:${t.id}`, "Take it out of its parent", () => store.setParent(t.id, null))] : [], pickMenu("parent-ticket", "Set parent", parentChoices, (choice, cx) => view.act(cx, () => store.setParent(t.id, choice.id))));
  relationGroup(section, pickers, cx, "Sub-tickets", subs.map(child => linkedTicket(view, cx, child, `sub:${child.id}`, `unsub:${child.id}`, "Take it out of this ticket", () => store.setParent(child.id, null))), pickMenu("add-sub", "Add sub-ticket", childChoices, (choice, cx) => view.act(cx, () => store.setParent(choice.id, t.id))));
  relationGroup(section, pickers, cx, "Blocked by", blockedBy.map(blocker => linkedTicket(view, cx, blocker, `open-blocker:${blocker.id}`, `remove-blocker:${blocker.id}`, "Remove blocker", () => store.unblockTicket(t.id, blocker.id))), pickMenu("add-blocker", "Add blocker", blockerChoices, (choice, cx) => view.act(cx, () => store.blockTicket(t.id, choice.id))));
  relationGroup(section, pickers, cx, "Blocks", blocks.map(blocked => linkedTicket(view, cx, blocked, `blocks:${blocked.id}`)), null);
  if (pickers.length) section.child(h_flex().gap_2().flex_wrap().pt_1().children(pickers));
  if (t.issue) section.child(link("open-issue", `Copied from ${t.issue.repo}#${t.issue.number}`, cx => view.act(cx, () => host.openUrl(t.issue.url)), cx));
  return section;
}
export function renderThreads(view, cx, t) {
  const colors = cx.theme().colors;
  const section = surface(cx);
  const quiet = threadStatusLine(t.threads);
  section.child(h_flex().gap_2().items_center()
    .child(heading("Threads", cx))
    .child(div().flex_1())
    .when(Boolean(quiet), el => el.child(tiny(String(quiet).replace("Thread status · ", ""), cx)))
    .when(t.threads.length > 0 && !quiet, el => el.child(tiny(String(t.threads.length), cx))));
  const archived = (t.archivedByDone ?? []).filter(thread => !t.threads.some(live => live.id === thread.id));
  if (archived.length) section.child(tiny(`${archived.length} archived by Done. Moving out of Done brings them back.`, cx));
  if (!t.threads.length) section.child(tiny(t.stage === "done" ? "Done archived the threads on this ticket." : "Nothing is working on this yet.", cx));
  for (const [thread, depth] of threadTree(t.threads)) {
    const project = view.projects.find(p => p.id === thread.projectId);
    const joined = (t.links ?? []).find(item => item.threadId === thread.id);
    const menu = new DropdownMenu(`thread-menu:${thread.id}`, "···")
      .item(thread.pinned ? "Unpin" : "Pin", cx => view.act(cx, () => threads.setPinned(thread.id, !thread.pinned)))
      .item("Remove from ticket", cx => view.act(cx, () => store.detach(thread.id)))
      .item("Archive thread", cx => view.act(cx, async () => { await threads.archive(thread.id); store.touch(); }));
    section.child(h_flex().gap_2().items_center().group("thread-row").pl(`${depth * 0.75}rem`)
      .child(new ThreadStatus(thread.id))
      .child(rowLink(`ticket-thread:${thread.id}`, `${thread.title}${thread.projectId !== t.projectId ? ` · ${project?.name ?? thread.projectId}` : ""}${joined?.persona ? ` · ${joined.persona}` : ""}`, cx, cx => view.act(cx, () => host.openThread(thread.id))))
      .child(div().flex_none().opacity(0).group_hover("thread-row", el => el.opacity(1)).child(menu)));
  }
  if (view.form === "attach") section.child(renderForm(view, cx));
  if (t.stage !== "done") {
    const loose = view.data.loose.filter(thread => thread.projectId === t.projectId);
    const actions = h_flex().gap_2().flex_wrap().items_center();
    if (loose.length) actions.child(link("attach-thread", loose.length === 1 ? "Attach a thread" : `Attach a thread · ${loose.length}`, cx => { view.form = "attach"; cx.notify(); }, cx));
    // As in bb: any thread on the ticket can be handed off or consolidated, unless a handoff is already under way.
    const idle = !t.proposed && !(t.handoff && HANDING_OFF.has(String(t.handoff.status)));
    if (idle && t.handoffSources.length > 0) {
      actions.child(link("handoff-thread", "Hand off…", cx => view.act(cx, () => view.prepare("handoff", t)), cx));
      actions.child(link("consolidate-threads", "Consolidate…", cx => view.act(cx, () => view.prepare("consolidate", t)), cx));
    }
    if (loose.length || t.handoffSources.length) section.child(actions);
  }
  return section;
}
function commentComposer(view, cx, t) {
  const draft = String(view.comment?.value?.() ?? "");
  const editing = Boolean(view.editCommentId);
  const composer = v_flex().gap_2();
  composer.child(new Textarea(view.comment).aria_label(editing ? "Edit comment" : "Add a comment"));
  composer.child(h_flex().gap_2().justify_end()
    .when(editing, el => el.child(button("cancel-comment", "Cancel", cx => { view.editCommentId = null; view.comment.set_value(""); cx.notify(); })))
    .child(primary("save-comment", editing ? "Save" : "Comment", cx => view.act(cx, async () => {
      const body = view.comment.value();
      if (view.editCommentId) await store.editComment(view.editCommentId, body);
      else await store.addComment(t.id, { body });
      view.editCommentId = null; view.comment.set_value("");
    })).size("small").disabled(view.busy || !draft.trim())));
  return composer;
}
export function renderComments(view, cx, t) {
  const colors = cx.theme().colors;
  const section = v_flex().gap_4();
  if (!t.comments.length) section.child(tiny("No comments yet.", cx));
  for (const comment of t.comments) {
    const who = comment.githubLogin ? `@${comment.githubLogin} on GitHub` : comment.persona ?? comment.threadId ?? "You";
    const when = commentWhen(comment.createdAt);
    const editing = view.editCommentId === comment.id;
    const head = h_flex().gap_2().items_baseline()
      .child(tiny(who, cx, colors.foreground).font_weight(600))
      .when(Boolean(comment.threadId), el => el.child(button(`comment-thread:${comment.id}`, "Open thread", cx => view.act(cx, () => host.openThread(comment.threadId))).text_size(11)))
      .when(Boolean(when), el => el.child(tiny(when, cx)))
      .when(comment.updatedAt !== comment.createdAt, el => el.child(tiny("· edited", cx)))
      .child(h_flex().flex_1().justify_end()
        .child(button(`comment-edit:${comment.id}`, "Edit", cx => { view.editCommentId = comment.id; view.comment.set_value(comment.body); cx.notify(); }))
        .child(button(`comment-delete:${comment.id}`, "Delete", cx => {
          window.open_dialog(() => v_flex().gap_3()
            .child("Delete this comment?")
            .child(h_flex().gap_2().justify_end()
              .child(button(`cancel-delete-comment:${comment.id}`, "Cancel", () => window.close_dialog()))
              .child(primary(`confirm-delete-comment:${comment.id}`, "Delete comment", cx => {
                window.close_dialog();
                view.act(cx, () => store.deleteComment(comment.id));
              }))));
        })));
    const block = v_flex().gap_1().px_1().child(head);
    block.child(editing ? commentComposer(view, cx, t) : new Markdown(comment.id, comment.body));
    section.child(block);
  }
  if (!view.editCommentId) section.child(commentComposer(view, cx, t));
  return section;
}
/** "Nov 13, 00:20": the runtime's toLocaleString ignores its options, so the parts are put together here. */
export function stamp(ms) {
  const at = new Date(Number(ms));
  if (!Number.isFinite(at.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${commentWhen(at.getTime())}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
export function renderReviews(view, cx, t) {
  const colors = cx.theme().colors;
  const section = v_flex().gap_2();
  section.child(heading("Changes", cx));
  if (!view.changes.length) section.child(tiny("No changed repo is readable for this ticket's threads.", cx));
  for (const change of view.changes) section.child(h_flex().gap_2().items_center()
    .child(button(`change:${change.threadId}`, change.title, cx => view.act(cx, () => host.openThread(change.threadId))).flex_1().min_w_0())
    .child(tiny(`+${change.added} −${change.removed}`, cx))
    .when(Boolean(change.base), el => el.child(tiny(`vs ${change.base}`, cx))));
  section.child(heading("Repos", cx).pt_3());
  if (view.form === "link") section.child(renderForm(view, cx));
  else section.child(h_flex().gap_2().items_center()
    .child(view.ticketRepos.length ? div().flex_1() : tiny("No repo is linked.", cx).flex_1())
    .child(link("link-repos", view.ticketRepos.length ? "+ Link another" : "+ Link a repo", cx => view.act(cx, async () => { view.form = "link"; await github.maybeAutoLink(t.projectId); }), cx)));
  for (const repo of view.ticketRepos) section.child(h_flex().gap_2().items_center()
    .child(tiny(repo, cx, colors.foreground).flex_1())
    .child(button(`unlink:${repo}`, "Unlink", cx => view.act(cx, () => store.unlinkRepo(t.projectId, repo)))));
  section.child(heading("Pull requests", cx).pt_3());
  if (view.pullsError) section.child(tiny(`Couldn't read pull requests: ${view.pullsError}`, cx, colors.destructive));
  else if (!view.pulls.length) section.child(tiny("No pull request for this ticket's branch.", cx));
  for (const pull of view.pulls) {
    const checks = `${pull.checks.passed} passed${pull.checks.failed ? ` · ${pull.checks.failed} failed` : ""}${pull.checks.pending ? ` · ${pull.checks.pending} pending` : ""}`;
    section.child(h_flex().gap_2().items_center()
      .child(button(`pull:${pull.url}`, `${pull.repo.split("/").at(-1)}#${pull.number} ${pull.title}`, cx => view.act(cx, () => host.openUrl(pull.url))).flex_1().min_w_0())
      .child(tiny(`${pull.isDraft ? "Draft" : pull.state}${pull.mergedAt ? " · merged" : ""}`, cx))
      .child(tiny(checks, cx, pull.checks.failed ? colors.destructive : colors.muted_foreground)));
  }
  section.child(heading("Stage history", cx).pt_3());
  for (const entry of t.stageHistory ?? []) {
    section.child(h_flex().gap_2().items_baseline()
      .child(tiny(TITLES[entry.stage] ?? entry.stage, cx, colors.foreground))
      .when(entry.resolution === "wont-do", el => el.child(tiny("won't do", cx)))
      .child(tiny(stamp(entry.at), cx)));
  }
  return section;
}
