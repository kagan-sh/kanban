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

- Create and search tickets in Backlog, In progress, Review and Done. The board can show several projects; new tickets go to the selected project.
- Open a ticket to edit its title and description, comment, set a parent, attach loose threads, and start a thread with a persona.
- Each ticket gets one worktree when its project has committed Git history. Later threads reuse it. Non-Git projects use the project folder; Personal uses a personal environment. Attached threads keep their own environment.
- Move with the ticket menu. In progress and Review offer **Hand off** or **Just move**. Handoff records a request comment, starts a successor with the chosen program and persona/prompt pasted into that thread (press Enter to send), and leaves the source threads live until you click **Archive sources**.
- **Host gap:** collecting each source's handoff before archiving needs `threads.send` and `threads.output`, which are not on kagan main yet. Until those land, sources stay live and archiving is manual. Pasting uses `pasteIntoThread`; `threads.send` (feat/hook-send) should replace that once it merges.
- Done archives live threads. Reopening restores only threads Done archived, including retired environments. Manually archived threads stay archived.
- Agent additions are proposed by default. Moves apply immediately by default; settings can require acceptance or allow moves to Done.
- Link repositories and import open issues through **Repos…**. Search and filters use `gh`. Imports copy the body, source link and comments once; nothing writes to GitHub.

## CLI

```sh
kg kanban list --project <id> --json
kg kanban ticket add "Title" --desc "Description" --kind story|bug|task
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
kg kanban ticket parent '#2' '#1'
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

Omitted references mean the calling thread's ticket. `#N` is project-local; ticket ids and attached thread ids work across projects.

## Verify

```sh
kg plugin types .
kg plugin check .
```

## License

MIT
