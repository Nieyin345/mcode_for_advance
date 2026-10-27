/**
 * T49 —— `contributionsOf(undefined, …)` 首帧崩溃的最小复现。
 *
 * ## 为什么这是产品缺陷而不是测试问题
 *
 * `useRpc` 的 `data` 在**第一次请求成功之前恒为 `undefined`**（`useRpc.ts:53-55`：
 * "`undefined` until the first success"）。四个生产调用点都直接把它交给
 * `contributionsOf`：
 *
 *   - `RightPanel.tsx:123`（主界面右栏，常驻、无错误边界 → 首帧白屏）
 *   - `CommandPalette.tsx:208`
 *   - `ModuleContributions.tsx:35`（ModuleViewDock）
 *   - `ModuleContributions.tsx:145`（ModuleSettingsPanel）
 *
 * 而 `contributionsOf` 的承诺（注释白纸黑字）是「形状不对时**返回空而不是抛**」：
 * 它先问 `moduleCatalogShapeError(catalog)`，但那函数把 `undefined` 判成
 * **「还没读到 = 加载态，不是形状错误」**并返回 `null`，于是紧接着的
 * `catalog!.modules` 在首帧直接解引用 `undefined` → `TypeError`。
 *
 * ## 为什么抽片段而不是整文件 bundle
 *
 * `moduleCatalogShape.tsx` 在同一文件里还 import 了 `ErrorNote` / `Button` / `i18n`，
 * 整文件 bundle 会把 monaco、整棵 UI 树拖进来（实测 `Could not resolve
 * "monaco-editor/esm/vs/editor/editor.worker?worker"`）。被测的两个函数是**纯的**，
 * 所以这里只把它们所在的**源码区间**切出来，交给 esbuild 转译（去掉 TS 语法），
 * 再 import 真实产物 —— 不是手抄实现（硬规矩 4：不手抄代码）。
 *
 * 切片边界由**源码结构**决定（`export function <name>` 到配对的 `}`），不是行号，
 * 所以源码上方加注释/改格式不会让它静默失配；找不到时**显式失败**。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const desktop = process.cwd(); // run.sh 已 cd apps/desktop
const source = join(desktop, "src/renderer/components/modules/moduleCatalogShape.tsx");
if (!existsSync(source)) {
  // 【EXT-07】被测对象随 ModuleHost 一起下线了（用户裁决：只要一个扩展系统 = Theia 宿主）。
  //
  // 本套件验的是 `contributionsOf(undefined, …)` 的首帧崩溃 —— 而 `contributionsOf`
  // 和 `moduleCatalogShape.tsx` 都已经不存在了。**没有被测对象，就没有可验的东西。**
  //
  // 不删这套件（保留它记录的那个真实缺陷与修法），但**明确说不验了** ——
  // 静默 skip 会让下一个人以为「这里还有回归网」。
  console.log("  skip  被测对象已下线：moduleCatalogShape.tsx 随 ModuleHost 删除");
  console.log("  NOT-COVERED: contributionsOf 首帧崩溃（被测函数已不存在 —— 没有回归网，也不需要）");
  console.log("");
  console.log("T49 记录的那个缺陷（useRpc 的 data 首帧为 undefined，纯函数却直接解引用）");
  console.log("在 Theia 时代对应的形状是 `api.modules.theiaInstalled` 的首帧 —— 由");
  console.log("`theia-installed-smoke` 与 `theia-palette-smoke` 覆盖。");
  console.log("");
  console.log("t49-contributions-undefined-smoke: 0/0（被测对象已下线）");
  process.exit(0);
}
const src = readFileSync(source, "utf8");

/** 按源码结构切出 `export function <name>` 的完整定义（含签名），不按行号。
 *
 *  ⚠️ 找「函数体起点」不能只看第一个 `{`：签名里会出现两类 `{`——
 *   1. 泛型约束 `S extends X["slot"]`（尖括号内）；
 *   2. **返回类型** `Array<{ module: …; contribution: … }>`（尖括号内）。
 *  两者都在函数体之前。所以这里从参数表末尾往后扫，**只在尖括号深度为 0**
 *  时认第一个 `{` 为函数体。 */
function grabFunction(name: string): string {
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) throw Error(`T49: 源码里找不到 export function ${name}`);
  let i = src.indexOf("(", start);
  if (i < 0) throw Error(`T49: ${name} 没有参数表`);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") {
      paren--;
      if (paren === 0) break;
    }
  }
  if (paren !== 0) throw Error(`T49: ${name} 的参数表没有闭合`);
  // 从参数表末尾往后，跳过返回类型里的 `<>`，找到真正的函数体 `{`。
  let angle = 0;
  let open = -1;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "<") angle++;
    else if (ch === ">") { if (angle > 0) angle--; }
    else if (ch === "{") {
      if (angle === 0) { open = j; break; }
      // 尖括号里的对象类型（`{ slot: S }`）：跳过它，别把 `angle` 弄乱。
      let depth = 0;
      for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") { depth--; if (depth === 0) break; }
      }
    }
  }
  if (open < 0) throw Error(`T49: ${name} 没有函数体`);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw Error(`T49: ${name} 的函数体没有闭合`);
}

