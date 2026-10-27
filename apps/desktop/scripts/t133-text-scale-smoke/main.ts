/**
 * 【T133】第 2 批：`text-xs` → `text-code` 的**零变化**与**按文件守恒**。
 *
 * ## 为什么这一批也是「验证流程」
 *
 * `text-xs` 是 Tailwind 默认 **12px / 16px**，`text-code` 是 CDS 七档里的
 * **12px / 16px** —— 数值完全一致（浏览器实测，见回写）。
 *
 * 90 处 / 31 文件的第 1 批（`text-sm` → `text-body`）已经证明了这个流程可行。
 * 本批是 **251 处 / 73 文件的同一手法**，规模大 2.8 倍。
 *
 * ## 判据为什么按文件
 *
 * T132 的教训：断言「总量 ≥ N」时，删一处还剩 N-1 也够，抓不到。
 * **总量守恒允许内部搬移。** 所以逐文件记下限，数字来自迁移时的实际替换输出。
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
const RENDERER = join(ROOT, "src/renderer");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith(".tsx") ? [p] : [];
  });
}

/* 迁移的 73 个文件，每个的下限 = 当时换掉的处数（迁移脚本的实际输出）。 */
const MINIMUMS: Record<string, number> = {
  "AppMobile.tsx": 1,
  "components/browser/AuthPromptDialog.tsx": 1,
  "components/browser/BrowserToolbar.tsx": 4,
  "components/customUi/CustomSlotHosts.tsx": 1,
  "components/customUi/CustomTabView.tsx": 3,
  "components/customUi/CustomUiHost.tsx": 1,
  "components/ide/FilesPanel.tsx": 1,
  "components/ide/GenofficeDocumentPane.tsx": 3,
  "components/ide/GitRepoCard.tsx": 1,
  "components/ide/GitRepoCardParts.tsx": 1,
  "components/ide/MarkdownEditorPane.tsx": 1,
  "components/ide/OpenTabsBar.tsx": 1,
  "components/ide/TaskListPanel.tsx": 1,
  "components/ide/TerminalCommandsMenu.tsx": 1,
  "components/ide/TerminalPanel.tsx": 1,
  "components/ide/WorktreeManagerPanel.tsx": 5,
  "components/library/CollectionContextMenu.tsx": 1,
  "components/library/FilePreview.tsx": 6,
  "components/library/FileViewer.tsx": 7,
  "components/library/ItemDetail.tsx": 6,
  "components/library/ItemList.tsx": 6,
  "components/library/LibraryItemContextMenu.tsx": 1,
  "components/library/LibrarySection.tsx": 1,
  "components/library/LibrarySectionParts.tsx": 1,
  "components/library/MarkdownPreviewPane.tsx": 2,
  "components/library/PdfPreviewImpl.tsx": 2,
  "components/memory/MemoryExplorerPanel.tsx": 1,
  "components/memory/MemoryInjectionPreview.tsx": 1,
  "components/memory/MemoryTransferPanel.tsx": 7,
  "components/memory/ProjectInitManager.tsx": 8,
  "components/mobile/MobileDomainPanel.tsx": 7,
  "components/mobile/MobileFileViewer.tsx": 5,
  "components/mobile/MobileFilesScreen.tsx": 2,
  "components/mobile/MobileGitScreen.tsx": 14,
  "components/mobile/MobileGitScreenParts.tsx": 10,
  "components/mobile/MobileLoginCard.tsx": 1,
  "components/mobile/MobileSessionDrawer.tsx": 6,
  "components/mobile/MobileSettingsSheet.tsx": 9,
  "components/mobile/MobileViewerOverlay.tsx": 4,
  "components/mobile/PairingScreen.tsx": 6,
  "components/mobile/RemoteConnectPanel.tsx": 15,
  /* 【UI 重建 2026-10-27】原 `components/modules/` 的四个文件随 ModuleHost 一起
   * 删除（用户裁决：只要一个扩展系统 = Theia 宿主）。清单是**存量文件**的下限表，
   * 文件没了就没有下限可言 —— 删条目，不是放宽门槛。
   * 反过来说：删掉这四条会让总数从 73 掉到 69，所以下面的分母也要跟着改，
   * 否则「69/73」会被读成 4 处回归。 */
  "components/settings/AppearanceExtras.tsx": 1,
  "components/settings/CustomUiPanel.tsx": 4,
  "components/settings/CustomUiPanelParts.tsx": 10,
  "components/settings/DataRootPanel.tsx": 1,
  "components/settings/EngineToolsPanel.tsx": 4,
  "components/settings/FrameworkPromptPanel.tsx": 5,
  "components/settings/LibraryTypesPanel.tsx": 7,
  "components/settings/McpPanelParts.tsx": 2,
  "components/settings/NotificationsPanel.tsx": 1,
  "components/settings/PanelHtmlDialog.tsx": 1,
  "components/settings/RuntimePolicyPanel.tsx": 2,
  "components/settings/SettingsGitPanel.tsx": 1,
  "components/settings/SettingsTerminalPanel.tsx": 1,
  "components/settings/SkillsPanel.tsx": 1,
  "components/settings/WorktreeRootSetting.tsx": 1,
  "components/settings/workflows/CodeParamDialog.tsx": 1,
  "components/settings/workflows/EngineRuntimePanel.tsx": 1,
  "components/settings/workflows/PresetImportDialog.tsx": 1,
  "components/settings/workflows/WorkflowNativeEditorEntry.tsx": 2,
  "components/sidebar/Sidebar.tsx": 2,
  "components/ui/button.tsx": 1,
  "components/ui/cds/Segmented.tsx": 2,
  "components/ui/dialog.tsx": 1,
  "components/ui/image-preview.tsx": 1,
  "components/ui/input.tsx": 1,
  "components/ui/native-controls.tsx": 1,
  "components/ui/select.tsx": 2,
  "components/ui/textarea.tsx": 1,
};

