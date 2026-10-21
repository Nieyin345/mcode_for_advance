/** Build T53's real upstream office round-trip into a temporary bundle. */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const desktop = process.cwd();
const repo = resolve(desktop, "../..");
const gen = join(repo, "genoffice");
const pnpm = join(repo, "node_modules/.pnpm");
const dir = readdirSync(pnpm).find(name => name.startsWith("esbuild@"));
if (!dir) throw Error("esbuild dependency missing");
const { build } = await import(pathToFileURL(join(pnpm, dir, "node_modules/esbuild/lib/main.js")).href);
if (!existsSync(join(gen, "packages/pptx-engine/src/index.ts"))) throw Error("vendor PPTX engine missing");
const aliases = {
  "@main/document/slidesVendorModules.js": join(desktop,"src/main/document/slidesVendorModules.ts"),
  "@genoffice/font-metrics": join(gen,"packages/font-metrics/src/index.ts"),
  "@genoffice/docx-engine": join(gen,"packages/docx-engine/src/index.ts"),
  "@genoffice/docx-engine/math": join(gen,"packages/docx-engine/src/math.ts"),
  "@genoffice/docx-engine/lazy-media": join(gen,"packages/docx-engine/src/lazy-media.ts"),
  "@genoffice/docx-engine/zip-splice": join(gen,"packages/docx-engine/src/zip-splice.ts"),
  "@genoffice/pptx-engine": join(gen,"packages/pptx-engine/src/index.ts"),
  "@genoffice/pptx-engine/table-grid": join(gen,"packages/pptx-engine/src/table-grid.ts"),
  "@genoffice/pptx-engine/identity": join(gen,"packages/pptx-engine/src/identity.ts"),
  "@genoffice/pptx-engine/custgeom": join(gen,"packages/pptx-engine/src/custgeom.ts"),
  "@genoffice/pptx-engine/background-promote": join(gen,"packages/pptx-engine/src/background-promote.ts"),
  "@genoffice/pptx-render": join(gen,"packages/pptx-render/src/index.ts"),
  "@genoffice/pptx-ops": join(gen,"packages/pptx-ops/src/index.ts"),
  "@genoffice/agent-core/redact-range": join(gen,"packages/agent-core/src/redact-range.ts"),
};
await build({
  entryPoints:[join(desktop,"scripts/genoffice-native-view-smoke/real.ts")],
  bundle:true, platform:"node", format:"esm",
  tsconfig:join(desktop,"tsconfig.json"),
  absWorkingDir:desktop,
  outfile:process.argv[2],
  logLevel:"error", alias:aliases,
  nodePaths:[join(gen,"node_modules")],
  loader:{".md":"text",".wasm":"dataurl",".ttf":"dataurl",".otf":"dataurl",".png":"dataurl"},
  banner:{js:"import { createRequire as __cr } from 'node:module'; const require=__cr(import.meta.url);"},
});
