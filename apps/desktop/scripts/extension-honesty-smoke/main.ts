/**
 * 【】扩展线的**文档诚实性**回归。
 *
 * ## 这套验的不是扩展功能，是「文档说的和代码做的是不是一回事」
 *
 * 起因：`CLAUDE.md` 曾把扩展线写成「`ModuleHost` + **VS Code API 薄映射**」，
 * 而 `.vsix` 全仓没有安装入口。一个开发者读到那行会以为「我可以把 VS Code 扩展搬过来」。
 *
 * ## 第 5 条是本套的核心
 *
 * 它把「文档的说法」和「代码的事实」钉在一起：`VscodeL1Bridge` 在 `src/` 内零调用方，
 * 只被 `scripts/vscode-l1-smoke` 引用。**如果哪天真的做了 VSIX 安装路径，这条会红** ——
 * 那时该回来改文档，而不是让文档继续撒谎。
 *
 * ⚠️ **两个范围必须分开断言**。写卡时第一次 grep 的是 `apps/desktop/src/`，得到「0 个调用点」，
 * 差点写成「全仓唯一调用方」那种更强的说法 —— 而调用方其实在 `scripts/`。
 * 「搜不到」和「只在那一处」是两个不同的事实，合成一条会在范围变化时给错答案。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/* ── 取 CLAUDE.md 里「扩展」那一行（不扫全文，避免别处提到也算命中）── */
const claudeMd = read("../../CLAUDE.md");
const extensionRow = claudeMd.split("\n").find((l) => l.startsWith("| 扩展 |")) ?? "";

console.log("[1] CLAUDE.md 的扩展行不再声称「VS Code API 薄映射」");
check("★ 扩展行存在", extensionRow.length > 0, { extensionRow });
check("★ 不含「VS Code API 薄映射」", !extensionRow.includes("VS Code API 薄映射"), { extensionRow });

console.log("[2] CLAUDE.md 的扩展行说清「不能装什么」");
check(
  "★ 提到 .vsix 或「VS Code 扩展」的不支持",
  /\.vsix|VS Code 扩展/.test(extensionRow),
  { extensionRow },
);

console.log("[3] CLAUDE.md 的扩展行指向作者手册");
check("★ 指向 docs/extensions/authoring-guide.md", extensionRow.includes("docs/extensions/authoring-guide.md"), {
  extensionRow,
});

console.log("[4] compat 文档顶部有边界声明");
{
  const compat = read("../../docs/planning/extension-vscode-compat.md");
  const head = compat.slice(0, 4000);
  check("★ 含「L1 原型」或「不是已交付的扩展宿主」", /L1 原型|不是已交付的扩展宿主/.test(head));
  check("★ §3 顶部指向 §6.2", /§6\.2/.test(compat));
}

console.log("[5] 旧 L1 bridge 已彻底下线（不再有第二条 VSIX 路径）");
{
  // ⚠️ 这一节原来钉的是「`VscodeL1Bridge` 在 src/ 内只被 IPC handler 引用一次」。
  // 那个断言的前提是 L1 仍是一条产品路径。**2026-10-27 起 L1 被整体删除**
  // （用户裁决：只要一个扩展系统 = Theia 持久宿主），所以原意翻转成：
  // **它不该再以任何形式存在**。
  //
  // 用文件系统遍历而不是 `git grep` —— `git grep` 只搜已跟踪文件，
  // 有人新建一个未跟踪的同名文件时它看不见。
  const srcRoot = resolve(process.cwd(), "src");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) continue;
      const text = readFileSync(full, "utf8");
      if (/VscodeL1Bridge|readMinimalVsix/.test(text)) hits.push(full);
    }
  };
  walk(srcRoot);
  check("★ src/ 内不再引用 VscodeL1Bridge / readMinimalVsix（L1 已删除）", hits.length === 0, { hits });

  // 文件本身也必须不在 —— 只删引用而留文件，下一个人会以为它还能用。
  let defExists = true;
  try { readFileSync(resolve(process.cwd(), "src/main/modules/vscodeL1Bridge.ts"), "utf8"); }
  catch { defExists = false; }
  check("★ src/main/modules/vscodeL1Bridge.ts 文件本身已删除", !defExists);

  // scripts/ 下同样不该再有引用它的套件（那些套件随 L1 一起删了）。
  const scriptsRoot = resolve(process.cwd(), "scripts");
  const scriptHits: string[] = [];
  const walkScripts = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walkScripts(full); continue; }
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) continue;
      const text = readFileSync(full, "utf8");
      if (/VscodeL1Bridge|readMinimalVsix/.test(text)) scriptHits.push(full);
    }
  };
  walkScripts(scriptsRoot);
  // 排除本套件自己 —— 它作为判据的一部分写着这两个名字。
  const self = resolve(process.cwd(), "scripts/extension-honesty-smoke/main.ts");
  const otherScripts = scriptHits.filter((p) => p !== self);
  check("★ scripts/ 内也没有别的套件引用它（vsix-* 套件已随 L1 删除）", otherScripts.length === 0, { otherScripts });
}

