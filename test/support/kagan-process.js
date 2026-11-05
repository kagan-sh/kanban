// @ts-check
export const state = { calls: [], result: { exitCode: 1, stdout: "", stderr: "" }, handler: null };
export function reset() {
  state.calls.length = 0;
  state.result = { exitCode: 1, stdout: "", stderr: "" };
  state.handler = null;
}
export async function run(program, args, options) {
  state.calls.push({ program, args, options });
  if (state.handler) return state.handler(program, args, options);
  return state.result;
}
