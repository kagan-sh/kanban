const modules = {
  "kagan/database": "./kagan-database.js",
  "kagan/threads": "./kagan-threads.js",
  "kagan/host": "./kagan-host.js",
  "kagan/process": "./kagan-process.js",
  "kagan/jobs": "./kagan-jobs.js",
  "gpui-kit": "./gpui-kit.js",
  "gpui-base": "./gpui-base.js",
  "gpui-component": "./gpui-component.js",
};

export async function resolve(specifier, context, next) {
  const target = modules[specifier];
  if (target) return { url: new URL(target, import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
