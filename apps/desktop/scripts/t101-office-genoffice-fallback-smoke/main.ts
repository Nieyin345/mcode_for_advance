/**
 * t101-office-genoffice-fallback-smoke —— 【T101】OnlyOffice 未配置时的第二条路。
 *
 * ## 它验的是哪一层（**名字要说清**）
 *
 * **`isGenofficeViewAvailableFor()` 这个纯判据的真身**（`fileEditorKinds.ts`，
 * 直接 import、直接执行），外加「按钮真的接在它上面」的接线断言。它**不验**：
 *
 *  - 原生视图能不能真的渲染出来（那要真 Electron，见 T101 回写区的风险声明）；
 *  - `notConfigured` 本身怎么判出来的（`onlyoffice.open` 的主进程侧）；
 *  - 点按钮之后 `GenofficeViewHostPane` 的表现（那是
 *    `document-view-renderer-smoke` 的地盘）。
 *
 * ## ⚠️ 为什么判据要抽成纯函数（这一版踩过的坑）
 *
 * 第一版把判据在套件里**抄了一份副本**再断言它 —— 于是我在 `FileEditor.tsx` 里
 * 把 `genofficeHostForFile !== undefined` 改成 `true &&`，**第 1–3 节 35 条全绿**，
 * 因为它验的是副本，不是源码。只有「源码一致性」那一条红了，而它红是因为正则
 * 抽不到（`true &&` 让匹配断了），**不是因为它发现了判据被改坏**。
 *
 * 这是 CLAUDE.md 第十五条（按名字搜是引用数）的第 N 次实证：**判据本身没人验。**
 * 修法不是把副本写得更像，是**让判据有一个能被直接 import 的落点**。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { genofficeAppForPath } from "@contracts/genofficeFileRoute";
import { isOnlyOfficeSupportedPath } from "@contracts/ipc";
import { isGenofficeViewAvailableFor } from "@renderer/components/ide/fileEditorKinds.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

const ALL = { pdf: true, markdown: true, html: true, sheets: true, slides: true, slidesNative: true } as const;

/**
 * 按真实路径跑真身：扩展名 → 路由 → 能力位，全链一次走完。
 *
 * ⚠️ **`hosts` 不能有默认值。** 第一版写的是 `hosts = ALL`，于是
 * `forPath("/w/a.xlsx", undefined)` 被默认参数**换成了全能力**，「能力报告缺席」
 * 那条断言验的根本不是缺席。这是本套第二次栽在「验的东西不是我以为的东西」上
 * （第一次见文件头）。要全能力请显式传 `ALL`。
 */
function forPath(filePath: string, hosts: Partial<Record<string, boolean>> | undefined): boolean {
  return isGenofficeViewAvailableFor({
    office: isOnlyOfficeSupportedPath(filePath),
    nativeViewReady: true,
    host: genofficeAppForPath(filePath),
    hosts,
  });
}

/* ================== 1. 三种 office 主格式都拿得到出口 ================== */
section("1. 三种 office 主格式都能拿到出口");
for (const f of ["/w/a.docx", "/w/a.xlsx", "/w/a.pptx"]) {
  check(`${f} 给出口`, forPath(f, ALL) === true);
}

/* ================== 2. 不该给出口的，一个都不给 ================== */
section("2. 不该给出口的情形");

// 2a. **本判据存在的首要理由**：OnlyOffice 认得比 GenOffice 多。
{
  const gap = ["/w/a.docm", "/w/a.dotx", "/w/a.xltx", "/w/a.pptm", "/w/a.potx"];
  for (const f of gap) {
    // 前提：这五个确实「OnlyOffice 认、GenOffice 不认」—— 否则这条断言没在验东西。
    check(`  [前提] ${f} 被 OnlyOffice 认`, isOnlyOfficeSupportedPath(f) === true);
    check(`  [前提] ${f} 无 GenOffice 路由`, genofficeAppForPath(f) === undefined, genofficeAppForPath(f));
    check(`★ ${f} 不给出口（给了就是死按钮）`, forPath(f, ALL) === false);
  }
}

// 2b. 能力位为 false。
check("★ sheets 能力位 false：不给出口", forPath("/w/a.xlsx", { ...ALL, sheets: false }) === false);
check("★ slides 两个能力位都 false：不给出口",
  forPath("/w/a.pptx", { ...ALL, slides: false, slidesNative: false }) === false);
check("★ 能力报告整体缺席：sheets/slides 都不给",
  forPath("/w/a.xlsx", undefined) === false && forPath("/w/a.pptx", undefined) === false);

