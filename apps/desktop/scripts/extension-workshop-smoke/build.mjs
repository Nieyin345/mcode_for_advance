/**
 * 【T20】扩展工坊的构建 + 变异驱动。
 *
 * - baseline：打包 `main.ts` → 真 node 跑；0 失败才算通过。
 * - 变异 1 `self-approve`：交接材料的 `installConsent` 改成 `allow-always`。
 * - 变异 2 `no-sandbox`：沙箱失败判定改成永远成功。
 *
 * 锚点缺失 = 构建直接失败（这本身也是"变异真的立在那道闸上"的证据）。
 */
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
const out = mkdtempSync(join(desktop, ".tmp/extension-workshop-"));

/**
 * 【T20】两条变异 —— 每条对应卡面的一句安全硬要求，锚点是产生该行为的**那一行**。
 */
const mutations = [
  {
    name: "self-approve",
    file: /modules[\\/]extensionWorkshop\.ts$/,
    target: 'installConsent: "allow-once",',
    replace: 'installConsent: "allow-always", // TEST MUTATION — AI 代签跨重启授权',
    fail: "★ 交接材料：requiresUserApproval 恒 true、installConsent 恒 allow-once（AI 拿不到跨重启授权）",
  },
  {
    name: "no-sandbox",
    file: /modules[\\/]extensionWorkshop\.ts$/,
    target: "if (!sandboxed.ok) {",
    replace: "if (false && !sandboxed.ok) { // TEST MUTATION — 沙箱失败也当成功",
    fail: "★ 沙箱冒烟失败 → 草稿清空、状态记一次失败（不装机、无残留目录）",
  },
];

let failures = 0;
for (const mutation of [null, ...mutations]) {
  const mode = mutation?.name ?? "baseline";
  const plugin = mutation === null ? [] : [{
    name: "t20-mutation-" + mode,
    setup(b) {
      b.onLoad({ filter: mutation.file }, (args) => {
        const original = readFileSync(args.path, "utf8");
        if (!original.includes(mutation.target)) throw Error("Mutation anchor missing: " + mode);
        return { contents: original.replaceAll(mutation.target, mutation.replace), loader: "ts" };
      });
    },
  }];
  const file = join(out, mode + ".mjs");
  await build({
    entryPoints: [join(desktop, "scripts/extension-workshop-smoke/main.ts")],
    bundle: true, platform: "node", format: "esm", outfile: file,
    tsconfig: join(desktop, "tsconfig.json"),
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    // 与 `extension-danger-delegation-smoke` 同一组换桩：工坊不碰 electron/DB，
    // 但 ModuleHost 那条链会拉到 repositories（sql.js）—— 本套用真临时目录 + 内存桩，
    // 所以把数据库/窗口/RuntimeManager 换成明确抛的替身，证明「工坊从不经它们」。
    alias: {
      electron: join(desktop, "scripts/library-delete-smoke/stubs/electron.ts"),
      "@main/lib/dataRoot.js": join(desktop, "scripts/run-store-smoke/stubs/dataRoot.ts"),
      "@main/lib/logger.js": join(desktop, "scripts/run-store-smoke/stubs/logger.ts"),
      "@main/store/repositories.js": join(desktop, "scripts/agent-guide-smoke/stubs/repositories.ts"),
      "@main/window.js": join(desktop, "scripts/app-control-smoke/stubs/window.ts"),
      "@main/claude/RuntimeManager.js": join(desktop, "scripts/app-control-smoke/stubs/runtimeManager.ts"),
      "@main/document/genofficeNativeVendor.js": join(desktop, "src/main/document/genofficeNativeVendorStub.ts"),
    },
    plugins: plugin,
    logLevel: "error",
  });
  const result = spawnSync(process.execPath, [file], {
    encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, MCODE_SMOKE_DATA_ROOT: join(out, "data-" + mode) },
  });
  const logs = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(out, mode + ".log"), logs);
  if (mode === "baseline") {
    console.log(logs);
    if (result.status !== 0) { console.log("T20 logs:", out); throw Error("T20 baseline failed"); }
  } else {
    const detected = result.status !== 0 && logs.includes("FAIL " + mutation.fail);
    console.log("Mutation " + mode + ": " + (detected ? "PASS (expected assertion RED)" : "FAIL (regression undetected)"));
    if (!detected) { failures++; console.error(logs.slice(-4000)); }
  }
}
console.log("T20 artifacts:", out);
if (failures) process.exitCode = 1;
