// 用已安装的 esbuild 把 i18n 的 zh/en 各域词典打成一个 ESM,再做对账。不装依赖、不起浏览器。
import { readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const desktop = resolve(import.meta.dirname, "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const pkg = readdirSync(pnpm).filter((n) => n.startsWith("esbuild@")).sort().at(-1);
if (!pkg) throw new Error("Installed esbuild required; no network fallback");
const { build } = await import(pathToFileURL(join(pnpm, pkg, "node_modules/esbuild/lib/main.js")).href);
const i18n = join(desktop, "src/renderer/lib/i18n");
const domains = readdirSync(join(i18n, "zh")).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, ""));
const dir = mkdtempSync(join(desktop, ".tmp", "maint-m37-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, domains.map((d, i) =>
  `import { zh as zh${i} } from ${JSON.stringify(join(i18n, "zh", d + ".ts").replace(/\\/g, "/"))};\n` +
  `import { en as en${i} } from ${JSON.stringify(join(i18n, "en", d + ".ts").replace(/\\/g, "/"))};`).join("\n") +
  `\nexport const dicts = {${domains.map((d, i) => `${JSON.stringify(d)}: { zh: zh${i}, en: en${i} }`).join(",")}};\n`);
await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: join(dir, "dicts.mjs"), logLevel: "error", tsconfig: join(desktop, "tsconfig.json") });
const { dicts } = await import(pathToFileURL(join(dir, "dicts.mjs")).href);

let checks = 0, failures = 0;
const check = (name, ok, detail) => { checks++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); if (!ok) failures++; };
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

const owner = new Map(); const dup = [];
const orphans = []; const missing = []; const phMismatch = []; const emptyText = [];
for (const [d, { zh, en }] of Object.entries(dicts)) {
  for (const k of Object.keys(zh)) {
    if (owner.has(k)) dup.push(`${k} (${owner.get(k)} & ${d})`); else owner.set(k, d);
    if (!(k in en)) missing.push(`${d}:${k}`);
    else if (placeholders(zh[k]) !== placeholders(en[k])) phMismatch.push(`${d}:${k} zh{${placeholders(zh[k])}} en{${placeholders(en[k])}}`);
    // 两边都空是刻意的"无标签"(idle / unmodified 之类的状态映射);只有一边空才是漏译。
    if ((String(zh[k]).trim() === "") !== (String(en[k] ?? "").trim() === "")) emptyText.push(`${d}:${k}`);
  }
  for (const k of Object.keys(en)) {
    if (!(k in zh)) orphans.push(`${d}:${k}`);
  }
}
console.log(`maint-m37-smoke —— ${Object.keys(dicts).length} 个域,${owner.size} 个 MessageId\n`);
check("同一 MessageId 不得在多个域文件重复定义(后者会静默覆盖前者)", dup.length === 0, dup.slice(0, 20));
check("en 的每个键都在 zh 里(无孤儿/拼写错的英文键 —— 那种英文界面会静默回落成中文)", orphans.length === 0, orphans.slice(0, 20));
check("zh 的每个键 en 都有(类型层已保证,这里运行期复核)", missing.length === 0, missing.slice(0, 20));
check("zh/en 同一键的 {占位符} 集合一致", phMismatch.length === 0, phMismatch.slice(0, 20));
check("没有只有一边为空的文案", emptyText.length === 0, emptyText.slice(0, 20));
rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} passed; ${failures} failed`);
process.exit(failures ? 1 : 0);
