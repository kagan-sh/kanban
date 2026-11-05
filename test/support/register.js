// @ts-check
import { register } from "node:module";
register("./kagan-loader.mjs", import.meta.url);

globalThis.window = {
  open_dialog: () => {},
  close_dialog: () => {},
  has_active_dialog: () => false,
};
