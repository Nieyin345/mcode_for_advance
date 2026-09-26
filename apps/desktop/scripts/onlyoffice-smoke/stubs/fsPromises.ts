import * as fs from "fs/promises";
import { state } from "./ports.js";
export * from "fs/promises";
export const rename: typeof fs.rename = async (from, to) => {
  if (state.failRename) throw Object.assign(new Error("injected Office rename failure"), { code: "EACCES" });
  return fs.rename(from, to);
};
