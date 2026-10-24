/**
 * vscode-compat-gate-smoke —— **闸门真的会拦吗？**
 *
 * ## 这个套件在验什么
 *
 * F018 的 `packages/vscode-compat/src/_gate.ts` 用裸 `satisfies typeof vscode.X`
 * 给每个命名空间钉「实现必须完整」。这个套件证明**那种写法真的会拦**，
 * 而且**别的写法不会拦** —— 后者是本套件的核心。
 *
 * ## 四组断言（卡上的要求，原样保留编号）
 *
 * 1. **`_gate.ts` 确实被 exclude** —— 读 `tsconfig.json`（JSONC，带注释），
 *    断言 `exclude` 里有它；然后断言**包本身** `tsc --noEmit` **exit 0**。
 * 2. **正向：完整对象编译通过** —— 用 `satisfies typeof vscode.commands` 写一个
 *    **四个方法都实现**的对象，断言 `tsc` exit 0。
 *    > 没有这条，闸门恒红时第 3 条照样绿 —— 那会把「编译器坏了」伪装成「闸门在工作」。
 *    >
 *    > ⚠️ 卡上写「把三个方法都实现」，但 `commands` 命名空间实际有 **4** 个成员
 *    > （`registerCommand` / `registerTextEditorCommand` / `executeCommand` / `getCommands`）。
 *    > 「三个」是「缺三个」的笔误。这里实现全部 4 个 —— 完整对象才是正控。
 * 3. **负向：缺一个方法编译失败** —— 两件事，缺一不可：
 *    a. 夹具（缺 `registerTextEditorCommand`）断言 exit ≠ 0，**并且**报错文本点名那个方法。
 *       只断言「失败了」不够：语法写错也是失败。
 *    b. **真正的 `_gate.ts`** 单独编译 exit ≠ 0，且每个命名空间的缺口被点名 ——
 *       这是「每一行都要真的红」的可执行形式（卡第三节）。
 * 4. **假闸门对照：`as` / `satisfies Partial<>` 都会放过缺方法** ——
 *    同一份不完整对象，换成这两种写法，断言各 **exit 0**。
 *    > **这一条是本卡真正的判据**：它证明「我们选的写法」比别的写法严。
 *    > 没有它，下一个人把 `satisfies` 改成 `as`，套件仍然全绿。
 *
 * ## 附加组：`_gate.ts` 的写法纪律
 *
 * 第 4 组验的是「另外两种写法会假绿」；附加组验的是「`_gate.ts` 自身没用那两种写法」。
 * 它读**真源码**（先剥注释，避免注释里引用的 `as typeof vscode.commands` 被当成代码），
 * 逐命名空间断言 `satisfies` 在位。**这不是抄一份逻辑** —— 断言的对象就是生产文件本身。
 *
 * ## 预期红数（跑之前写下的，见任务卡回写区）
 *
 * 正常状态：组 1 绿 5、组 2 绿 1、组 3 绿 19（2 夹具 + 1 闸门 + 16 命名空间点名）、
 * 组 4 绿 2、附加绿 18（16 命名空间 satisfies + 2 条写法禁令）—— **共 45 条全绿**。
 * 变异「`_commands` 那行 satisfies → as」：预期 **红 3**（组 3 点名 1、附加 satisfies 1、附加 no-as 1）。
 * 变异「删掉 tsconfig 的 exclude」：预期 **红 1**（组 1 的包 tsc exit 0）——实测红 2，见回写区。
 * 变异「删掉 `_gate.ts` 的 workspace 一行」：预期 **红 2**（点名 1 + satisfies 1）。
 * 变异「组 3/4 的缺方法夹具补全」：预期 **红 2**（exit≠0 与点名各 1）。
 * 变异「组 2 的正控夹具删一个成员」：预期 **红 1**。
 *
 * ## 环境前提
 *
 * `packages/vscode-compat` 已 `pnpm install`（`@types/vscode@1.140.0`）。
 * 找不到就**硬错**，不静默跳过 —— 跳过和通过长得一样。
 *
 * Run: scripts/vscode-compat-gate-smoke/run.sh
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// run.sh 会 cd 到 apps/desktop（本仓库所有套件的约定），用 cwd 而不是
// import.meta.url —— 后者在 esbuild 产物里指向 .tmp 的临时目录。
const APP_DIR = process.cwd();
const REPO_ROOT = join(APP_DIR, "..", "..");
const COMPAT_DIR = join(REPO_ROOT, "packages", "vscode-compat");

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n[${title}]`);
}

// ── 环境自检（硬错，不跳过） ────────────────────────────────────────────────

const desktopPkg = join(APP_DIR, "package.json");
let cwdOk = false;
try {
  cwdOk = JSON.parse(readFileSync(desktopPkg, "utf8")).name === "@mcode/desktop";
} catch {
  cwdOk = false;
}
if (!cwdOk) {
  console.error(`vscode-compat-gate-smoke: cwd 不是 apps/desktop（当前 ${APP_DIR}）—— 请通过 run.sh 运行`);
  process.exit(2);
}

/** 找 `tsc` —— 优先本包/仓库根，`apps/desktop/node_modules` 兜底。找不到就硬错。 */
function findTsc(): string {
  const candidates = [
    join(COMPAT_DIR, "node_modules", "typescript", "lib", "tsc.js"),
    join(REPO_ROOT, "node_modules", "typescript", "lib", "tsc.js"),
    join(APP_DIR, "node_modules", "typescript", "lib", "tsc.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  console.error("vscode-compat-gate-smoke: 找不到 typescript/lib/tsc.js —— 先 pnpm install");
  process.exit(2);
}
const TSC = findTsc();

/** `@types/vscode` 被装在这个包自己的 node_modules 下；找不到就硬错。 */
function findTypeRoots(): string {
  const candidate = join(COMPAT_DIR, "node_modules", "@types");
  if (!existsSync(join(candidate, "vscode", "index.d.ts"))) {
    console.error(`vscode-compat-gate-smoke: @types/vscode 不在 ${candidate} —— 先 pnpm install`);
    process.exit(2);
  }
  return candidate;
}
const TYPE_ROOTS = findTypeRoots();

const TMP = mkdtempSync(join(tmpdir(), "mcode-vscode-gate-smoke-"));

/** 起一次 `tsc --noEmit`，返回 `{ status, output }`。output 合并 stdout + stderr。 */
function runTsc(cwd: string, files: string[], typeRoots?: string): { status: number; output: string } {
  const args = [
    TSC,
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target", "ES2022",
    "--module", "ESNext",
    "--moduleResolution", "bundler",
    "--types", "vscode",
  ];
  if (typeRoots) args.push("--typeRoots", typeRoots);
  args.push(...files);
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function writeFixture(name: string, source: string): string {
  const file = join(TMP, name);
  writeFileSync(file, source, "utf8");
  return file;
}

/**
 * 剥掉源码里的注释 —— 只用于「源码写法纪律」断言。
 *
 * 逐字符扫描，处理 `//` 与 `/*…*​/`，并且**不把字符串里的 `//` 当注释**。
 * 不剥注释的话，`_gate.ts` 文件头表格里引用的 `as typeof vscode.commands`
 * 会让「没有 as」那条断言恒红 —— 而它红的原因和要证明的事无关（第八条第 2 种形态）。
 */
function stripComments(source: string): string {
  let out = "";
  let inString: string | null = null;
  let escape = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (escape) { out += ch; escape = false; continue; }
    if (ch === "\\") { out += ch; escape = true; continue; }
    if (inString !== null) {
      if (ch === inString) inString = null;
      out += ch;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { inString = ch; out += ch; continue; }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++; // 跳过结尾的 '/'
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 组 1 —— `_gate.ts` 被 exclude，包本身 tsc exit 0   （预期：绿 5，红 0）
// ═══════════════════════════════════════════════════════════════════════════
section("组 1 —— _gate.ts 被 exclude + 包本身 tsc exit 0");

const pkgTsconfig = join(COMPAT_DIR, "tsconfig.json");
const gateTs = join(COMPAT_DIR, "src", "_gate.ts");

check("★ tsconfig.json 存在", existsSync(pkgTsconfig), { path: pkgTsconfig });
check("★ _gate.ts 存在（闸门是本卡产物，不是空文件）", existsSync(gateTs), { path: gateTs });

let tsconfig: { exclude?: unknown; include?: unknown } = {};
let tsconfigOk = false;
if (existsSync(pkgTsconfig)) {
  try {
    tsconfig = JSON.parse(stripComments(readFileSync(pkgTsconfig, "utf8")));
    tsconfigOk = true;
  } catch (err) {
    tsconfigOk = false;
    console.log(`  (tsconfig.json JSONC 解析失败: ${String(err)})`);
  }
}
check("tsconfig.json 能被 JSONC 解析（允许注释）", tsconfigOk);

const excludeList = Array.isArray(tsconfig.exclude) ? (tsconfig.exclude as unknown[]) : [];
/** `./src/_gate.ts` 和 `src/_gate.ts` 都算 —— 断言的是「这个文件被排除」，不是拼写。 */
const excludesGate = excludeList.some(
  (entry) => typeof entry === "string" && entry.replace(/^\.\//, "") === "src/_gate.ts",
);
check("★ tsconfig.exclude 里有 src/_gate.ts（少了这行整包永远编译不过）", excludesGate, {
  exclude: tsconfig.exclude,
});

const pkgTsc = spawnSync(process.execPath, [TSC, "--noEmit", "-p", pkgTsconfig], {
  cwd: COMPAT_DIR,
  encoding: "utf8",
  windowsHide: true,
});
check("★ 包本身 tsc --noEmit exit 0（证明 exclude 生效）", pkgTsc.status === 0, {
  status: pkgTsc.status,
  output: `${pkgTsc.stdout ?? ""}${pkgTsc.stderr ?? ""}`.slice(0, 800),
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 2 —— 正向：完整对象 satisfies 通过          （预期：绿 1，红 0）
// ═══════════════════════════════════════════════════════════════════════════
section("组 2 —— 完整对象（commands 4 个成员都实现）satisfies 通过");

// 签名按 `@types/vscode` 原样写。`registerTextEditorCommand` 的 callback 在
// `strictFunctionTypes` 下是**逆变**检查的 —— 写成 `(...a: unknown[]) => void`
// 会接不住 `TextEditor`，那不是闸门在拦，是夹具自己写错了。
const FULL = writeFixture("full.ts", `
import type * as vscode from "vscode";

const impl = {
  registerCommand: (_command: string, _callback: (...args: any[]) => any, _thisArg?: any) => ({ dispose() {} }),
  registerTextEditorCommand: (
    _command: string,
    _callback: (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, ...args: any[]) => void,
    _thisArg?: any,
  ) => ({ dispose() {} }),
  executeCommand: async <T>(_command: string, ..._rest: any[]): Promise<T> => undefined as T,
  getCommands: async (_filterInternal?: boolean): Promise<string[]> => [],
};
export const _commands = impl satisfies typeof vscode.commands;
`);

const fullResult = runTsc(TMP, [FULL], TYPE_ROOTS);
check("★ 完整对象 satisfies 通过（正向对照）", fullResult.status === 0, {
  status: fullResult.status,
  output: fullResult.output.slice(0, 800),
});

// ═══════════════════════════════════════════════════════════════════════════
// 组 3 —— 负向：缺一个方法编译失败且点名      （预期：绿 8，红 0）
// ═══════════════════════════════════════════════════════════════════════════
section("组 3 —— 缺方法的 satisfies 必须红且点名（夹具 + 真正的 _gate.ts）");

// ⚠️ 这个夹具与组 4 用的是**同一份对象**（只实现 registerCommand），
// 这样组 4 的对照才成立：同一输入，三种写法，两种放行一种拦。
// 这也是卡里写卡人实测过的样本形态（`.tmp/types-probe/g1.ts`）。
const MISSING_FIXTURE_BODY = `
const impl = {
  registerCommand: (_command: string, _callback: (...args: any[]) => any, _thisArg?: any) => ({ dispose() {} }),
};`;

const MISSING = writeFixture("missing.ts", `
import type * as vscode from "vscode";
${MISSING_FIXTURE_BODY}
export const _commands = impl satisfies typeof vscode.commands;
`);

const missingResult = runTsc(TMP, [MISSING], TYPE_ROOTS);
check("★ 夹具缺 3 个方法（只实现 registerCommand）：satisfies exit ≠ 0", missingResult.status !== 0, {
  status: missingResult.status,
  output: missingResult.output.slice(0, 800),
});
check(
  "★ 夹具报错点名缺的方法（不是「语法写错」也能满足）",
  missingResult.output.includes("registerTextEditorCommand"),
  { output: missingResult.output.slice(0, 800) },
);

// 真正的 _gate.ts：单独编译（不用 -p，避开 exclude），每一行都必须红。
const gateResult = runTsc(COMPAT_DIR, [gateTs]);
check("★ 真正的 _gate.ts 单独编译 exit ≠ 0（每一行缺口都是真的）", gateResult.status !== 0, {
  status: gateResult.status,
  output: gateResult.output.slice(0, 800),
});

// 逐个命名空间点名：任一行的 satisfies 被改成 as / Partial 或删掉，对应这条会红。
// 16 个全部列出（与 `_gate.ts` 一一对应）；「缺口成员名」取报错里一定出现的那一个。
// l10n 的第一个成员是 `t` —— 单字母在报错里太容易误中，改用 `bundle`。
const GATE_NAMES: ReadonlyArray<readonly [namespace: string, missingName: string]> = [
  ["commands", "registerTextEditorCommand"],
  ["window", "showTextDocument"],
  ["workspace", "getWorkspaceFolder"],
  ["languages", "getLanguages"],
  ["env", "createTelemetryLogger"],
  ["debug", "registerDebugConfigurationProvider"],
  ["tasks", "registerTaskProvider"],
  ["lm", "selectChatModels"],
  ["authentication", "getSession"],
  ["notebooks", "createNotebookController"],
  ["extensions", "getExtension"],
  ["l10n", "bundle"],
  ["scm", "createSourceControl"],
  ["comments", "createCommentController"],
  ["tests", "createTestController"],
  ["chat", "createChatParticipant"],
];
for (const [ns, missingName] of GATE_NAMES) {
  check(`★ _gate.ts 的 ${ns} 缺口被点名：${missingName}`, gateResult.output.includes(missingName), {
    output: gateResult.output.slice(0, 1200),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 组 4 —— 假闸门对照：as / satisfies Partial<> 都会放过缺方法 （预期：绿 2，红 0）
// ═══════════════════════════════════════════════════════════════════════════
section("组 4 —— 假闸门对照：as 和 satisfies Partial 都放过缺成员");

// ⚠️ **`as` 的「假绿」有前提，卡上没写全 —— 实测记录在这里。**
//
// 本套件第一版用「缺 1 个方法、其余 3 个签名正确」的对象测 `as`，结果 `tsc` **exit 2**
// 报 `TS2352: Conversion of type ... may be a mistake because neither type sufficiently
// overlaps with the other`。**拦住它的是 `as` 的「足够重叠」规则，不是完整性检查。**
//
// 换成「只实现 1 个方法」的**同一个对象**（卡里 `.tmp/types-probe/g1.ts` 的形态），
// `as` 放行 —— 因为源类型（只有一个成员）是目标类型的子集，重叠成立。
//
// **所以「as 会假绿」不是无条件的：** 它取决于对象与目标类型的形状关系。
// 但**对 `_gate.ts` 这种「从零开始只写几个成员」的用法，它就是会假绿** ——
// 而那正是本包采用的形态。这条断言忠于这个前提，不宣称更强的结论。
const AS_VERSION = writeFixture("as.ts", `
import type * as vscode from "vscode";
${MISSING_FIXTURE_BODY}
export const _commands = impl as typeof vscode.commands;
`);
const asResult = runTsc(TMP, [AS_VERSION], TYPE_ROOTS);
check("★ 同一份缺方法对象用 as 写：exit 0（as 绕过了检查 —— 仅在类型重叠成立时）", asResult.status === 0, {
  status: asResult.status,
  output: asResult.output.slice(0, 800),
});

const PARTIAL_VERSION = writeFixture("partial.ts", `
import type * as vscode from "vscode";
${MISSING_FIXTURE_BODY}
export const _commands = impl satisfies Partial<typeof vscode.commands>;
`);
const partialResult = runTsc(TMP, [PARTIAL_VERSION], TYPE_ROOTS);
check("★ 同一份缺方法对象用 satisfies Partial 写：exit 0（Partial 放过了检查）", partialResult.status === 0, {
  status: partialResult.status,
  output: partialResult.output.slice(0, 800),
});

// ═══════════════════════════════════════════════════════════════════════════
// 附加组 —— `_gate.ts` 自身的写法纪律             （预期：绿 7，红 0）
// ═══════════════════════════════════════════════════════════════════════════
section("附加组 —— _gate.ts 用 satisfies 而非 as / Partial（逐命名空间）");

if (existsSync(gateTs)) {
  const gateCode = stripComments(readFileSync(gateTs, "utf8"));
  for (const [ns] of GATE_NAMES) {
    check(
      `★ _gate.ts 的 ${ns} 用裸 satisfies typeof vscode.${ns}`,
      new RegExp(`satisfies\\s+typeof\\s+vscode\\.${ns}`).test(gateCode),
    );
  }
  check(
    "★ _gate.ts 代码行里没有 `as typeof vscode.`（会绕过闸门）",
    !/\bas\s+typeof\s+vscode\.[A-Za-z]+/.test(gateCode),
  );
  check(
    "★ _gate.ts 代码行里没有 `satisfies Partial<typeof vscode.`（部分满足算通过）",
    !/satisfies\s+Partial\s*<\s*typeof\s+vscode\.[A-Za-z]+/.test(gateCode),
  );
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks`);
if (failures > 0) process.exitCode = 1;