console.log("[6] 作者手册里的 `package.json` 示例能被真解析器读，且是 VS Code 的形状");
{
  // ⚠️ 这一节原来用 `ModuleManifestSchema` 验手册里的 JSON。那个 schema 随 ModuleHost
  // 一起删了。守的**意图**没变：**手册里的示例必须是能真的装进去的东西，不是纸上画的。**
  //
  // 现在唯一的扩展形态是 VS Code 扩展，所以判据换成：
  // 手册里那段 `package.json` 必须能被 `JSON.parse`，且带 VS Code 清单的必需字段。
  const guide = read("../../docs/extensions/authoring-guide.md");
  const m = /```json\n([\s\S]*?)```/.exec(guide);
  check("★ 手册里有 json 代码块（示例不是纯文字描述）", m !== null);
  if (m) {
    let parsed: unknown = null;
    let parseError: unknown = null;
    try {
      parsed = JSON.parse(m[1]!);
    } catch (e) {
      parseError = String(e);
    }
    check("★ 代码块是合法 JSON", parseError === null, { parseError });
    if (parseError === null && parsed && typeof parsed === "object") {
      const pkg = parsed as Record<string, unknown>;
      // VS Code 扩展清单的最小形状：name + version + main（或 engines.vscode）
      const hasIdentity = typeof pkg.name === "string" && typeof pkg.version === "string";
      const hasEntry = typeof pkg.main === "string" || (pkg.engines as Record<string, unknown> | undefined)?.vscode !== undefined;
      check("★ 示例带 VS Code 清单的必需字段（name + version + main/engines）",
        hasIdentity && hasEntry, { keys: Object.keys(pkg) });
    }
  }
  // 手册现在没有 json 代码块时，至少要求它给出的 `executeCommand` 形状是真的
  check("★ 手册写了 `mcode.*` 的返回形状（ok / result / needsApproval）",
    /ok:\s*true/.test(guide) && /needsApproval/.test(guide), {});
}

console.log("[7] 负控：唯一那条扩展安装路径真的存在（不是「文档说能装，代码里没入口」）");
{
  // 这一节原来守的是 `ipc/modules.ts` 里的 `IPC.MODULE_INSTALL` ——
  // 那是 ModuleHost 的安装入口，随用户裁决「只要一个扩展系统」在 2026-10-27 整体删除。
  //
  // 断言的**意图**必须留住：**别让「文档说能装」和「代码里没有入口」同时为真。**
  // 所以原意翻转成守新的唯一入口 —— `modules.theiaInstalled` 的 install op。
  //
  // ⚠️ 不变的那条纪律：**不能只查字符串在不在**。把 handle 注释掉，字符串还在，断言就绿。
  // 所以剥掉注释再查，并且查的是「真的注册了 handler」，不是「提到了这个名字」。
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const ipcCode = stripComments(read("src/main/ipc/theiaInstalled.ts"));
  // ⚠️ 正则要匹配**能力**不是匹配一种拼写。这里参数名叫 `ipc`（注入的 IpcMain），
  // 所以写法是 `ipc.handle(...)` 而不是 `ipcMain.handle(...)`。第一版写死 `ipcMain\.`
  // 于是对正确代码报红 —— 和「判据的名字比它检查的范围窄」是同一形态。
  check("★ theiaInstalled.ts 里真的注册了 IPC handler（剥掉注释后仍在）",
    /\b\w+\.handle\(\s*IPC\.MODULE_THEIA_INSTALLED/.test(ipcCode), {});
  check("★ handler 走的是持久安装（真 registry），不是预览",
    /registry\(options\)/.test(ipcCode), {});

  const rpc = read("../../packages/contracts/src/ipc/rpcMap.ts");
  check("★ RpcMap 里有 modules.theiaInstalled（唯一扩展安装入口在契约层可见）",
    rpc.includes('"modules.theiaInstalled"'), {});
  check("★ RpcMap 里**没有** modules.install（旧 ModuleHost 入口已下线）",
    !rpc.includes('"modules.install"'), {});

  // 反过来守一次：契约里写的那个 op 集合，产品代码得真的认。
  const schema = read("../../packages/contracts/src/ipc/modules.ts");
  for (const op of ["install", "start", "stop", "remove", "inspect"]) {
    check(`★ 契约接受 op="${op}"`, new RegExp(`["']${op}["']`).test(schema), {});
  }
}

console.log("[8] 作者手册不再教一条已经删掉的路");
{
  // ⚠️ 这条是**反向**的：它守的是「文档里不该再出现的东西」。
  // 2026-10-27 之前，本文档 §1–§5 整整 170 行在讲 ModuleHost 的 JSON 清单。
  // 那条路删掉之后，一份还在教它的手册比没有手册更坏 —— 读者会照着写一个装不进去的东西。
  const guide = read("../../docs/extensions/authoring-guide.md");
  check("★ 手册不再把「Mcode 原生扩展 / JSON 清单」写成一条可走的路",
    !/(Mcode\s*原生扩展)[^\n]{0,40}(完整|支持)/.test(guide), {});
  check("★ 手册明确写了 ModuleHost 那条路已下线",
    /已整体下线|这条路没有了|已下线/.test(guide), {});
  check("★ 手册把 VS Code 扩展写成唯一形态",
    /只有\*\*一套\*\*扩展系统|只有一套扩展系统/.test(guide), {});
  // 正控：手册必须还在讲 mcode.* 怎么调 —— 别为了删旧的把有用的也删了
  check("★ 手册仍在讲 mcode.* 能力桥", guide.includes("mcode.library.search") || guide.includes("mcode.<方法>"), {});
  check("★ 手册仍在讲权限与 agent 同源",
    /app_api_call/.test(guide) && /同源/.test(guide), {});
}

console.log(`\nextension-honesty-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
