/**
 * 【F009】`main` 路径与 `publisher` 大小写。
 *
 * ## 这两条墙都是「29 个真实扩展里 0 个能过」
 *
 * | 规则 | 实测 |
 * |---|---|
 * | `main: z.literal("./extension.js")` | 27 个声明了 main，**恰好等于它：0 个** |
 * | `publisher: /^[a-z].../` | 本机 **4 个**扩展 publisher 含大写 |
 *
 * ## 结构性改动
 *
 * `readMinimalVsix` 从前按**固定名字**取两个条目。`main` 能是任意路径之后，
 * 必须先解析清单、再按它声明的路径去 ZIP 里找。
 *
 * ## 这套守的四件事
 *
 * 1. `./dist/extension.js` 这种**带目录**的路径能读；
 * 2. `./extension` 这种**无后缀**的能补成 `./extension.js`；
 * 3. `..` **逃逸仍被拒**（安全边界，不是格式偏好）；
 * 4. 大写 `publisher` 能装，且 `moduleId` 归一化。
 */
import { readMinimalVsix, VscodeL1Bridge } from "@main/modules/vscodeL1Bridge.js";
import { ModuleHost } from "@main/modules/ModuleHost.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zip.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const enc = new TextEncoder();
const dec = new TextDecoder();
const SRC = "exports.activate = () => {};";

function host(): ModuleHost {
  let perm: string | null = null;
  return new ModuleHost({
    authorize: async () => {}, persist: async () => {}, requestApproval: async () => {},
    verifyProgram: async () => ({ ok: true as const }),
    readModulePermissions: () => perm, persistModulePermissions: async (t) => { perm = t; },
  });
}

