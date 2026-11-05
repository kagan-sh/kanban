// @ts-check
import { handoffSection } from "./handoff-model.js";

const BRIEFING_GENERATED = /^(Board:|Adopt this persona|Handing off|You are handing)/;
const BRIEFING_GO_AHEAD = /^(go|go on|go ahead|ok|okay|yes|yep|y|no|resume|continue|proceed|retry|next|done|sure|agree|approved|lgtm|push|commit|do it|run it|fix it|[0-9]+|[a-z])[\s.!]*$/i;
const BRIEFING_EMPTY = /^(none|n\/a|nothing|nothing( was)? verified( yet)?)\.?$/i;
const BRIEFING_UNVERIFIED = /^(not run|not verified|unverified|still unverified|not tested|untested|not yet verified)\b[\s:]*/i;

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max / 2))).trimEnd()}…`;
}

/** Handoffs are Markdown; the card keeps plain lines and inline `code`. */
function plainLine(text) {
  return text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
    .split(/(`[^`]*`)/)
    .map(part => (part.startsWith("`") ? part : part.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "")))
    .join("")
    .trim();
}

function shownLines(lines) {
  return lines.filter(line => line && !line.endsWith(":") && !BRIEFING_EMPTY.test(line)).slice(0, 3).map(line => clip(line, 160));
}

/** A Verified section splits at the line that says what was not proven. */
export function verificationLines(text) {
  const lines = String(text ?? "").split("\n").map(plainLine);
  const turn = lines.findIndex(line => BRIEFING_UNVERIFIED.test(line));
  if (turn === -1) return { verified: shownLines(lines), unverified: [] };
  return { verified: shownLines(lines.slice(0, turn)), unverified: shownLines([lines[turn].replace(BRIEFING_UNVERIFIED, ""), ...lines.slice(turn + 1)]) };
}

/** What the person typed, or null for the board's own text and a bare go-ahead. */
export function ownWords(parts) {
  const text = (parts ?? []).map(part => String(part).trim()).filter(part => part && !BRIEFING_GENERATED.test(part)).join("\n");
  return text && !BRIEFING_GO_AHEAD.test(text) ? text : null;
}

/**
 * What changed on a ticket since the person last looked. Comments are the ticket's comments;
 * events are `{ text, at, role }` for the ticket's threads, newest first. Null when nothing is news.
 */
export function briefingOf({ comments = [], events = [], threads = [] }) {
  const handoffs = comments.filter(comment => /^##[ \t]+Handoff[ \t]*$/im.test(comment.body)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 2);
  const waiting = threads.filter(thread => thread.attention)
    .sort((a, b) => ["error", "unread"].indexOf(a.attention) - ["error", "unread"].indexOf(b.attention) || (b.at ?? 0) - (a.at ?? 0))[0] ?? null;
  if (!handoffs.length && !waiting) return null;
  const newest = handoffs[0]?.body ?? null;
  const you = events.find(event => event.role === "user" && ownWords([event.text])) ?? null;
  return {
    you: you ? { text: clip(ownWords([you.text]), 280), at: you.at } : null,
    notes: handoffs.map(comment => {
      const verified = verificationLines(handoffSection(comment.body, "Verified"));
      return { at: comment.createdAt, persona: comment.persona ?? null, done: shownLines(String(handoffSection(comment.body, "Completed") ?? "").split("\n").map(plainLine)), ...verified };
    }),
    blocked: newest ? (shownLines(String(handoffSection(newest, "Blocked") ?? "").split("\n").map(plainLine))[0] ?? null) : null,
    next: newest ? (shownLines(String(handoffSection(newest, "Next") ?? "").split("\n").map(plainLine))[0] ?? null) : null,
    waiting,
  };
}
