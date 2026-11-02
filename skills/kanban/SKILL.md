---
name: kanban
description: Read a ticket, link threads, and move work through the native Kanban board when the user asks for ticket work.
---

# Kanban

Use the running kagan binary (`kg` on PATH). Do not launch another app or override `KG_DATA_DIR`.

- Read `kg kanban ticket show` before work on an attached thread. The description and comments include previous handoffs. Check claims before relying on them.
- `kg kanban list --project <id> --json` lists tickets and loose threads.
- Create tickets only when the user asks: `kg kanban ticket add "Title" --desc "Description"`. New tickets are stories; pass `--kind bug` or `--kind task`. An agent's ticket is proposed unless the person enabled immediate additions. A bug with an empty description gets the steps, expected, actual, and environment headings.
- A story cannot leave Backlog without a `## Acceptance criteria` checklist (`- [ ]` / `- [x]`). A bug cannot leave until Steps to reproduce, Expected, and Actual have text. Tasks and tickets with no kind are not held. `kg kanban move done --wont-do` ends the ticket without those checks and only where a move to Done is allowed.
- Rank Backlog with `kg kanban ticket rank <ticket> --top`, `--bottom`, `--before <ticket>`, or `--after <ticket>`. Rank is the priority. New tickets go to the bottom.
- Blockers are other tickets in the same project: `kg kanban ticket block <ticket> --by <ticket>` and `ticket unblock`. They are not the parent.
- `kg kanban ticket new [thread-id]` puts an existing thread on a new ticket.
- `kg kanban ticket attach <ticket> [thread-id]` joins a thread to a ticket; `ticket detach [thread-id]` makes it loose.
- `kg kanban move in-progress` starts work; `kg kanban move review` asks for review. A move can remain proposed when the person disabled immediate moves.
- `kg kanban move done` archives the ticket's threads and works only when the person enabled it. Do not change that setting yourself.
- Ticket references are `#N` in the current project, a ticket id, or an attached thread id. Omitted references mean this thread's ticket. Quote `#N` in the shell.
- `kg kanban ticket comment <ticket> "Text"` records decisions and findings.
- Write a `## Handoff` only when handing work to a new thread. Include `### Goal` and `### Current State`; include decisions, paths and next steps that a new thread needs. Save it with `kg kanban ticket comment`.
- `kg kanban ticket handoff <ticket> <source-thread-id> --persona <name>` starts a successor and archives the source. `consolidate` takes several source ids.
- `kg kanban ticket remove [thread-id]` archives a thread. `ticket delete <ticket>` archives every linked thread and deletes the ticket. Prefer moving to Done when the work is finished.
- GitHub import is a one-time copy, never a sync: `kg kanban repos link owner/name`, then `kg kanban repos import owner/name <number>`.

Never approve plugin powers, change provider settings, or create tickets unprompted.
