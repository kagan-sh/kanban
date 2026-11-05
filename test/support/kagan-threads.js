// @ts-check
// In-memory thread host used by the store, handoff and CLI tests.
export const state = {
  threads: new Map(),
  projects: [{ id: "prj_1", kind: "project", name: "One", path: "/tmp/one", sort: 1 }],
  environments: new Map(),
  sent: [],
  pasted: [],
  spawned: [],
  output: "",
};

export function reset() {
  state.threads.clear();
  state.environments.clear();
  state.sent.length = 0;
  state.pasted.length = 0;
  state.spawned.length = 0;
  state.output = "";
}

export function addThread(id, extra = {}) {
  const thread = {
    id, projectId: "prj_1", title: `Thread ${id}`, status: "idle", visibility: "visible", pinned: false,
    lastReadAt: 0, latestAttentionAt: 0, archivedAt: null, createdAt: 1, updatedAt: 1, ...extra,
  };
  state.threads.set(id, thread);
  return thread;
}

export async function get(id) {
  const thread = state.threads.get(id);
  if (!thread) throw new Error(`No thread ${id}`);
  return thread;
}
export async function list({ projectId, archived = false } = {}) {
  return [...state.threads.values()].filter(thread => (!projectId || thread.projectId === projectId)
    && (archived || thread.archivedAt === null));
}
export async function spawn(options) {
  const id = `thr_${state.spawned.length + 1}`;
  const thread = addThread(id, { projectId: options.projectId, title: options.title ?? id, status: "idle" });
  state.spawned.push({ id, options });
  return thread;
}
export async function stop(id) { await get(id); }
export async function send(id, text) { await get(id); state.sent.push({ id, text }); }
export async function output(id) { await get(id); return { output: state.output }; }
export async function archive(id) { (await get(id)).archivedAt = 1; }
export async function unarchive(id) { (await get(id)).archivedAt = null; }
export async function remove(id) { state.threads.delete(id); }
export async function setPinned(id, pinned) { (await get(id)).pinned = Boolean(pinned); }
export async function rename(id, title) { (await get(id)).title = title; return get(id); }
export async function metadata() { return null; }
export async function setMetadata() {}
export async function events() { return []; }
export async function waitEvent() { return null; }
export async function wait() { return "waiting"; }
export async function ask() { return "ask_1"; }
export async function sidebar() { return { projects: state.projects, sections: [], threads: [...state.threads.values()] }; }
export async function changes() { return { files: [], added: 0, removed: 0, base: "main", repository: true }; }
export async function diff() { return { path: "", revision: "", binary: false, truncated: false, tooLarge: false, hunks: [], file: null, added: 0, removed: 0 }; }
export async function projects() { return state.projects; }
export async function project(id) {
  const found = state.projects.find(project => project.id === id);
  if (!found) throw new Error(`No project ${id}`);
  return found;
}
export async function environment(id) {
  const found = state.environments.get(id);
  if (!found) throw new Error(`No environment ${id}`);
  return found;
}
export async function restoreEnvironment() { return { id: "env_1", projectId: "prj_1", path: "/tmp/one", status: "ready", provider: "worktree" }; }
