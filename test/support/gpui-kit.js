// @ts-check
// A tiny chainable element used to exercise view builders without a window.
export function element(tag = "div") {
  const node = { tag, id: null, ids: [], children: [], labels: [], clicks: [], props: {}, text: null };
  const proxy = new Proxy(node, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (prop === "_node") return target;
      if (prop === "child") return (kid) => { target.children.push(kid); return proxy; };
      if (prop === "children") return (kids) => { target.children.push(...kids); return proxy; };
      if (prop === "when") return (condition, apply) => { if (condition) apply(proxy); return proxy; };
      if (prop === "id") return (value) => { target.id = value; target.ids.push(value); return proxy; };
      if (prop === "label") return (value) => { target.labels.push(value); return proxy; };
      if (prop === "on_click") return (handler) => { target.clicks.push(handler); return proxy; };
      if (prop === "text") return target.text;
      if (prop in target) return target[prop];
      return (...args) => { target.props[String(prop)] = args; return proxy; };
    },
  });
  return proxy;
}

export class View {
  init() {}
  render() { return ""; }
}

export function div() { return element("div"); }
export function px(value) { return Number(value); }
