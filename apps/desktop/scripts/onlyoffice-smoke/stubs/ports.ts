import { resolve, relative, isAbsolute } from "node:path";
export const state = { failRename: false };
const settings = new Map<string, string>();
export const SettingRepo = {
  get: (key: string) => settings.get(key),
  set: (key: string, value: string) => { settings.set(key, value); },
};
export const log = { info() {}, warn() {}, error() {} };
export function findContainingWorkspaceRoot(path: string): string | null {
  const root = process.env.MCODE_ONLYOFFICE_SMOKE_ROOT;
  if (!root) throw new Error("Missing isolated Office smoke root");
  const rel = relative(resolve(root), resolve(path));
  return !rel.startsWith("..") && !isAbsolute(rel) ? root : null;
}
