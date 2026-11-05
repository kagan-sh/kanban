```
Plugin: Kanban
Source: /Users/aorumbayev/projects/bb-kit/plugins/kanban (BB Kanban, after the port)
Kagan id: dev.kagan.kanban

Moved (one plugin, plain JavaScript):
- Four columns, rank by dropping on a Backlog card's top or bottom edge,
  nesting by dropping on its middle, moves by dropping on a column, and a
  loose-thread tray with drag-off, new-ticket and add-to-ticket.
- The whole ticket: title, description, kind, acceptance criteria, comments
  with edit and delete, blockers both ways, parent and sub-tickets, attached
  threads, repo links, imported issues, stage history, and a briefing card
  ("Since you were here") built from comments and thread events.
- Story/bug start gates, Won't do resolution, Backlog rank, stage clocks,
  work-in-progress limit, user-story title note, search, Needs you and N.
- Proposed tickets and proposed moves, with the three agent settings and the
  rule that a proposal is refused once the ticket changed after it was made.
- Handoff: ask the source thread for a `## Handoff` (Goal and Verified
  required) through `threads.send`, read the reply's scrollback, save it as a
  comment, start the successor from it, and archive the source. Consolidate
  collects several. Retry, Start without handoff, and an hour-long timeout.
- Personas (including the built-in comment-editor), the built-in skill, the
  CLI (list/move/ticket/rules/repos), and the replaceable sidebar list.
- GitHub: remote auto-link, linked repos, issue search and one-time import,
  and a per-ticket PR pulse with check counts, read through `gh`.

Close (what differs):
- The ticket is a center page, not a modal dialog, and the sidebar draws rows
  only (Kagan keeps New thread, Archived and the rail). Copy and hierarchy
  follow BB's card, column, header and detail layout.
- A handoff ask goes out once its source is idle (Kagan has no
  queue-if-active), waiting up to 20 minutes; then Retry asks again.
- The handoff reply is read from `threads.output` after the `thread.waiting`
  event, not from a message id. A terminal that scrolled past the baseline can
  lose an old handoff; Retry recovers.
- PR pulse shows state, merged time and check counts. Review decisions, new
  review comments, and PRs merged while the person was away are not shown.
- The briefing quotes the last user message from `threads.events` and handoff
  comments; merged-PR news and "closing counts as seen" for a pill are absent.
- Review Desk becomes the ticket's Reviews section: changed line counts from
  `threads.changes`, repo list, PR checks and stage history. There is no
  unified diff, file tree, "Open in Diff", or line-comment send.
- The ticket dialog's Workflow section becomes a thread tree in Threads,
  without workflow phases, transcripts, model disclosure or event paging.

Gaps (workaround, or cannot move):
- Archive undo — `host.toast` takes an action, but there is no undo action and
  no unarchive command the toast can call. The Archive thread menu item just
  archives; unarchive from kagan's native Archived list.
- Row menus in the replaceable sidebar — a `replaces: threads` panel may not
  use DropdownMenu, Select or Dialog, so there is no right-click/Shift+F10
  menu. Rows offer Open ticket, the next stage, Start and Archive inline; the
  full move list, pin and delete stay on the board.
- Project creation from a folder, project reorder, and open-ticket counts in
  the project picker — the plugin API has no project create, reorder or count
  calls. The picker lists `threads.projects()` and switches the board.
- Board "compact" mode (stage tabs below a narrow width) — a view cannot
  measure its own width; the four columns scroll horizontally instead.
- Push holds — expressible with `git config` and `powers.run: git`, but not
  ported: there is no Review Desk action to release a hold, so a mistake would
  leave a repo unable to push with no place to undo it from. Needs a safe
  release surface.
- `--desc-file` / `--body-file` — a plugin has no read root for arbitrary
  paths. The shell already passes newlines in one argv value, so multi-line
  text works with `--desc "..."`.
- Diff plugin integration, "Open in editor", and review comment send — Kagan
  has `threads.changes`/`threads.diff` for reading and `host.addComment` only
  while the plugin draws a review panel. There is no Diff surface to open or
  editor bridge.
- Live work panel: timeline, transcript, model disclosure, paused polling —
  no transcript API (`threads.output` is raw scrollback, `threads.events` is
  bounded) and no model/provider on a thread record.
- Agent tools — BB Kanban registers none (its agent surface is the CLI and the
  skill); the same is true here.

Powers asked: gh, git; areas threads, database, process (unchanged).
Events: thread.created (auto-join a child thread), thread.waiting (collect a
handoff), thread.deleted, thread.archived and the rest for refresh.
kg plugin check: passed.
Visual QA: not run — installing this checkout would replace the person's
installed plugin under the same id and requires approving its powers. The
generated declarations were typechecked instead (no new type errors).
```