// 2c. 前置不成立。
check("genoffice CLI 未就绪（nativeViewReady=false）：不给出口",
  isGenofficeViewAvailableFor({ office: true, nativeViewReady: false, host: "docs", hosts: ALL }) === false);
for (const f of ["/w/a.pdf", "/w/a.md", "/w/a.html"]) {
  check(`${f} 不是 office，不走这条判据`, forPath(f, ALL) === false, f);
}
check("完全没有 GenOffice 路由的文件不给出口", forPath("/w/a.zip", ALL) === false);

/* ================== 3. 正控：确实有「给出口」的形态 ================== */
// 没有这一节，上面全是 false 断言，判据改成恒 false 也全绿。
section("3. 正控（证明判据不是恒 false）");
check("★ 正控：docx 全能力时给出口", forPath("/w/a.docx", ALL) === true);
check("★ 正控：slides 只报旧执行器位也给", forPath("/w/a.pptx", { ...ALL, slides: true, slidesNative: false }) === true);
check("★ 正控：slides 只报原生视图位也给", forPath("/w/a.pptx", { ...ALL, slides: false, slidesNative: true }) === true);
check("★ 正控：docs 不需要 hosts 位（document.ts:453 它恒 true）",
  forPath("/w/a.docx", { sheets: false, slides: false, slidesNative: false }) === true);
check("★ 正控：三种 office 主格式的能力位互相独立",
  forPath("/w/a.xlsx", { ...ALL, slides: false, slidesNative: false }) === true &&
  forPath("/w/a.pptx", { ...ALL, sheets: false }) === true);

/* ================== 4. 按钮真的接在判据上 ================== */
section("4. 接线");
const REPO = process.cwd(); // run.sh 已 cd 到 apps/desktop
const FE = readFileSync(join(REPO, "src/renderer/components/ide/FileEditor.tsx"), "utf8");

check("★ FileEditor 用的是 isGenofficeViewAvailableFor（不是内联副本）",
  /const genofficeViewForOffice\s*=\s*isGenofficeViewAvailableFor\(\{/.test(FE));
check("FileEditor 把 office / nativeViewReady / host / hosts 四项都传进去",
  ["office,", "nativeViewReady,", "host: genofficeHostForFile,", "hosts: genoffice.data?.hosts,"]
    .every((n) => FE.includes(n)));
check("★ 判据传进面板时才画按钮（false → undefined，不画一个永远点不动的）",
  /onUseGenofficeView=\{\s*genofficeViewForOffice\s*\?\s*\(\)\s*=>\s*setViewMode\(filePath,\s*"genoffice-view"\)\s*:\s*undefined\s*\}/.test(FE));

const PANE = readFileSync(join(REPO, "src/renderer/components/ide/OnlyOfficeEditorPane.tsx"), "utf8");
check("★ 面板 undefined 时不画按钮",
  PANE.includes("onUseGenofficeView !== undefined &&") && PANE.includes('t("ide.office.useGenofficeView")'));
check("★ 面板的按钮调的是传进来的回调", /onClick=\{onUseGenofficeView\}/.test(PANE));
check("面板声明了 onChange 之外的第三个 prop（不破坏原有签名）",
  PANE.includes("onUseGenofficeView?: () => void;"));

/* ================== 5. i18n 两种语言都在 ================== */
section("5. i18n");
for (const lang of ["zh", "en"] as const) {
  const dict = readFileSync(join(REPO, `src/renderer/lib/i18n/${lang}/ide.ts`), "utf8");
  check(`${lang} 有 ide.office.useGenofficeView`, dict.includes('"ide.office.useGenofficeView"'));
  // 卡上判据 4：两条路都说清 —— ① 装上 DS（完整能力）② 用 GenOffice（开箱可用）。
  // 判「安装」这条主语，不是「设置」：用户第一次撞墙时的问题是「没装」。
  const line = dict.split("\n").find((l) => l.includes('"ide.office.notConfiguredDesc"')) ?? "";
  const mentionsInstall = lang === "zh"
    ? line.includes("装上它") || line.includes("安装")
    : line.toLowerCase().includes("install");
  check(`★ ${lang} notConfiguredDesc 两条路都说清（装 DS + 用 GenOffice）`,
    line.includes("GenOffice") && mentionsInstall, line.slice(0, 160));
}

/* ================== 结果 ================== */
console.log("");
if (failures.length > 0) {
  console.log(`t101-office-genoffice-fallback-smoke: ${passed} ok, ${failures.length} FAIL`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`t101-office-genoffice-fallback-smoke: ${passed}/${passed} 通过`);
