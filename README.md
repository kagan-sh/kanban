# Kanban

A native ticket board for [kagan](https://kagan.sh). One plain-JavaScript plugin owns the board, ticket detail, replaceable sidebar list, CLI and SQLite data. No build step.

Ported from the bb-kit Kanban plugin: tickets move through **Backlog → In progress → Review → Done**, hold one or more threads, and stay separate from thread runtime status. Threads on no ticket are **loose**. Script drag-and-drop is not in the plugin API yet, so moves and attachment use menus and buttons.

## Install

```sh
kg plugin install git:https://github.com/kagan-sh/kanban@main
```

Or from a local checkout:

```sh
kg plugin check .
kg plugin install .
```

Approve the powers screen. The plugin reads threads, stores its own database, runs `gh` for read-only issue access, and runs `git` for worktree checks and optional personas pull. Set **Program for new threads** and optionally **Personas folder** in plugin settings.

Open **Board** (Command-Shift-K). Pick **Ticket list** under Settings → Appearance → Sidebar to navigate by ticket. Command-I opens the current thread's ticket.

## Work on tickets

- Create and search tickets in Backlog, In progress, Review and Done. The board can show several projects; new tickets go to the selected project.
- Open a ticket to edit its title and description, comment, set a parent, attach loose threads, and start a thread with a persona.
- Each ticket gets one worktree when its project has committed Git history. Later threads reuse it. Non-Git projects use the project folder; Personal uses a personal environment. Attached threads keep their own environment.
- Move with the ticket menu. In progress and Review offer **Hand off** or **Just move**. Handoff records a request comment, starts a successor with the chosen program, and archives the source threads.
- Done archives live threads. Reopening restores only threads Done archived, including retired environments. Manually archived threads stay archived.
- Agent additions are proposed by default. Moves apply immediately by default; settings can require acceptance or allow moves to Done.
- Link repositories and import open issues through **Repos…**. Search and filters use `gh`. Imports copy the body, source link and comments once; nothing writes to GitHub.

## CLI

```sh
kg kanban list --project <id> --json
kg kanban ticket add "Title" --desc "Description"
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