/** 按清单的 `main` 造对应的 ZIP 条目名（测试自己算，不复用生产代码的算法）。 */
function entryFor(mainField: string): string {
  const rel = mainField.replace(/^\.\//, "");
  const withJs = /\.js$/i.test(rel) ? rel : rel + ".js";
  return "extension/" + withJs;
}

function zipFor(pkgExtra: Record<string, unknown>, mainField: string, extraEntries: { name: string; data: Uint8Array }[] = []): Uint8Array {
  const pkg = { publisher: "acme", name: "demo", version: "1.0.0", main: mainField,
    engines: { vscode: "^1.80.0" }, activationEvents: ["onCommand:demo.hello"],
    contributes: { commands: [{ command: "demo.hello", title: "Hello" }] }, ...pkgExtra };
  return buildZip([
    { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
    { name: entryFor(mainField), data: enc.encode(SRC) },
    ...extraEntries,
  ], 8);
}

function safeRead(zip: Uint8Array): { ok: true; value: { packageJson: unknown; source: string } } | { ok: false; error: string } {
  try { return { ok: true, value: readMinimalVsix(zip) }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

console.log("[1] 正控：原有的 ./extension.js 仍能读");
{
  const r = safeRead(zipFor({}, "./extension.js"));
  check("★ ./extension.js 读取成功", r.ok, { error: r.ok ? undefined : r.error });
  if (r.ok) check("★ 源码正确", r.value.source === SRC);
}

console.log("[2] 带目录的 main（本卡的核心之一）");
{
  for (const mainField of ["./dist/extension.js", "./out/src/main.js", "./dist/node/extension.js"]) {
    const r = safeRead(zipFor({}, mainField));
    check(`★ ${mainField} 能被读取`, r.ok, { error: r.ok ? undefined : r.error });
    if (r.ok) check(`★   ${mainField} 的源码正确`, r.value.source === SRC);
  }
}

console.log("[3] 无后缀的 main 补 .js（本卡的核心之二）");
{
  // ./extension → 应找 extension/extension.js
  const r = safeRead(zipFor({}, "./extension"));
  check("★ ./extension 补成 ./extension.js 后能读", r.ok, { error: r.ok ? undefined : r.error });

  // ./out/extension 也是无后缀（真实扩展里 2 个这样写）
  const r2 = safeRead(zipFor({}, "./out/extension"));
  check("★ ./out/extension 也能补后缀并读取", r2.ok, { error: r2.ok ? undefined : r2.error });
}

console.log("[4] 负控：`..` 逃逸仍被拒（安全边界）");
{
  // ⚠️ **不能直接用 zipFor 造逃逸包** —— 它会把 `../escape.js` 拼成条目名
  // `extension/../escape.js`，那个名字**先撞 ZIP 白名单**，测试就验不到 schema 那一层了。
  // （第一版就是这么写的，报错是 `L1 VSIX entry not allowlisted` 而不是「路径逃逸」。）
  // 所以这里手工造：清单里写逃逸路径，包里放**一个合规的** `extension/extension.js`，
  // 让 schema 成为第一道关。
  function escapeZip(mainField: string): Uint8Array {
    const pkg = { publisher: "acme", name: "demo", version: "1.0.0", main: mainField,
      engines: { vscode: "^1.80.0" }, activationEvents: ["onCommand:demo.hello"],
      contributes: { commands: [{ command: "demo.hello", title: "Hello" }] } };
    return buildZip([
      { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
      { name: "extension/extension.js", data: enc.encode(SRC) }, // 合规条目，确保不是它先拒
    ], 8);
  }

  const r = safeRead(escapeZip("../escape.js"));
  check("★ ../escape.js 被拒", !r.ok, { error: r.ok ? "unexpectedly accepted" : undefined });
  check(
    "★ 拒绝理由是「main 必须是扩展根下的相对路径」（schema 那一层，不是白名单）",
    !r.ok && /relative path|no '\.\.'|escapes the extension root/i.test(r.error ?? "") &&
      !/not allowlisted/i.test(r.error ?? ""),
    { error: (r.ok ? "" : r.error).slice(0, 200) },
  );

  const r2 = safeRead(escapeZip("./dist/../../escape.js"));
  check("★ ./dist/../../escape.js 也被拒（不只看开头）", !r2.ok, {
    error: r2.ok ? "unexpectedly accepted" : undefined,
  });
  check(
    "★ 它同样死在 schema 的路径规则上",
    !r2.ok && !/not allowlisted/i.test(r2.error ?? ""),
    { error: (r2.ok ? "" : r2.error).slice(0, 200) },
  );
}

console.log("[5] 负控：ZIP 里没有声明的 main 时，错误说清「声明的是 X，包里没有」");
{
  // 清单声明 ./dist/extension.js，但包里放的是 extension/extension.js
  const pkg = { publisher: "acme", name: "demo", version: "1.0.0", main: "./dist/extension.js",
    engines: { vscode: "^1.80.0" }, activationEvents: ["onCommand:demo.hello"],
    contributes: { commands: [{ command: "demo.hello", title: "Hello" }] } };
  const zip = buildZip([
    { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
    { name: "extension/extension.js", data: enc.encode(SRC) }, // ← 不是声明的那条
  ], 8);
  const r = safeRead(zip);
  check("★ 缺声明的 main 时被拒", !r.ok, { error: r.ok ? "unexpectedly accepted" : undefined });
  check("★ 错误信息带上声明的路径", !r.ok && /\.\/dist\/extension\.js/.test(r.error ?? ""), {
    error: (r.ok ? "" : r.error).slice(0, 200),
  });
  check("★ 错误信息带上算出的条目名", !r.ok && /extension\/dist\/extension\.js/.test(r.error ?? ""), {
    error: (r.ok ? "" : r.error).slice(0, 200),
  });
  check("★ 错误信息列出包里实际有什么（可诊断）", !r.ok && /entries:.*extension\/extension\.js/.test(r.error ?? ""), {
    error: (r.ok ? "" : r.error).slice(0, 200),
  });
}

console.log("[6] publisher 大小写：装得上，且 moduleId 归一化");
{
  // 大写的 publisher（真实里是 James-Yu）
  const zip = zipFor({ publisher: "Acme-Corp" }, "./extension.js");
  const h = host();
  let installed: VscodeL1Bridge | null = null;
  let error: string | undefined;
  try {
    installed = await VscodeL1Bridge.install(h, zip, { confirmReadAccess: true, confirmExecutableCode: true });
  } catch (e) { error = String(e); }

  check("★ 含大写的 publisher 能装（旧正则拒）", installed !== null, { error });
  if (installed) {
    check("★ moduleId 归一化成小写", installed.moduleId === installed.moduleId.toLowerCase(), {
      moduleId: installed.moduleId,
    });
    check("★ moduleId 是 user.acme-corp.demo", installed.moduleId === "user.acme-corp.demo", {
      moduleId: installed.moduleId,
    });
    const inCatalog = h.catalog().modules.some((m) => m.id === installed!.moduleId);
    check("★ 目录里的 id 也是归一化后的", inCatalog, { ids: h.catalog().modules.map((m) => m.id) });
  }
}

console.log("[7] 归一化撞车：两个只差大小写的 publisher 不能静默互相覆盖");
{
  const h = host();
  // 先装 Acme-Corp 的 demo，标题 A
  await VscodeL1Bridge.install(h, zipFor({ publisher: "Acme-Corp", displayName: "Title A" }, "./extension.js"),
    { confirmReadAccess: true, confirmExecutableCode: true });
  // 再装 acme-corp 的 demo，标题 B —— 归一化后同一个 id，但来源不同
  let error: string | undefined;
  try {
    await VscodeL1Bridge.install(h, zipFor({ publisher: "acme-corp", displayName: "Title B", version: "2.0.0" }, "./extension.js"),
      { confirmReadAccess: true, confirmExecutableCode: true });
  } catch (e) { error = String(e); }
  check("★ 归一化撞车被拒绝（不静默覆盖）", error !== undefined && /collision/i.test(error), {
    error: (error ?? "没有拒 —— 静默覆盖了").slice(0, 200),
  });

  // 但**同一来源的升级**（标题相同、版本更高）必须允许
  const h2 = host();
  await VscodeL1Bridge.install(h2, zipFor({ publisher: "Acme-Corp", displayName: "Same" }, "./extension.js"),
    { confirmReadAccess: true, confirmExecutableCode: true });
  let upgradeError: string | undefined;
  try {
    await VscodeL1Bridge.install(h2, zipFor({ publisher: "acme-corp", displayName: "Same", version: "2.0.0" }, "./extension.js"),
      { confirmReadAccess: true, confirmExecutableCode: true });
  } catch (e) { upgradeError = String(e); }
  check("★ 同一来源的升级仍允许（大小写不同但标题一致）", upgradeError === undefined, {
    error: (upgradeError ?? "").slice(0, 200),
  });
}

console.log("[8] 真实扩展：rainbow-csv 的 main 这一关");
{
  const p = join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1/package.json");
  let pkg: any = null;
  try { pkg = JSON.parse(readFileSync(p, "utf8")); } catch { /* 没装 */ }
  if (!pkg) {
    console.log("      （本机没有 rainbow-csv，跳过）");
  } else {
    console.log(`      rainbow-csv 的 main = ${JSON.stringify(pkg.main)}`);
    // 用它的**真实 main 值**造包：`./extension` → 条目 `extension/extension.js`
    const zip = zipFor({ publisher: pkg.publisher, name: pkg.name }, pkg.main);
    const r = safeRead(zip);
    check(`★ main='${pkg.main}' 现在能被解析出源码（旧的字面量规则会拒）`, r.ok, {
      error: r.ok ? undefined : r.error,
    });
  }
}

console.log("[9] main 的**形状**校验在 install 层（不在 read 层）");
{
  // ⚠️ 这一组是补上的，因为第一版缺它，导致「main 改回字面量」变异红 0 条。
  //
  // 原因：`packageSchema` 只在 `VscodeL1Bridge.install()` 里 parse（:570），
  // 而 `readMinimalVsix` **完全不知道 schema 的存在** —— 它只按 `main` 的值去 ZIP 里找条目。
  // 所以 `main` 的形状规则（必须是 `./` 开头、不许 `..`、原来是字面量）
  // **只在 install 这一层生效**。测在 read 层等于什么都没测。
  //
  // 这里每条都走 install，才真正覆盖 schema。
  async function installOnly(mainField: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await VscodeL1Bridge.install(host(), zipFor({}, mainField), {
        confirmReadAccess: true, confirmExecutableCode: true,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 9a: 带目录的 main 能装（这一条在「改回字面量」变异下会红）
  for (const mainField of ["./dist/extension.js", "./out/src/main.js"]) {
    const r = await installOnly(mainField);
    check(`★ install 层接受带目录的 main：${mainField}`, r.ok, { error: r.error });
  }

  // 9b: 无后缀的 main 能装
  {
    const r = await installOnly("./extension");
    check("★ install 层接受无后缀的 main：./extension", r.ok, { error: r.error });
  }

  // 9c: 逃逸的 main 在 install 层被拒。
  //
  // ⚠️ 两道防线都会拒它，**顺序是白名单在前**：
  //   - ZIP 条目白名单（`extension/..` 这类名字直接不合法）；
  //   - `packageSchema` 的 main 路径规则。
  // 用一个「包里放合规条目、清单写逃逸路径」的包，能让 schema 成为第一道（见 [4] 组）；
  // 这里走 zipFor 则白名单先拒。**两条都验，但不断言「是哪一条拒的」** ——
  // 那取决于顺序，而顺序是实现细节。**只要拒了、且理由可读**，就算过。
  {
    const r = await installOnly("../escape.js");
    check("★ install 层拒绝逃逸的 main：../escape.js", !r.ok, { error: r.ok ? "unexpectedly accepted" : undefined });
    check(
      "★ 拒绝理由可读（说清是条目名不合法或路径规则）",
      !r.ok && /not allowlisted|relative path|no '\.\.'/.test(r.error ?? ""),
      { error: (r.ok ? "" : (r.error ?? "")).slice(0, 200) },
    );
  }
}

console.log(`\nvsix-main-path-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
