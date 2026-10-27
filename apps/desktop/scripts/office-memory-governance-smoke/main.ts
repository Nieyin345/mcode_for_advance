/**
 * 【Office 深度集成】后台编辑器视图的**内存治理**判据。
 *
 * ## 为什么需要这一套
 *
 * O18 实测：六个 GenOffice 编辑器同时驻留约 **1.70 GiB**，绝大部分是各自的
 * renderer。而 `DocumentViewHost.hide()` 只把视图挪到屏幕外 —— Chromium 仍保留
 * 整页、仍在跑定时器。用户切过几个标签之后，前面那些编辑器全在后台满编常驻。
 *
 * 真正难的不是"释放内存"，而是在释放的同时**不丢数据、不让切回来变慢**。
 * 本套件钉住的正是这条线：
 *
 *   A. **判据本身**（`selectDormantViews`，纯函数）：
 *      脏的、未报告的、可见的、从未打开过文档的、太新的 —— 一条都不能被选中；
 *   B. **快照可恢复性**（`snapshotCanRestore`）：缺 filePath / URL 形态不对时，
 *      调用方拿到的必须是 null（→ 不回收），而不是一份"看起来能恢复"的空壳；
 *   C. **主进程接线**：`dormantSnapshot` 必须真的带上 filePath/bounds/session，
 *      `openInputFromDormant` 生成的入参必须与 `open()` 的契约逐字同形；
 *   D. **渲染端安全线**：当前激活的文档永不回收、一次只回收一个、关闭被拒时
 *      不谎报"已回收"；
 *   E. **重建回路**：面板发现"我的视图不见了"必须用**同一个 docId** 重建
 *      （`stableDocId(filePath)` 稳定），否则重建出来的是另一个视图身份。
 *
 * ## 边界（如实，每次运行都打印）
 *
 * - A/B 是纯函数，能给出确定的真假；C/D/E 是**源码形状**断言 —— 它们证明
 *   "这条路径写在那里"，**不证明运行时真的走了它**（那需要真 Electron + 内存采样，
 *   见 `office-perf-u1` 的 `six-editor-residency`）；
 * - 不测具体释放了多少 MiB：那是 O18 的测量口径，本套件不重复也不冒充。
 *
 * COVERAGE: 休眠判据（纯函数）+ 主进程快照接线 + 渲染端安全线的源码形状
 * NOT-COVERED: 真实释放量；真 Electron 下切回后的首帧耗时；脏文档的实际保护
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  selectDormantViews,
  snapshotCanRestore,
  DEFAULT_DORMANCY_POLICY,
  type DormancyCandidate,
  type DormantSnapshot,
} from "../../src/main/document/documentViewDormancy.js";

console.log("COVERAGE: dormancy predicate + snapshot wiring + renderer safety lines (source shape)");
console.log("NOT-COVERED: real MiB reclaimed; real Electron first-frame after reclaim; live dirty protection");

// 用 cwd 而不是 import.meta.url：本套件被 esbuild 打包到临时目录后执行，
// import.meta.url 指向 /tmp，往上拼会得到 C:/Users/<user>/apps/... 这种不存在的路径。
// run.sh 已经 cd 到 apps/desktop，所以 cwd 就是那个目录（仓库里其它读源码的套件同此口径）。
const REPO = resolve(process.cwd(), "../..");

let total = 0;
let fail = 0;
function ck(label: string, yes: boolean, detail?: unknown): void {
  total += 1;
  if (!yes) fail += 1;
  console.log((yes ? "PASS " : "FAIL ") + label + (yes || detail === undefined ? "" : " :: " + JSON.stringify(detail)));
}

const NOW = 1_000_000_000;
const base = (over: Partial<DormancyCandidate> = {}): DormancyCandidate => ({
  docId: "doc-1",
  visible: false,
  dirty: false,
  hiddenAt: NOW - DEFAULT_DORMANCY_POLICY.graceMs - 1,
  hasDocument: true,
  ...over,
});

// ── A. 判据：谁能被回收 ────────────────────────────────────────────────
ck("★ 干净 + 隐藏够久 + 有文档 ⇒ 可回收", selectDormantViews([base()], NOW).length === 1);

ck("★ 脏视图永不回收（销毁 = 丢未保存编辑）",
  selectDormantViews([base({ dirty: true })], NOW).length === 0);

ck("★ 未报告过脏状态（undefined）按脏处理，不回收",
  selectDormantViews([base({ dirty: undefined })], NOW).length === 0,
  "「没报过」不等于「干净」");

ck("可见的视图永不回收", selectDormantViews([base({ visible: true })], NOW).length === 0);

ck("从未隐藏过（hiddenAt=null）不回收", selectDormantViews([base({ hiddenAt: null })], NOW).length === 0);

ck("宽限期内的视图不回收（切标签来回看不该重新加载）",
  selectDormantViews([base({ hiddenAt: NOW - 1000 })], NOW).length === 0);

ck("刚好达到宽限期即可回收（边界含等号）",
  selectDormantViews([base({ hiddenAt: NOW - DEFAULT_DORMANCY_POLICY.graceMs })], NOW).length === 1);

ck("从未打开过文档的视图不回收（回收它没收益，却让打开变慢）",
  selectDormantViews([base({ hasDocument: false })], NOW).length === 0);

ck("一次最多回收 maxPerSweep 个（避免同时释放多个大堆）",
  selectDormantViews(
    Array.from({ length: 6 }, (_, i) => base({ docId: `d${i}`, hiddenAt: NOW - 200_000 - i })),
    NOW,
  ).length === DEFAULT_DORMANCY_POLICY.maxPerSweep);

ck("最久隐藏的先回收（用户最不可能切回去的）", (() => {
  const picked = selectDormantViews([
    base({ docId: "recent", hiddenAt: NOW - 100_000 }),
    base({ docId: "oldest", hiddenAt: NOW - 500_000 }),
    base({ docId: "middle", hiddenAt: NOW - 300_000 }),
  ], NOW);
  return picked.length === 2 && picked[0] === "oldest" && picked[1] === "middle";
})());

ck("空集合是正常结果（没有后台视图）", selectDormantViews([], NOW).length === 0);

// ── B. 快照可恢复性 ───────────────────────────────────────────────────
const snap = (over: Partial<DormantSnapshot> = {}): DormantSnapshot => ({
  docId: "doc-1",
  url: "genoffice-app://docs/index.html",
  editor: null,
  filePath: "/ws/a.docx",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  mcodeSessionId: "s1",
  dormantAt: NOW,
  hiddenAt: NOW - 200_000,
  ...over,
});

ck("完整快照可恢复", snapshotCanRestore(snap()) === true);
ck("★ 缺 filePath 不可恢复（不能凭空重建一份文档）",
  snapshotCanRestore(snap({ filePath: null })) === false);
ck("原厂视图的 URL 必须是 genoffice-app scheme",
  snapshotCanRestore(snap({ editor: "slides", url: "file:///whatever/index.html" })) === false);
ck("原厂视图 + 正确 scheme ⇒ 可恢复",
  snapshotCanRestore(snap({ editor: "slides", url: "genoffice-app://slides/index.html" })) === true);

// ── C. 主进程接线（源码形状）──────────────────────────────────────────
const hostSrc = readFileSync(join(REPO, "apps/desktop/src/main/document/documentViewHost.ts"), "utf8");
ck("宿主提供 dormancyCandidates()", hostSrc.includes("dormancyCandidates("));
ck("宿主提供 dormantSnapshot()", hostSrc.includes("dormantSnapshot("));
ck("宿主提供 openInputFromDormant()（重建走 open 的同一条入参）",
  hostSrc.includes("openInputFromDormant("));
ck("★ 快照带上 filePath（缺了就无法重建同一份文档）",
  /dormantSnapshot\([\s\S]{0,900}?filePath:\s*live\.openedFilePath/.test(hostSrc));
ck("★ 快照带上 bounds（重建要摆回同一个位置，否则会闪）",
  /dormantSnapshot\([\s\S]{0,900}?bounds:\s*\{\s*\.\.\.live\.bounds\s*\}/.test(hostSrc));
ck("hide() 记录隐藏时刻（宽限期的唯一来源）",
  /hide\(docId: string\)[\s\S]{0,600}?live\.hiddenAt = Date\.now\(\)/.test(hostSrc));
ck("show() 清掉隐藏时刻", /live\.visible = true;\s*\n\s*live\.hiddenAt = null;/.test(hostSrc));

const ipcSrc = readFileSync(join(REPO, "apps/desktop/src/main/ipc/documentView.ts"), "utf8");
ck("IPC 暴露 dormantList", ipcSrc.includes("DOCUMENT_VIEW_DORMANT_LIST"));
ck("★ dormantList 把「为什么没进候选」逐项计数（candidates 空≠没人，可能是判据全挡了）",
  ipcSrc.includes("notVisible") && ipcSrc.includes("dirtyOrUnknown") && ipcSrc.includes("tooRecent") && ipcSrc.includes("noDocument"));
ck("★ dormantList 不销毁任何东西（销毁仍走既有 close，不新开第二条通道）",
  !/onDormantList[\s\S]{0,1200}?host\.close\(/.test(ipcSrc));

// ── C2. 大文件提示：只提示，不拒绝 ─────────────────────────────────────
ck("★ 打开时按体积给出提示（不拒绝：大文件有时确实要打开）",
  /DOC_VIEW_LARGE_FILE_BYTES[\s\S]{0,600}?largeFileWarning\s*=/.test(hostSrc));
ck("阈值是常量且**不是**拒绝线（没有 return { ok: false } 紧跟着它）",
  /if \(sizeOfOpened !== null && sizeOfOpened >= DOC_VIEW_LARGE_FILE_BYTES\) \{[\s\S]{0,400}?log\.info/.test(hostSrc));
ck("提示随 list() 快照交给渲染端", /largeFileWarning: \{ \.\.\.live\.largeFileWarning \}/.test(hostSrc));

// ── D. 渲染端安全线 ───────────────────────────────────────────────────
const hookSrc = readFileSync(join(REPO, "apps/desktop/src/renderer/components/ide/useOfficeMemoryReclaim.ts"), "utf8");
ck("★ 当前激活的文档永不回收", hookSrc.includes("candidate.docId !== activeDocId"));
ck("★ 一次只回收一个（batch 会同时释放多个大堆）", hookSrc.includes("const victim = result.candidates.find("));
ck("★ 关闭被拒时不谎报已回收", /if \(closed\.ok\) latest\.current\.onReclaimed/.test(hookSrc));
ck("回收失败不影响编辑（全程吞异常）", /catch \{[\s\S]{0,200}?回收是尽力而为/.test(hookSrc));

const paneSrc = readFileSync(join(REPO, "apps/desktop/src/renderer/components/ide/GenofficeViewHostPane.tsx"), "utf8");
ck("★ 面板发现视图消失会用同一 docId 重建", /setRetryNonce\(\(n\) => n \+ 1\)/.test(paneSrc));
// 守行为：只有**真的在 list() 里见过这个视图**，它的消失才算"被回收"。
// 曾经这里用 `openedOnceRef`（open 的 Promise 是否 resolve），但 open 与首次
// list() 可能并行 —— 那时视图还没进表，会被误读成"被回收"并触发重建风暴
// （实测一次挂载打出 880 次 open）。现在用 `seenInListRef`，判据更准。
ck("★ 只在「视图真的出现过」之后才重建（否则会打断首次打开）",
  paneSrc.includes("seenInListRef.current"));
ck("大文件提示由面板渲染出来（用户真的看得到）", /data-office-large-file/.test(paneSrc));

const rightPanelSrc = readFileSync(join(REPO, "apps/desktop/src/renderer/components/layout/RightPanel.tsx"), "utf8");
ck("右栏启用回收，并把当前激活文档传进去",
  /useOfficeMemoryReclaim\(\{[\s\S]{0,200}?activeFilePath:\s*pinnedDoc/.test(rightPanelSrc));

// ── E. AI 代码不进宿主 bundle（懒加载）────────────────────────────────
console.log("\n── E. AI 面板按需加载（宿主模式下连 chunk 都不请求）──");
for (const app of ["docs", "sheets", "slides", "pdf", "markdown", "html"]) {
  const appPath = join(REPO, `genoffice/apps/${app}/src/renderer/App.tsx`);
  const shellPath = join(REPO, `genoffice/apps/${app}/src/renderer/ExcelShell.tsx`);
  const src = readFileSync(appPath, "utf8") + (() => {
    try { return readFileSync(shellPath, "utf8"); } catch { return ""; }
  })();
  const hasLazy = /lazy\(\(\) => import\('\.\/ai\/Ai(Panel|ChatPanel)'\)/.test(src);
  const hasStaticValueImport = /^import \{[^}]*\bAi(Panel|ChatPanel)\b[^}]*\} from '\.\/ai\/Ai(Panel|ChatPanel)'/m.test(src);
  ck(`${app}: AI 面板按需加载`, hasLazy);
  ck(`${app}: 没有静态 import 面板本体`, !hasStaticValueImport);
}

ck("GensparkMark 已拆成独立小文件（宿主工具栏用它，不该拖来整个面板）", (() => {
  for (const app of ["pdf", "markdown", "html"]) {
    const p = join(REPO, `genoffice/apps/${app}/src/renderer/ai/GensparkMark.tsx`);
    try { readFileSync(p, "utf8"); } catch { return false; }
  }
  return true;
})());

ck("sheets 的 scopeLabel 是纯函数文件（App 用它，不该拖来面板）", (() => {
  try {
    const s = readFileSync(join(REPO, "genoffice/apps/sheets/src/renderer/ai/scopeLabel.ts"), "utf8");
    return s.includes("export function scopeLabel") && !s.includes("useI18n(");
  } catch { return false; }
})());

console.log(`\noffice-memory-governance-smoke: ${total - fail}/${total}`);
if (fail > 0) process.exitCode = 1;
void assert;
