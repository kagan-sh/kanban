# Kanban

A native ticket board for [kagan](https://kagan.sh). One plain-JavaScript plugin owns the board, ticket detail, replaceable sidebar list, CLI and SQLite data. No build step.

Tickets move through **Backlog → In progress → Review → Done**, hold one or more threads, and stay separate from thread runtime status. Threads on no ticket are **loose**. Drag a card between columns to move it, or onto the top or bottom of a Backlog card to rank it, or onto the middle of a card to make it a sub-ticket. Drag a thread onto a card to attach it, onto a column to make a ticket, or onto Loose to take it off. A refused move says why. Menus and the N key still work.

## Install

```sh
kg plugin install git:https://github.com/kagan-sh/kanban@main
```

Or from a local checkout:

```sh
kg plugin check .
kg plugin install .
```

Approve the powers screen. The plugin reads threads, stores tickets in its own SQLite file under `~/.kagan/plugins/dev.kagan.kanban/`, and can run `gh` and `git` with your normal credentials (issue import is copy-only; `gh` itself is a full CLI). Set **Program for new threads** and optionally **Personas folder** (opening the board may `git pull --ff-only` that folder).

**First success:** click **Board** on the rail (or Command-Shift-K) → **New ticket** → type a title → Enter. The ticket lands at the bottom of Backlog.

Optional: Settings → Appearance → Sidebar → pick this plugin’s ticket list. Command-I opens the current thread’s ticket.

## Work on tickets

- Create and search tickets in Backlog, In progress, Review and Done. The board can show several projects; new tickets go to the selected project. Backlog's order is its priority.
- Open a ticket to edit its title and description, change its kind, comment, set a parent, add blockers, attach loose threads, and start a thread with a persona. The **Since you were here** card on top summarises what happened since you last opened it.
- A story needs a `## Acceptance criteria` checklist and a bug needs steps to reproduce before either leaves Backlog. Tasks and tickets with no kind are never held. Won't do is a way to reach Done that skips those checks. Cards show how long a ticket has sat in In progress or Review, and a project can set a work-in-progress limit that warns.
- Sub-tickets and blockers stay in the same project. Drag a ticket onto the middle of another card to nest it; drag onto a card's top or bottom edge in Backlog to rank it above or below. Deleting a parent leaves its sub-tickets at the top level.
- Each ticket gets one worktree when its project has committed Git history. Later threads reuse it. Non-Git projects use the project folder; Personal uses a personal environment. Attached threads keep their own environment.
- Move with the ticket menu. In progress and Review offer **Hand off** or **Just move**. Handoff asks the chosen thread to write a `## Handoff` with `### Goal` and `### Verified`, saves it as a comment, and starts a successor with the chosen persona from it. The successor gets the handoff as thread input (press Enter to send). The source thread is archived once the successor starts; if that fails, the card offers **Archive sources**.
- A failed handoff (no structured reply, or an ask that could not be sent) shows **Retry** and **Start without handoff** on the card. A handoff nobody answers within an hour fails the same way. **Consolidate** asks several threads at once and starts one successor from all their handoffs.
- Done archives live threads. Reopening restores only threads Done archived, including retired environments. Manually archived threads stay archived.
- Agent additions are proposed by default. Moves apply immediately by default; settings can require acceptance or allow moves to Done. A proposed move is refused if the ticket's description, blockers, parent or thread list changed after it was proposed; dismiss it and request a fresh one.
- Link repositories and import open issues through **Repos…**. Search and filters use `gh`. Imports copy the body, source link and comments once; nothing writes to GitHub.
- **Reviews** on a ticket lists the changed lines of its threads, linked repos, the pull request of the ticket's branch with check counts, and the ticket's stage history. It reads through `gh` and writes nothing.

## CLI

```sh
kg kanban list --project <id> --json
kg kanban ticket add "Title" --desc "Description" --kind story|bug|task [--parent '#1'] [--blocked-by '#2']
kg kanban ticket rank '#1' --top|--bottom|--before '#2'|--after '#2'
kg kanban ticket block '#2' --by '#1'
kg kanban ticket unblock '#2' --by '#1'
kg kanban move done '#1' --wont-do
kg kanban rules --warn-days 14 --wip-limit 3
kg kanban ticket new [thread-id]
kg kanban ticket show '#1'
kg kanban ticket attach '#1' [thread-id]
kg kanban ticket detach [thread-id]
kg kanban ticket comment '#1' "A decision"
kg kanban ticket parent '#2' --to '#1' | --none
kg kanban ticket start '#1' --persona implementer --prompt "Continue"
kg kanban ticket handoff '#1' <source-id> --persona reviewer-default
kg kanban ticket consolidate '#1' <source-id> <source-id>
kg kanban move review [ticket]
kg kanban ticket remove [thread-id]
kg kanban ticket delete '#1'
kg kanban repos link owner/name
kg kanban repos issues --query "search" --label bug
kg kanban repos import owner/name 123
```

Omitted references mean the calling thread's ticket. `#N` is project-local; ticket ids and attached thread ids work across projects. A value with newlines is quoted in the shell; there is no `--desc-file` because a plugin has no read root for arbitrary paths. Add `--json` for a single JSON document without the prose summary.

## Verify

```sh
node --test
kg plugin types .
kg plugin check .
```

`PORT.md` lists what differs from the BB Kanban this was ported from, and which
host capabilities are still missing.

## License

MIT
