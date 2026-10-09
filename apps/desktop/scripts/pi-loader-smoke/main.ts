/**
 * piSdkLoader 的语言/文案回归。
 *
 * 用户可见的两句话 —— 「Pi is not installed…」与「Pi runtime failed to load…」——
 * 原来都是**英文打头**。它们的兄弟(Claude/Codex 的未安装提示)都是中文打头,
 * 而且这两句会经 providerHealth 的 `error` 直接画在状态栏/起轮错误上,不是给模型看的。
 * 这里驱动**真** loadPiSdk,分别构造「托管安装加载失败」与「哪儿都没装」,断言是中文。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPiSdk } from "@main/providers/pi-sdk/piSdkLoader.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function caughtMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "<no throw>";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

console.log("\n1. 托管安装加载失败时的错误是中文(设置面板/状态栏原样显示)");
{
  const root = mkdtempSync(join(tmpdir(), "mcode-pi-loader-managed-"));
  try {
    const pkgDir = join(root, "pi", "9.9.9", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: { ".": "./dist/index.js" } }));
    // 入口存在但导入即抛 → importManagedPiSdk 抛,被 loadPiSdk 的 .catch 包成中文。
    writeFileSync(join(pkgDir, "dist", "index.js"), 'throw new Error("boom from managed pi entry");\n');
    process.env["MCODE_SMOKE_MANAGED_ROOT"] = root;
    process.env["MCODE_SMOKE_MANAGED_VERSIONS"] = "9.9.9";
    const msg = await caughtMessage(() => loadPiSdk());
    check("★ 托管加载失败文案是中文", /[一-鿿]/.test(msg), msg);
    check("★ 不含英文原文 'failed to load from the managed install'", !/failed to load from the managed install/i.test(msg), msg);
    check("…且带上底层原因(变量照旧透出)", msg.includes("boom from managed pi entry"), msg);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n2. 哪儿都没装时的错误是中文(与 Claude/Codex 的未安装提示同形)");
{
  delete process.env["MCODE_SMOKE_MANAGED_ROOT"];
  delete process.env["MCODE_SMOKE_MANAGED_VERSIONS"];
  const msg = await caughtMessage(() => loadPiSdk());
  check("★ 未安装文案是中文打头", /^Pi 未安装/.test(msg), msg);
  check("★ 不含英文打头的原文 'Pi is not installed. Open Settings'", !/^Pi is not installed/i.test(msg), msg);
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
