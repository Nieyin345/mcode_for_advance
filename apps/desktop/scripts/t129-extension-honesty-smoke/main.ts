/**
 * 【T129】扩展线的**文档诚实性**回归。
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
import { ModuleManifestSchema } from "@contracts/modules";

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

console.log("[5] VscodeL1Bridge 的调用范围（两个范围分开断言）");
{
  // 5a: src/ 内零调用方（排除定义文件自身）
  //
  // ⚠️ **必须用文件系统遍历，不能用 `git grep`** —— `git grep` 只搜**已跟踪**文件，
  // 而「有人刚加了一个 import、还没 git add」正是最该被抓到的时刻。变异 M6 就是这么漏的：
  // 新建一个未跟踪的探针文件，`git grep` 看不见它，套件仍然全绿。
  const srcRoot = resolve(process.cwd(), "src");
  const defFile = resolve(process.cwd(), "src/main/modules/vscodeL1Bridge.ts");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (full === defFile) continue;
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) continue;
      const text = readFileSync(full, "utf8");
      if (/VscodeL1Bridge|readMinimalVsix/.test(text)) hits.push(full);
    }
  };
  walk(srcRoot);
  check("★ src/ 内零调用方（含未跟踪文件；定义文件自身除外）", hits.length === 0, { hits });

  // 5b: scripts/ 内唯一命中 vscode-l1-smoke
  const scriptsRoot = resolve(process.cwd(), "scripts");
  const walkScriptsHits: string[] = [];
  const walkScripts = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walkScripts(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) continue;
      const text = readFileSync(full, "utf8");
      if (/VscodeL1Bridge|readMinimalVsix/.test(text)) walkScriptsHits.push(full);
    }
  };
  walkScripts(scriptsRoot);
  const expected = resolve(process.cwd(), "scripts/vscode-l1-smoke/main.ts");
  // ⚠️ **必须排除本套件自己** —— 本文件里就写着 `VscodeL1Bridge` 这几个字（作为判据的一部分），
  // 不排除的话它会把自己算成一个调用方。这是「按名字搜是引用数」的典型形态：
  // 名字出现在一个地方，不代表那里在用这个东西。
  const self = resolve(process.cwd(), "scripts/t129-extension-honesty-smoke/main.ts");
  const scriptHits = walkScriptsHits.filter((p) => p !== self);
  check(
    "★ scripts/ 内唯一引用是 vscode-l1-smoke/main.ts（排除本套件自身）",
    scriptHits.length === 1 && scriptHits[0] === expected,
    { scriptHits },
  );
}

console.log("[6] 作者手册里的清单 JSON 能被真 schema 解析");
{
  const guide = read("../../docs/extensions/authoring-guide.md");
  // 抽出第一个 ```json 代码块
  const m = /```json\n([\s\S]*?)```/.exec(guide);
  check("★ 手册里有 json 代码块", m !== null);
  if (m) {
    let parsed: unknown = null;
    let parseError: unknown = null;
    try {
      parsed = JSON.parse(m[1]!);
    } catch (e) {
      parseError = String(e);
    }
    check("★ 代码块是合法 JSON", parseError === null, { parseError });
    const r = ModuleManifestSchema.safeParse(parsed);
    check("★ 通过 ModuleManifestSchema（不是纸上示例）", r.success, {
      issues: r.success ? undefined : r.error.issues,
    });
    // 额外：手册声称它和预设同形，验一下确实是同一形状的关键字段
    if (r.success) {
      const a = r.data;
      check("★ 清单 id 带 . 或 -（schema 要求多段）", /[.-]/.test(a.id), { id: a.id });
      check("★ 带 program 的清单引用了至少一个 module.* 能力",
        a.program === undefined || a.contributions.some((c) => c.capability.startsWith("module.")),
        { capabilities: a.contributions.map((c) => c.capability) });
    }
  }
}

console.log("[7] 负控：modules.install 的 handler 仍然存在（且没被注释掉）");
{
  // 这条防「为了把文档改干净，顺手把实现删了」。
  //
  // ⚠️ **不能只查字符串 `IPC.MODULE_INSTALL` 在不在** —— 把它注释掉，字符串还在，
  // 断言就绿了。变异 M8 证明了这一点（这正是 CLAUDE.md 第八条的「删得干净才红」形态）。
  // 所以这里查的是**未被注释的调用行**：去掉注释后，那行 `ipcMain.handle(IPC.MODULE_INSTALL` 必须还在。
  const ipcRaw = read("src/main/ipc/modules.ts");
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const ipcCode = stripComments(ipcRaw);
  check(
    "★ registerModuleHandlers 里有生效的 MODULE_INSTALL handle（剥掉注释后仍在）",
    /ipcMain\.handle\(\s*IPC\.MODULE_INSTALL/.test(ipcCode),
    {},
  );
  // 再补一条：install 必须真的接到 ModuleHost，而不只是有个 handle 壳
  check("★ MODULE_INSTALL 的 handler 体里调用了 ModuleHost.install", /getModuleHost\(\)\)\.install/.test(ipcCode), {});
  const rpc = read("../../packages/contracts/src/ipc/rpcMap.ts");
  check("★ RpcMap 里有 modules.install", rpc.includes('"modules.install"'), {});
}

console.log(`\nt129-extension-honesty-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
