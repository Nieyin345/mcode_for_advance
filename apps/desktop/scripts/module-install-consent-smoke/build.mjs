import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const pkg = readdirSync(pnpm).find((name) => name.startsWith("esbuild@"));
if (!pkg) throw Error("Installed esbuild required");
const { build } = await import(pathToFileURL(join(pnpm, pkg, "node_modules/esbuild/lib/main.js")).href);
mkdirSync(join(desktop, ".tmp"), { recursive: true });
const out = mkdtempSync(join(desktop, ".tmp/module-install-consent-"));

/**
 * 变异验证：撤掉一条安全属性 → 对应断言**必须变红**。每条都指名它要让哪条
 * PASS 行消失；找不到锚点直接抛错（防止"变异没生效却看起来全绿"）。
 */
const mutations = [
  {
    name: "deny-writes",
    file: /ModuleHost\.ts$/,
    target: 'if (decision === "deny") throw Error("用户拒绝了这次安装，未写入任何内容");',
    replace: 'if (decision === "deny") { /* mutation: 拒绝仍继续 */ }',
    fail: "① 拒绝安装:先于任何持久化抛出明确错误",
  },
  {
    name: "session-ignores-boot",
    file: /ModuleHost\.ts$/,
    target: 'if (record.duration === "session" && record.bootId !== this.bootId) return null;',
    replace: 'if (false && record.duration === "session" && record.bootId !== this.bootId) return null;',
    fail: "② 重启后:同一扩展的 menu 授权失效(modulePermissions = null)",
  },
  {
    name: "always-is-session",
    file: /ModuleHost\.ts$/,
    target: '? {duration:"session" as const, bootId:this.bootId}',
    replace: '? {duration:"session" as const, bootId:this.bootId} : decision === "allow-always" ? {duration:"session" as const, bootId:"stale-boot"}',
    fail: "③ 始终允许:重启后目录仍显示已授权(不再询问)",
  },
  {
    name: "agent-can-always",
    file: /installConsentPolicy\.ts$/,
    target: 'if (decision === "allow-always" && desktopSenderId(event) === null) return "allow-once";',
    replace: 'if (false) return "allow-once";',
    fail: "⑧ 无渲染端发送方(Agent/扩展委托/面板桥)→ allow-always 收窄为 allow-once",
  },
];
let mutationFailures = 0;
for (const mutation of [null, ...mutations]) {
  const mode = mutation?.name ?? "baseline";
  const plugin = mutation === null ? [] : [{ name: "t18-mutation-" + mode, setup(b) {
    b.onLoad({ filter: mutation.file }, (args) => {
      const original = readFileSync(args.path, "utf8");
      if (!original.includes(mutation.target)) throw Error("Mutation anchor missing: " + mode);
      return { contents: original.replace(mutation.target, mutation.replace), loader: "ts" };
    });
  } }];
  const file = join(out, mode + ".mjs");
  await build({
    entryPoints: [join(desktop, "scripts/module-install-consent-smoke/main.ts")],
    bundle: true, platform: "node", format: "esm", outfile: file,
    tsconfig: join(desktop, "tsconfig.json"), plugins: plugin, logLevel: "error",
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
  });
  const result = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 120000 });
  const logs = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(out, mode + ".log"), logs);
  if (mode === "baseline") {
    console.log(logs);
    if (result.status !== 0) throw Error("T18 baseline failed; see " + join(out, mode + ".log"));
  } else {
    const detected = result.status !== 0 && logs.includes("FAIL " + mutation.fail);
    console.log(`Mutation ${mode}: ${detected ? "PASS (assertion RED)" : "FAIL (assertion did not detect regression)"}`);
    if (!detected) { mutationFailures++; console.error(logs.slice(-3000)); }
  }
}
console.log("T18 artifacts:", out);
if (mutationFailures) process.exitCode = 1;
