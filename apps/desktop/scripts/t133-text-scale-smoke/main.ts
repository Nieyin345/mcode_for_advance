/**
 * 【T133】`text-sm` → `text-body` 迁移的**零变化**与**按文件守恒**。
 *
 * ## 为什么这批是「验证流程」而不是「改观感」
 *
 * `text-sm` 是 Tailwind 默认档 **14px / 20px**，`text-body` 是 T121 立的 CDS
 * 七档里的 **14px / 20px** —— 两者数值完全一致（浏览器实测，见 T132/T133 回写）。
 *
 * 所以这一批**不应该有任何一个像素变化**。如果做完有人看出差别，
 * 说明映射判断错了，后面几批（`text-base` → `text-heading` 会收紧行高
 * 24→20）都不能照做。
 *
 * ## 判据为什么按文件而不是按总量
 *
 * T132 踩过一次：断言「总数 ≥ 7」而实际 53 处，删一处还剩 52，够不到下限。
 * **总量守恒允许内部搬移。** 所以这里逐文件记下限。
 *
 * 分母来自迁移时的实际扫描（90 处 / 31 文件），**不是估的**。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

const ROOT = process.cwd();
const RENDERER = resolve(ROOT, "src/renderer");

function resolve(root: string, p: string): string {
  return join(root, p);
}
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith(".tsx") ? [p] : [];
  });
}

/* 迁移的 31 个文件，每个的下限 = 当时换掉的处数。
 * 这些数字来自迁移脚本的输出，**不是估的** —— 下一个人如果看到「为什么
 * ProjectInitManager 是 16 而不是 15」，答案在这里。 */
const MINIMUMS: Record<string, number> = {
  "AppMobile.tsx": 1,
  "components/browser/AuthPromptDialog.tsx": 1,
  "components/browser/BrowserPanel.tsx": 1,
  "components/customUi/CustomTabView.tsx": 2,
  "components/customUi/CustomUiHost.tsx": 1,
  "components/ide/GenofficeDocumentPane.tsx": 1,
  "components/ide/GitDiffDialog.tsx": 1,
  "components/ide/SearchDialog.tsx": 1,
  "components/library/FileViewer.tsx": 1,
  "components/library/ItemDetail.tsx": 1,
  "components/library/ItemList.tsx": 2,
  "components/memory/MemoryExplorerPanel.tsx": 5,
  "components/memory/MemoryInjectionPreview.tsx": 2,
  "components/memory/MemoryTransferPanel.tsx": 5,
  "components/memory/ProjectInitManager.tsx": 16,
  "components/mobile/MobileFilesScreen.tsx": 1,
  "components/mobile/MobileGitScreen.tsx": 1,
  "components/mobile/MobileGitScreenParts.tsx": 1,
  "components/mobile/MobileSessionDrawer.tsx": 14,
  "components/mobile/MobileSettingsSheet.tsx": 1,
  "components/mobile/PairingScreen.tsx": 2,
  "components/mobile/RemoteConnectPanel.tsx": 7,
  "components/modules/CapabilityCatalogPanel.tsx": 1,
  "components/modules/ModuleContributions.tsx": 4,
  "components/modules/ModuleInstallConsentCard.tsx": 2,
  "components/modules/ModuleSurface.tsx": 7,
  "components/settings/EngineToolsPanel.tsx": 2,
  "components/settings/FrameworkPromptPanel.tsx": 2,
  "components/settings/workflows/EngineRuntimePanel.tsx": 2,
  "components/settings/workflows/PresetImportDialog.tsx": 1,
  "components/ui/dialog.tsx": 1,
};

/* 禁区：`text-sm` 应该还留着。 */
const RESERVED = ["components/chat/", "components/layout/"];

console.log("── 一、★ 按文件守：每个迁移文件仍有它的 text-body ──");

let missing = 0;
for (const [file, min] of Object.entries(MINIMUMS)) {
  const p = resolve(RENDERER, file);
  let n = 0;
  try {
    const src = readFileSync(p, "utf8");
    n = (src.match(/(?<![\w/-])text-body(?![\w/-])/g) || []).length;
  } catch {
    check(`${file} 仍存在`, false, { error: "ENOENT" });
    missing++;
    continue;
  }
  if (n < min) {
    check(`★ ${file} 仍有 ${min} 处 text-body（实际 ${n}）`, false, { n, min });
    missing++;
  }
}
check(`★ 31 个迁移文件全部达标（${31 - missing}/31，按文件不按总量）`, missing === 0, { missing });

console.log("\n── 二、禁区未被误改 ──");

/* `chat/` 与 `layout/` 不在本批范围（前者是 T132 的、后者 M 在做）。
 * 如果它们变成了 0 处 `text-sm`，说明有人把迁移做过头了。 */
let reservedCount = 0;
for (const f of walk(RENDERER)) {
  const rel = relative(RENDERER, f).split("\\").join("/");
  if (!RESERVED.some((d) => rel.startsWith(d))) continue;
  reservedCount += (readFileSync(f, "utf8").match(/(?<![\w/-])text-sm(?![\w/-])/g) || []).length;
}
check(`禁区（chat/ + layout/）仍保留 text-sm（${reservedCount} 处，没被迁移走）`, reservedCount > 0, { reservedCount });

console.log("\n── 三、★ 零变化：两档的配置数值必须相同 ──");

/* 这是这一批的全部意义。`text-sm` 是 Tailwind 默认（14/20），
 * `text-body` 是 tailwind.config.js 里的 `["14px", { lineHeight: "20px" }]`。
 *
 * ⚠️ 这条**只能验配置**，不能验渲染 —— 前者是源码，后者要真 Electron。
 * 回写里说清了这一点。 */
const tw = readFileSync(resolve(ROOT, "tailwind.config.js"), "utf8");
const bodyM = /body:\s*\[\s*"(\d+)px"\s*,\s*\{\s*lineHeight:\s*"(\d+)px"\s*\}\s*\]/.exec(tw);
check("tailwind config 里 body = 14px / 20px（= Tailwind 默认 text-sm）",
  bodyM?.[1] === "14" && bodyM?.[2] === "20", { found: bodyM?.[0] ?? "(未找到)" });

console.log("\n── 四、负控：把 text-body 换回 text-sm 会被抓到 ──");

/* 这一节守的是 §一 的方向：如果有人把某处改回 text-sm，
 * 那个文件的 text-body 计数会掉下去 —— §一 会红。
 * 这里额外直接断言「迁移文件里不再有裸 text-sm」，这样连改回一处都能看见。 */
const regressions: string[] = [];
for (const file of Object.keys(MINIMUMS)) {
  try {
    const src = readFileSync(resolve(RENDERER, file), "utf8");
    const n = (src.match(/(?<![\w/-])text-sm(?![\w/-])/g) || []).length;
    if (n > 0) regressions.push(`${file}: ${n}`);
  } catch { /* §一 已报 */ }
}
check("负控：迁移文件里不再有裸 text-sm", regressions.length === 0, regressions);

console.log(`\nt133-text-scale-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
