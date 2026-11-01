// @ts-check

export const STAGES = ["backlog", "in-progress", "review", "done"];
export const TITLES = { backlog: "Backlog", "in-progress": "In progress", review: "Review", done: "Done" };
export const PERSONAS = { backlog: "intake", "in-progress": "implementer", review: "reviewer-default", done: "ship" };
export const GLYPHS = { backlog: "◌", "in-progress": "◐", review: "⊙", done: "●" };

export function stage(value) {
  if (!STAGES.includes(value)) throw new Error(`Unknown stage ${value}`);
  return value;
}

export function text(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must contain 1–${max} characters`);
  return value.trim();
}

export function attention(thread) {
  if (thread.status === "error") return "Failed";
  if ((thread.lastReadAt ?? 0) < thread.latestAttentionAt) return "New reply";
  return null;
}

export function needsYou(ticket) {
  return Boolean(ticket.proposed || ticket.pendingStage || ticket.handoff?.error || ticket.threads.some(attention));
}

export function target(threads) {
  return [...threads].sort((a, b) => Number(Boolean(attention(b))) - Number(Boolean(attention(a))) || b.updatedAt - a.updatedAt)[0] ?? null;
}

export function matches(ticket, search) {
  const words = `#${ticket.number} ${ticket.title} ${ticket.threads.map(t => t.title).join(" ")}`.toLowerCase();
  return words.includes(search.trim().toLowerCase());
}

export function sidebarRows(projects, tickets, live, activeProject, expanded, collapsed, frozen = []) {
  const byId = new Map(live.filter(t => !t.archivedAt && t.visibility !== "hidden").map(t => [t.id, t]));
  const linked = new Set(tickets.flatMap(t => t.links.map(l => l.threadId)));
  const previous = new Map(frozen.map((id, ix) => [id, ix]));
  const rows = [];
  const place = { review: 0, "in-progress": 1, backlog: 2, thread: 3 };
  for (const project of projects) {
    const items = tickets.filter(t => t.projectId === project.id && t.stage !== "done").map(t => {
      const threads = t.links.map(l => byId.get(l.threadId)).filter(Boolean);
      return { id: t.id, ticket: { ...t, threads }, threads, thread: target(threads), depth: 0, place: place[t.stage], needs: needsYou({ ...t, threads }), pinned: threads.some(t => t.pinned), updatedAt: Math.max(t.updatedAt, ...threads.map(t => t.updatedAt)) };
    }).filter(r => r.ticket.stage !== "backlog" || r.threads.length > 0);
    const listed = new Map(items.map(r => [r.id, r]));
    const children = new Map();
    for (const item of items) {
      const parent = listed.get(item.ticket.parentId);
      if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), item]);
    }
    const family = item => {
      for (const child of children.get(item.id) ?? []) {
        family(child);
        item.needs ||= child.needs;
        item.pinned ||= child.pinned;
        item.updatedAt = Math.max(item.updatedAt, child.updatedAt);
      }
    };
    const roots = items.filter(r => !listed.has(r.ticket.parentId));
    roots.forEach(family);
    const loose = [...byId.values()].filter(t => t.projectId === project.id && !linked.has(t.id)).map(t => ({ id: t.id, thread: t, ticket: null, needs: Boolean(attention(t)), pinned: t.pinned, updatedAt: t.updatedAt, place: place.thread, depth: 0 }));
    if (!items.length && !loose.length && project.id !== activeProject) continue;
    rows.push({ id: project.id, project, needs: [...items, ...loose].filter(r => r.needs).length });
    if (collapsed.has(project.id)) continue;
    const ordered = list => {
      const rank = r => r.needs ? 0 : r.pinned ? 1 : 2 + r.place;
      const natural = [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
      const known = natural.filter(r => previous.has(r.id)).sort((a, b) => previous.get(a.id) - previous.get(b.id));
      let ix = 0;
      return natural.map(r => previous.has(r.id) ? known[ix++] : r);
    };
    const emit = (item, depth) => {
      rows.push({ ...item, depth });
      if (!item.ticket) return;
      if (expanded.has(item.id)) for (const thread of item.threads) rows.push({ id: `child:${thread.id}`, ticket: item.ticket, thread, depth: depth + 1, needs: Boolean(attention(thread)) });
      for (const child of ordered(children.get(item.id) ?? [])) emit(child, depth + 1);
    };
    for (const item of ordered([...roots, ...loose])) emit(item, 0);
  }
  return rows;
}
