// @ts-check
export const state = {
  values: { agentAutoApproveAdds: true, agentAutoApproveMoves: true, agentMoveToDone: true, defaultProgram: "claude" },
  logs: [],
  toasts: [],
  openedThreads: [],
  openedPanels: [],
  openedUrls: [],
  pasted: [],
};

export function reset() {
  state.values = { agentAutoApproveAdds: true, agentAutoApproveMoves: true, agentMoveToDone: true, defaultProgram: "claude" };
  state.logs.length = 0;
  state.toasts.length = 0;
  state.openedThreads.length = 0;
  state.openedPanels.length = 0;
  state.openedUrls.length = 0;
  state.pasted.length = 0;
}

export function pluginId() { return "dev.kagan.kanban"; }
export function log(level, message) { state.logs.push({ level, message }); }
export function settings() { return state.values; }
export function context() { return { threadId: "thr_1", projectId: "prj_1", focused: true, theme: "dark" }; }
export function onContextChanged() { return new Promise(() => {}); }
export function threadOnScreen() { return false; }
export async function openThread(id) { state.openedThreads.push(id); }
export async function openPanel(id, props) { state.openedPanels.push({ id, props }); }
export async function openUrl(url) { state.openedUrls.push(url); }
export async function toast(message) { state.toasts.push(message); }
export async function addComment() {}
export async function pasteIntoThread(id, text) { state.pasted.push({ id, text }); }
export function writeClipboardPng() {}
