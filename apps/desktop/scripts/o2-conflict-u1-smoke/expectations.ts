/**
 * O2 —— 六格式「保存冲突」的**取证表**。
 *
 * ## 表里的值来自哪里
 *
 * 每一条都是**源码读出来的**，不是猜的（出处写在字段旁）：
 *
 *   | 格式 | 保存链 | 现有版本判据（截至 O2 开工时） |
 *   |---|---|---|
 *   | docs | preload `saveDocx` → `mcode:document-view:save` → `saveOpenedFile` | **有**（`documentViewHost.ts` 的乐观锁 + 租约） |
 *   | sheets | vendor preload → `workbook:save` → `sheets-main.ts` | **有**（`session.sha256` 比对，`errDiskChanged`） |
 *   | slides | 原生视图走 vendor `slides:save` 直写（`savePptxToFile`）；另有 `SlidesBridge` 的 CAS —— 但原生视图不经它 | **生产链没有**（T13 台账：`生产 native 路线保存走 vendor 直写、无 Mcode CAS`） |
 *   | pdf | vendor preload → `pdf:save` → `writePdfAtomically` | **没有**（`save-pdf.ts` 只读源、原子写，无版本比较） |
 *   | markdown | vendor preload → `markdown:save` → `writeTextAtomic` | **没有** |
 *   | html | vendor preload → `html:save` → `writeTextAtomic` | **没有** |
 *
 * ## 期望红 ≠ 测试失败
 *
 * 本套件的目标是**回答「哪几个会静默覆盖」**，不是「让六格全绿」。所以：
 *
 *  - `expectConflict: true`（docs/sheets）→ 4a/4b 必须绿，**红就是回归**；
 *  - `expectConflict: false`（slides/pdf/markdown/html）→ 4a/4b **预期红**，
 *    且红的理由必须**恰好**是「保存成功了、盘上被覆盖了」。这两点由
 *    `o2-outcome` 步骤分别断言（回包不是「别的失败」、盘上**逐字节**等于页面写的
 *    内容）—— 光「红」不够，红的原因必须是要证明的那个（CLAUDE.md 十六条）。
 *
 * 修好之后（另开卡）把这四个 `expectConflict` 翻成 `true`，本套件就是回归网。
 */
import type { EditorKind } from "./lib.js";

export interface KindExpectation {
  /** 生产链上有没有版本判据（只影响证据措辞与「修好后应翻 true」的提示）。 */
  expectConflict: boolean;
  /** 冲突回包里应看到的通道（证据里的 `channel` 字段要与它一致）。 */
  expectedChannel: string;
  /** 一句话：这个结论的源码出处。 */
  provenance: string;
}

export const EXPECTATIONS: Record<EditorKind, KindExpectation> = {
  docs: {
    expectConflict: true,
    expectedChannel: "mcode:document-view:save",
    provenance: "documentViewHost.ts 的 saveOpenedFile：withOsFileLease 内重算 fileContentVersion 与 expected 比较；不一致回 reason:\"conflict\" 且不写盘。",
  },
  sheets: {
    expectConflict: true,
    expectedChannel: "workbook:save",
    provenance: "sheets-main.ts 的 saveWorkbook 内联保存分支：currentSha !== session.sha256 → throw errDiskChanged（磁盘已改，请另存为）。",
  },
  slides: {
    expectConflict: false,
    expectedChannel: "slides:save",
    provenance: "原生视图的保存走 vendor slides-main.ts 的 slides:save → savePptxToFile 直写；slidesExecutor.ts 的 CAS 只在 Mcode SlidesBridge 路线上生效，原生视图不经它（T13 台账已记录）。",
  },
  pdf: {
    expectConflict: false,
    expectedChannel: "pdf:save",
    provenance: "pdf-main.ts 的 PDF_CHANNELS.save：校验路径授权后直接 savePdfToPath（读源→应用编辑→writePdfAtomically），没有打开时版本与盘上版本的比较。",
  },
  markdown: {
    expectConflict: false,
    expectedChannel: "markdown:save",
    provenance: "markdown-main.ts 的 MARKDOWN_CHANNELS.save：resolveSaveTarget 直接返回 savePathByWc 的路径，随后 writeTextAtomic；没有版本比较。",
  },
  html: {
    expectConflict: false,
    expectedChannel: "html:save",
    provenance: "html-main.ts 的 HTML_CHANNELS.save：resolveSaveTarget 直接返回 savePathByWc 的路径，随后 writeTextAtomic；没有版本比较。",
  },
};
