// Bundle the real paths + manifest modules with an isolated data root and inert IPC/repo doubles.
import { readdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const desktop = resolve(import.meta.dirname, "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const pkg = readdirSync(pnpm).filter((n) => n.startsWith("esbuild@")).sort().at(-1);
if (!pkg) throw new Error("Installed esbuild required; no network fallback");
const { build } = await import(pathToFileURL(join(pnpm, pkg, "node_modules/esbuild/lib/main.js")).href);
const stubs = {
  "@main/lib/dataRoot.js": `export const dataRoot=()=>{const r=process.env.MCODE_SMOKE_DATA_ROOT;if(!r)throw Error('Isolated M34 data root required');return r};`,
  "@main/store/repositories.js": `export const LibraryRepo={get:(id)=>globalThis.__m34.items[id],listByCollection:()=>Object.values(globalThis.__m34.items)};export const LibraryLinkRepo={linksOf:(id)=>id==='A'?[{direction:'out',targetItemId:'B'}]:[]};export const NoteRepo={listByItem:()=>[]};export const CollectionRepo={list:()=>[{id:'COL',name:'Fixture collection'}]};`,
  "@contracts/ipc": `export const IPC={COMPOSER_ATTACH:'composer:attach'};`,
  "@main/window.js": `export const sendToRenderer=(_channel,msg)=>globalThis.__m34.events.push(msg);`,
  "./trash.js": `export const trashedItemIds=()=>globalThis.__m34.trashed;`,
  "./suppress.js": `export const suppressionReasonOfItem=()=>null;export const LIBRARY_BLOCK_SETTINGS_PAGE="文档管理";`,
  "./groupRegistry.js": `export const groupPromptOf=()=>undefined;export const loadLibraryGroups=()=>[];`,
  "./fileImport.js": `export const aiVisibleFilesOf=()=>({original:null,markdown:null,hasTranscript:false});export const extOf=()=>'';export const importGenericFiles=()=>({items:[]});`,
};
const dir = mkdtempSync(join(desktop, ".tmp", "maint-m34-"));
await build({
  entryPoints: [join(import.meta.dirname, "main.ts")],
  bundle: true, platform: "node", format: "esm", tsconfig: join(desktop, "tsconfig.json"),
  outfile: join(dir, "smoke.mjs"), logLevel: "error",
  plugins: [{ name: "isolated-manifest-dependencies", setup(b) {
    b.onResolve({ filter: /.*/ }, (args) =>
      args.path in stubs && (!args.path.startsWith("./") || args.importer.endsWith("manifest.ts"))
        ? { path: args.path, namespace: "m34" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "m34" }, (args) => ({
      contents: stubs[args.path], loader: "js",
    }));
  } }],
});
console.log("M34 test artifacts:", dir);
await import(pathToFileURL(join(dir, "smoke.mjs")).href);
