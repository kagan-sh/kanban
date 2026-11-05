// @ts-check
import { element } from "./gpui-kit.js";

export function colors() {
  return {
    background: "#000", foreground: "#fff", surface: "#111", border: "#222", muted_foreground: "#888",
    primary: "#08f", ring: "#08f", destructive: "#f00", selection: "#223",
  };
}
export function cx() {
  return {
    theme: () => ({ colors: colors(), radius: { sm: 2, md: 4, lg: 8 } }),
    notify() {},
    spawn: () => ({}),
    focus_handle: () => ({ focus() {} }),
  };
}
export function view(extra = {}) {
  return {
    data: { tickets: [], loose: [] }, projects: [], shown: new Set(), over: null, drag: null, jumpId: null,
    ruleMap: new Map(), openThreads: new Set(), projectId: "prj_1", menu: () => element("menu"),
    dragSource: (el) => el, dropTarget: (el) => el, openTicket() {}, act() {}, prepare() {}, move() {},
    finishMove() {}, loadTicketExtras() {}, ticketId: null, ticket: null, section: "overview",
    briefing: null, seenAt: Date.now(), pulls: [], pullsError: null, ticketRepos: [], changes: [],
    comments: [], ...extra,
  };
}
export function walk(node, out = []) {
  if (!node || (typeof node !== "object" && typeof node !== "function")) return out;
  const raw = node._node ?? node;
  out.push(raw);
  if (!Array.isArray(raw.children)) return out;
  for (const child of raw.children) walk(child, out);
  return out;
}
export function ids(node) { return walk(node).flatMap(item => item.ids ?? (typeof item.id === "string" ? [item.id] : [])); }
export function labels(node) { return walk(node).flatMap(item => item.labels ?? []); }
export function texts(node) {
  const out = [];
  const visit = (item) => {
    const raw = item?._node ?? item;
    if (typeof raw === "string") { out.push(raw); return; }
    if (!raw || typeof raw !== "object") return;
    if (typeof raw.content === "string") out.push(raw.content);
    if (typeof raw.text === "string") out.push(raw.text);
    if (!Array.isArray(raw.children)) return;
    for (const child of raw.children) visit(child);
  };
  visit(node);
  return out;
}
