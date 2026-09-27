// Bundle the real settings panels with inert view/store doubles. No model, DB or app startup.
import { readdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const desktop = resolve(import.meta.dirname, "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const pkg = readdirSync(pnpm).filter((name) => name.startsWith("esbuild@")).sort().at(-1);
if (!pkg) throw new Error("Existing esbuild dependency is required; no network fallback");
const { build } = await import(pathToFileURL(join(pnpm, pkg, "node_modules/esbuild/lib/main.js")).href);
const stubs = {
  react: `export const useMemo=(fn,deps)=>{const lab=globalThis.__m26;const i=lab.index++;const old=lab.hooks[i];if(old && deps.length===old.deps.length && deps.every((d,k)=>Object.is(d,old.deps[k])))return old.value;const value=fn();lab.hooks[i]={deps,value};return value;};`,
  "react/jsx-runtime": `export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='fragment';`,
  "@renderer/stores/sessionStore.js": `export const useSessionStore=(select)=>{const lab=globalThis.__m26;const v=select(lab.state);lab.selected.push(v);return v};useSessionStore.getState=()=>globalThis.__m26.state;`,
  "@renderer/lib/i18n/index.js": `export const useI18n=()=>({t:globalThis.__m26.t});`,
  "@renderer/lib/commands.js": `export const collectCommands=(state)=>state.visible;export const COMMAND_GROUPS=['view'];export const COMMAND_GROUP_LABELS={view:'view'};export const groupForId=()=> 'view';`,
  "@renderer/lib/shortcuts.js": `export const DEFAULT_SHORTCUTS={base:'Ctrl+B'};`,
  "@renderer/lib/gestures.js": `export const DEFAULT_GESTURES={base:'D'};`,
  "@renderer/components/ui/index.js": `export const Button=()=>null;export const Switch=()=>null;export const Select={Root:()=>null,Trigger:()=>null,Value:()=>null,Portal:()=>null,Positioner:()=>null,Popup:()=>null,List:()=>null,Item:()=>null,ItemText:()=>null};`,
  "@renderer/lib/icons.js": `export const IconRefresh=()=>null;`,
  "./panelWidth.js": `export const PANEL_MAX_W={form:'w-full'};`,
  "./PanelHeader.js": `export const PanelHeader=()=>null;`,
  "./SettingsSection.js": `export const SettingsSection=()=>null;`,
  "./SettingRow.js": `export const SettingRow=()=>null;`,
  "./ShortcutRecorder.js": `export const ShortcutRecorder=()=>null;`,
  "./GestureRecorder.js": `export const GestureRecorder=()=>null;`,
};
const out = mkdtempSync(join(desktop, ".tmp", "maint-m26-"));
await build({
  entryPoints: [join(import.meta.dirname, "main.ts")],
  bundle: true, platform: "node", format: "esm", jsx: "automatic",
  tsconfig: join(desktop, "tsconfig.json"),
  outfile: join(out, "smoke.mjs"), logLevel: "error",
  plugins: [{ name: "isolated-component-double", setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => args.path in stubs ? { path: args.path, namespace: "double" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "double" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
  } }],
});
console.log("M26 test artifacts:", out);
await import(pathToFileURL(join(out, "smoke.mjs")).href);
