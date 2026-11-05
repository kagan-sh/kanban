// @ts-check

export function ago(at, now = Date.now()) {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
/** Threads in parent-before-child order, with their depth in the ticket's thread tree. */
export function threadTree(list) {
  const ids = new Set(list.map(thread => thread.id));
  const children = new Map();
  const roots = [];
  for (const thread of list) {
    if (thread.parentThreadId && ids.has(thread.parentThreadId)) {
      children.set(thread.parentThreadId, [...(children.get(thread.parentThreadId) ?? []), thread]);
    } else roots.push(thread);
  }
  const out = [];
  const walk = (thread, depth) => {
    out.push([thread, depth]);
    for (const child of children.get(thread.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

