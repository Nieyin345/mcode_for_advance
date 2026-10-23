import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const pkg = readdirSync(pnpm).find(name => name.startsWith("esbuild@"));
if (!pkg) throw Error("Installed esbuild required");
const { build } = await import(pathToFileURL(join(pnpm, pkg, "node_modules/esbuild/lib/main.js")).href);
mkdirSync(join(desktop, ".tmp"), { recursive: true });
const out = mkdtempSync(join(desktop, ".tmp/extension-danger-delegation-"));
/**
 * 【T19】变异：把宿主那道 danger 逐次审批**撤掉**（改成"永远放行"）。
 * 断言 ①「调用 git.push → 触发审批」必须变红 —— 这是"判定真的立在闸门上"的
 * 证据，不是跑绿就算。锚点是 `approveDangerAppCall` 里的 level 判定；把它改成
 * `!== "danger" && false` 后，danger 调用不再进审批，dispatched 直接增长。
 */
const mutations = [
  {
    name: "danger-allowed",
    file: /ModuleHost\.ts$/,
    target: 'if (policyFor(method).level !== "danger") return;',
    replace: 'if (policyFor(method).level !== "danger" || true) return; // TEST MUTATION — danger silently allowed',
    fail: "①「绑定 git.write 权限」仍只是权限判定",
  },
  {
    name: "no-approval-needed",
    file: /ModuleHost\.ts$/,
    target: "await this.approveDangerAppCall(manifest, method, resource);",
    replace: "void resource; // TEST MUTATION — danger gate disconnected",
    fail: "★ 端到端：持有 git.write 的扩展经真子进程调 git.push",
  },
];
let failures = 0;
for (const mutation of [null, ...mutations]) {
  const mode = mutation?.name ?? "baseline";
  const plugin = mutation === null ? [] : [{
    name: "t19-mutation-" + mode,
    setup(b) {
      b.onLoad({ filter: mutation.file }, args => {
        const original = readFileSync(args.path, "utf8");
        if (!original.includes(mutation.target)) throw Error("Mutation anchor missing: " + mode);
        return { contents: original.replaceAll(mutation.target, mutation.replace), loader: "ts" };
      });
    },
  }];
  const file = join(out, mode + ".mjs");
  await build({
    entryPoints: [join(desktop, "scripts/extension-danger-delegation-smoke/main.ts")],
    bundle: true, platform: "node", format: "esm", outfile: file,
    tsconfig: join(desktop, "tsconfig.json"),
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    plugins: plugin,
    logLevel: "error",
  });
  const result = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const logs = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(out, mode + ".log"), logs);
  if (mode === "baseline") {
    console.log(logs);
    if (result.status !== 0) { console.log("T19 logs:", out); throw Error("T19 baseline failed"); }
  } else {
    const detected = result.status !== 0 && logs.includes("FAIL " + mutation.fail);
    console.log("Mutation " + mode + ": " + (detected ? "PASS (expected assertion RED)" : "FAIL (regression undetected)"));
    if (!detected) { failures++; console.error(logs.slice(-4000)); }
  }
}
console.log("T19 artifacts:", out);
if (failures) process.exitCode = 1;