/* 禁区：`text-xs` 应该还留着。chat/ 是 T132 的范围，layout/ 是 M 的。 */
const RESERVED = ["components/chat/", "components/layout/"];

console.log("── 一、★ 按文件守：每个迁移文件仍有它的 text-code ──");

let missing = 0;
for (const [file, min] of Object.entries(MINIMUMS)) {
  let n = 0;
  try {
    const src = readFileSync(join(RENDERER, file), "utf8");
    n = (src.match(/(?<![\w/-])text-code(?![\w/-])/g) || []).length;
  } catch {
    check(`${file} 仍存在`, false, { error: "ENOENT" });
    missing++;
    continue;
  }
  if (n < min) {
    check(`★ ${file} 仍有 ${min} 处 text-code（实际 ${n}）`, false, { n, min });
    missing++;
  }
}
check(`★ ${Object.keys(MINIMUMS).length} 个迁移文件全部达标（${Object.keys(MINIMUMS).length - missing}/${Object.keys(MINIMUMS).length}，按文件不按总量）`, missing === 0, { missing });

console.log("── 二、禁区未被误改 ──");

let reservedCount = 0;
for (const f of walk(RENDERER)) {
  const rel = relative(RENDERER, f).split("\\").join("/");
  if (!RESERVED.some((d) => rel.startsWith(d))) continue;
  reservedCount += (readFileSync(f, "utf8").match(/(?<![\w/-])text-xs(?![\w/-])/g) || []).length;
}
check(`禁区（chat/ + layout/）仍保留 text-xs（${reservedCount} 处）`, reservedCount > 0, { reservedCount });

console.log("── 三、★ code 档的字号/行高 ──");

const tw = readFileSync(join(ROOT, "tailwind.config.js"), "utf8");
/* 【UI 重建 2026-10-27】**这条断言的语义变了，不只是数字变了。**
 *
 * 原来它守的是「`code` 与 Tailwind 默认 `text-xs`（12/16）完全相同，
 * 所以这批迁移零视觉变化」——那是一个**过渡期的安全前提**。
 *
 * 现在 `code` 是 Claude 的 caption 档（11.29px = 12 × 16/17 rem-scale），
 * 与 `text-xs` **不再相同**。所以：
 *   1. 断言改钉「code 档与 Claude caption 档一致」；
 *   2. 另外单列一条，明确「零视觉变化」这个前提**已解除**——
 *      否则下一个人会以为迁移仍然是无风险的。 */
const codeM = /code:\s*\[\s*"([\d.]+)px"\s*,\s*\{\s*lineHeight:\s*"([\d.]+)px"\s*\}\s*\]/.exec(tw);
check("tailwind config 里 code ≈ 11.29px / 16px（Claude caption 档 = 12 × 16/17）",
  codeM !== null && Math.abs(parseFloat(codeM[1]!) - 11.29) < 0.02 && parseFloat(codeM[2]!) === 16,
  { found: codeM?.[0] ?? "(未找到)" });

const bodyM = /body:\s*\[\s*"([\d.]+)px"\s*,\s*\{\s*lineHeight:\s*"([\d.]+)px"\s*\}\s*\]/.exec(tw);
check("tailwind config 里 body = 12.24px / 18.82px（Claude --cds-font-size-body / --cds-leading-body）",
  bodyM !== null && Math.abs(parseFloat(bodyM[1]!) - 12.24) < 0.02 && Math.abs(parseFloat(bodyM[2]!) - 18.82) < 0.02,
  { found: bodyM?.[0] ?? "(未找到)" });

check("★ code 档与 Tailwind 默认 text-xs（12/16）已经不同 —— 「零视觉变化」前提已解除",
  codeM !== null && parseFloat(codeM[1]!) !== 12,
  { code: codeM?.[1], note: "迁移这批文件时视觉确实变了，别再按「零变化」验收" });

console.log("── 四、负控：迁移文件里不再有裸 text-xs ──");

const regressions: string[] = [];
for (const file of Object.keys(MINIMUMS)) {
  try {
    const src = readFileSync(join(RENDERER, file), "utf8");
    const n = (src.match(/(?<![\w/-])text-xs(?![\w/-])/g) || []).length;
    if (n > 0) regressions.push(`${file}: ${n}`);
  } catch { /* §一 已报 */ }
}
check("负控：迁移文件里不再有裸 text-xs", regressions.length === 0, regressions);

console.log(`
t133-text-scale-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