const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const esbuildBin = process.env.ESBUILD ?? (() => {
  const name = readdirSync(pnpm).filter((x) => x.startsWith("esbuild@")).sort().at(-1);
  if (!name) throw Error("T49: 找不到 esbuild");
  return join(pnpm, name, "node_modules/esbuild/bin/esbuild");
})();

const outDir = mkdtempSync(join(tmpdir(), "mcode-t49-pure-"));
const entry = join(outDir, "entry.ts");
const outFile = join(outDir, "entry.mjs");
try {
  // 片段缺类型声明（`ModuleCatalog` / `ModuleContribution` / `ModuleManifest`）——
  // esbuild 只转译不检查，但**语法上**必须能解析，所以给一份最小 ambient 声明
  // （形状来自 `@contracts/modules`，这里只取用到的成员）。
  const TYPES = [
    "type ModuleContribution = { slot: string; id?: string; [k: string]: unknown };",
    "type ModuleManifest = { id: string; contributions: ModuleContribution[]; [k: string]: unknown };",
    "type ModuleCatalog = { modules?: ModuleManifest[]; [k: string]: unknown };",
  ].join("\n");
  writeFileSync(
    entry,
    TYPES + "\n\n" +
      grabFunction("moduleCatalogShapeError") + "\n\n" + grabFunction("contributionsOf") + "\n",
  );
  // Windows 上 esbuild/bin/esbuild 是 Node 脚本，用当前 node 跑它。
  try {
    execFileSync(process.execPath, [
      esbuildBin, entry,
      "--bundle", "--platform=node", "--format=esm",
      `--outfile=${outFile}`, "--log-level=error",
    ], { stdio: "pipe" });
  } catch (e) {
    // execFileSync 抛出的 Error 把 stderr 放在 `.stderr`（Buffer）里；直接
    // console.log(e) 只会打一串数字数组（实测）。把它解码成可读文本再抛。
    const err = e as { stderr?: Buffer | string } | null;
    const stderr = err?.stderr ? Buffer.from(err.stderr).toString("utf8") : "";
    throw Error(`T49: esbuild 转译片段失败：\n${stderr || String(e)}`);
  }

  const mod = (await import(pathToFileURL(outFile).href)) as {
    contributionsOf: (catalog: unknown, slot: string) => Array<{ module: unknown; contribution: unknown }>;
    moduleCatalogShapeError: (catalog: unknown) => string | null;
  };
  const { contributionsOf, moduleCatalogShapeError } = mod;

  // ── 1. 复现：首帧（data === undefined）必须不抛、返回空数组 ──
  {
    let threw = null;
    let result = null;
    try { result = contributionsOf(undefined, "view"); } catch (e) { threw = String(e); }
    check("★ 首帧（data 还是 undefined）时 contributionsOf 不抛、返回空数组",
      threw === null && Array.isArray(result) && result.length === 0,
      { threw, result });
    check("moduleCatalogShapeError(undefined) 把「还没读到」当加载态（返回 null）",
      moduleCatalogShapeError(undefined) === null);
  }

  // ── 2. 正向对照：正常目录仍取得到贡献（防止修成「永远返回空」） ──
  {
    const manifest = {
      apiVersion: 1, id: "a.b", version: "1.0.0", title: { zh: "t", en: "t" },
      permissions: [],
      contributions: [{
        id: "v1", slot: "view", title: { zh: "t", en: "t" },
        capability: "core.file.info", location: "right", view: { kind: "fields", fields: [] },
      }],
    };
    const entries = contributionsOf({ modules: [manifest], capabilities: [] }, "view");
    check("★ 正向对照：正常目录仍返回 1 条 view 贡献", entries.length === 1, entries.length);
    const wrongSlot = contributionsOf({ modules: [manifest], capabilities: [] }, "command");
    check("正向对照：slot 不匹配时返回空", wrongSlot.length === 0, wrongSlot.length);
  }

  // ── 3. 反向对照：形状坏（modules 缺失/非数组）仍返回空、且能说出原因 ──
  {
    const missing = contributionsOf({ capabilities: [] }, "view");
    check("★ 反向对照：modules 缺失时返回空", Array.isArray(missing) && missing.length === 0, missing);
    check("★ modules 缺失时 moduleCatalogShapeError 给出原因",
      typeof moduleCatalogShapeError({ capabilities: [] }) === "string");
    const wrongType = contributionsOf({ modules: "nope" }, "view");
    check("modules 不是数组时返回空", Array.isArray(wrongType) && wrongType.length === 0, wrongType);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\nt49-contributions-undefined-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
