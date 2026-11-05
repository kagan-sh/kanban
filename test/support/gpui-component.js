// @ts-check
import { element } from "./gpui-kit.js";

function chained(initial = {}) {
  const node = element("component")._node;
  Object.assign(node, initial);
  if (initial.id) node.ids.push(initial.id);
  const proxy = new Proxy(node, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (prop === "_node") return target;
      if (prop === "child") return (kid) => { target.children.push(kid); return proxy; };
      if (prop === "children") return (kids) => { target.children.push(...kids); return proxy; };
      if (prop === "label") return (value) => { target.labels.push(value); return proxy; };
      if (prop === "item") return (label, action) => { target.children.push({ label, action }); return proxy; };
      if (prop === "id") return (value) => { target.id = value; target.ids.push(value); return proxy; };
      if (prop in target) return target[prop];
      return (...args) => { target.props[String(prop)] = args; return proxy; };
    },
  });
  return proxy;
}

export class KgButton { constructor(id) { return chained({ id, kind: "button" }); } }
export class Select { constructor(id, rows) { return chained({ id, kind: "select", rows }); } }
export class DropdownMenu {
  constructor(id, label) { return chained({ id, kind: "menu", labels: [label] }); }
}
export class Input { constructor(state) { return chained({ id: state?.name, kind: "input", state }); } }
export class Textarea { constructor(state) { return chained({ id: state?.name, kind: "textarea", state }); } }
export class Scroll {
  constructor(handle) { return chained({ id: handle?.name, kind: "scroll", handle }); }
}
export class Markdown { constructor(id, content) { return chained({ id, kind: "markdown", content }); } }
export class ThreadStatus { constructor(id) { return chained({ id, kind: "thread-status" }); } }
export function ScrollbarHandle() { return { name: `scroll_${Math.random()}` }; }

export function InputState(name) {
  let value = "";
  const listeners = {};
  return {
    name, value: () => value, set_value: (next) => { value = next; },
    focus: () => {}, on: (event, handler) => { listeners[event] = handler; }, listeners,
  };
}
export function TextareaState() { return InputState("textarea"); }
