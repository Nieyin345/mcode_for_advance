#!/usr/bin/env node
/** T47: isolated CSS/token/theme-injection assertions. No user data or engine restart. */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = resolve(app, "../..");
const base = join(app, "resources/node-red");
const read = (p) => readFileSync(p, "utf8");
const css = (name) => read(join(base, name));
const rawLight = read(join(root, "node-red/packages/node_modules/@node-red/editor-client/src/sass/colors.scss"));
const rawDark = read(join(root, "node-red/packages/node_modules/@node-red/editor-client/src/sass/dark-colors.scss"));
const scssLight = css("mcode-colors-light.scss");
const scssDark = css("mcode-colors-dark.scss");
const light = css("mcode-theme-light.css");
const dark = css("mcode-theme-dark.css");
const auto = css("mcode-theme-auto.css");
const registry = read(process.env.MCODE_THEME_REGISTRY_SOURCE ??
  join(app, "src/main/workflowEngines/registry.ts"));
const bootstrapManifest = read(join(app, "src/main/workflowEngines/bootstrapManifest.ts"));
const pack = read(join(app, "electron-builder.yml"));

let pass = 0, failed = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log("  ok   "+label); }
  else { failed++; console.error("  FAIL "+label+" "+detail); }
}
function vars(scss) {
  return new Map([...scss.matchAll(/^(\$[\w-]+)\s*:\s*(.+?);/gm)].map((m) => [m[1],m[2].trim()]));
}
const baseVars = vars(rawLight);
const sourceLight = vars(scssLight);
const sourceDark = vars(scssDark);
const darkVendor = vars(rawDark);

const expected = {
  "$primary-background": ["#fcfcfb","#151515"],
  "$secondary-background": ["#ffffff","#20201f"],
  "$secondary-background-selected": ["#f0efec","#2c2c2a"],
  "$secondary-background-hover": ["#f0efec","#2c2c2a"],
  "$tertiary-background": ["#f9f9f7","#20201f"],
  "$primary-text-color": ["#151515","#f9f9f7"],
  "$secondary-text-color": ["#52514e","#b4b3a8"],
  "$tertiary-text-color": ["#6d6b67","#97958d"],
  "$header-text-color": ["#151515","#f9f9f7"],
  "$text-color-error": ["#dc2626","#f87171"],
  "$text-color-warning": ["#b45309","#fbbf24"],
  "$text-color-success": ["#047857","#10b981"],
  "$text-color-link": ["#c25124","#ec835a"],
  "$shadow": ["rgba(0, 0, 0, 0.12)","rgba(0, 0, 0, 0.35)"],
  "$primary-border-color": ["#c3c2b7","#2c2c2a"],
  "$secondary-border-color": ["#d2d1c7","#2c2c2a"],
  "$tertiary-border-color": ["#b4b3a8","#383835"],
  "$form-input-focus-color": ["#c25124","#ec835a"],
  "$primary-font-size": ["14px","14px"],
};
check("Node-RED 238 variable upstream snapshot still available", [...rawLight.matchAll(/^\$[\w-]+\s*:/gm)].length === 238, [...rawLight.matchAll(/^\$[\w-]+\s*:/gm)].length);
check("Mcode SCSS light/dark 19 colors + base font size have exact source mappings",
  Object.entries(expected).every(([key, values]) => sourceLight.get(key) === values[0] && sourceDark.get(key) === values[1]));
check("Body family matches Mcode and Chinese fallbacks survive",
  [sourceLight,sourceDark].every((v) => v.get("$primary-font")?.includes("PingFang SC") &&
     v.get("$primary-font")?.includes("Segoe UI") && v.get("$primary-font")?.includes("Microsoft YaHei")));
check("Compiled light CSS is visible and carries precise Mcode tokens",
  light.includes("--red-ui-primary-background: #fcfcfb") &&
  light.includes("--red-ui-primary-text-color: #151515") &&
  light.includes("--red-ui-primary-border-color: #c3c2b7"));
check("Compiled dark CSS uses exact dark tokens",
  dark.includes("--red-ui-primary-background: #151515") &&
  dark.includes("--red-ui-primary-text-color: #f9f9f7") &&
  dark.includes("--red-ui-primary-border-color: #2c2c2a"));
check("Single mounted stylesheet retains both variants with live prefers-color-scheme",
  auto.includes("--red-ui-primary-background: #fcfcfb") &&
  auto.includes("@media (prefers-color-scheme: dark){") &&
  auto.includes("--red-ui-primary-background: #151515") &&
  auto.includes("border-radius:6px") && auto.includes("border-radius:8px"));
check("Node category/brand/grid values untouched in light and original dark-mode counterparts",
  [...baseVars].filter(([key]) => /^\$(palette-|view-grid-color|node-|github-)/.test(key))
    .every(([key,val]) => sourceLight.get(key) === val &&
      sourceDark.get(key) === (darkVendor.get(key) ?? val)));
check("T47 bootstrap actively mounts the injected CSS via editorTheme.page.css",
  registry.includes('editorTheme: { page: { css: process.env.MCODE_ENGINE_THEME_CSS || "" } }'));
check("Host injects the shipped CSS absolute path and explicitly fails missing assets",
  registry.includes("MCODE_ENGINE_THEME_CSS: resolveMcodeNodeRedThemeCss()") &&
  registry.includes("throw new Error(\"Node-RED Mcode 主题资源缺失"));
// Version is monotonic and shared with the manifest writer and integrity guard.
// T42 added nodesDir after T47 installed the theme (v2 -> v3): testing
// a fixed historical release number here makes valid future upgrades red.
const versionMatch = bootstrapManifest.match(/^export const BOOTSTRAP_VERSION\s*=\s*(\d+);/m);
const bootstrapVersion = versionMatch === null ? NaN : Number(versionMatch[1]);
check("Theme bootstrap uses a monotonic manifest version with runtime SHA guards",
  Number.isSafeInteger(bootstrapVersion) && bootstrapVersion >= 2 &&
  bootstrapManifest.includes("version: BOOTSTRAP_VERSION") &&
  bootstrapManifest.includes("sha256: sha256Of(content)") &&
  bootstrapManifest.includes("manifest.bootstrap.version === BOOTSTRAP_VERSION") &&
  bootstrapManifest.includes("manifest.bootstrap.sha256 === expectedHash") &&
  bootstrapManifest.includes("sha256OfBuffer(currentBytes) === expectedHash"),
  `version=${String(bootstrapVersion)}`);
check("Release copies theme CSS next to packaged Node-RED vendor",
  pack.includes("from: resources/node-red") && pack.includes("to: node-red/mcode-theme"));
console.log("node-red-theme-smoke:"+pass+"/"+(pass+failed)+" through");
if (failed) process.exitCode = 1;
