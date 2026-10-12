/**
 * file-view-unsaved-smoke — 【UI-012】PDF 批注「有未保存改动就拦住离开」的 store 层契约。
 *
 * ## 盯的是什么
 *
 * `fileViewStore` 从前**只有一个 `target`**，`PdfPreviewImpl` 把「用户改过批注」记在一份
 * **私有 ref** 里 —— 而离开预览的每条路(左栏点另一个文件、命令面板打开文档、顶栏 × 关预览)
 * 都不看它。于是用户加/改/删批注后没点「保存批注」就切走，内存里那份改动**无声消失**。
 *
 * 修法：把「有未保存改动」抬进 store，并在 `open()` / `close()` 这个**唯一落点**上装闸 ——
 * 有脏位且装了离开确认(`setFileOpenGuard`)时，**先交给确认**，而不是直接 `set({target})`；
 * 确认回调里再调 `proceed()` 才真正切换。
 *
 * ## 判据
 *
 * 直接驱动 store(纯 zustand，不需要 React 渲染)：
 *   - 无脏位 → `open()` 直接切，不问；
 *   - 有脏位 + 装了 guard → `open()` **不切**，先调 guard；用户 `proceed()` 后才切；
 *   - `close()` 同理(有脏位时先问)；
 *   - 「保存我」回调登记后 `saveCurrentPreview()` 能调到它；
 *   - 切到**同一个**文件不触发确认(没有东西会丢)。
 *
 * Run: scripts/file-view-unsaved-smoke/run.sh
 */
import "./prelude.js";
import {
  useFileViewStore,
  setFileOpenGuard,
  setFileSaveHandler,
  saveCurrentPreview,
  hasUnsavedChanges,
  type FileViewTarget,
} from "@renderer/stores/fileViewStore.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const libTarget = (ref: string): FileViewTarget => ({ source: { kind: "library", ref }, name: ref });

function reset(): void {
  useFileViewStore.setState({ target: null, dirty: false });
  setFileOpenGuard(null);
  setFileSaveHandler(null);
}

console.log("\n【UI-012】无未保存改动 → 直接切换，不打扰");
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  check("无脏位 → 直接切到 a.pdf", refOf() === "a.pdf", useFileViewStore.getState().target);
}

console.log("\n【UI-012】有未保存改动 → 先确认，不静默切走");
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  useFileViewStore.getState().setDirty(true);
  check("脏位已登记", hasUnsavedChanges() === true);
  let guardCalls = 0;
  let proceedRef: (() => void) | null = null;
  setFileOpenGuard((_next, proceed) => {
    guardCalls += 1;
    proceedRef = proceed;
  });
  useFileViewStore.getState().open(libTarget("b.pdf"));
  check("★ open() 先调确认、**没有**立刻切换", guardCalls === 1 && refOf() === "a.pdf", { guardCalls, target: refOf() });
  // 用户确认 → proceed 才真正切。
  proceedRef?.();
  check("★ 确认后 proceed() 才切到 b.pdf", refOf() === "b.pdf", refOf());
  check("切换后脏位清掉(新文件从干净开始)", hasUnsavedChanges() === false);
}

console.log("\n【UI-012】切到同一个文件不触发确认");
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  useFileViewStore.getState().setDirty(true);
  let guardCalls = 0;
  setFileOpenGuard(() => {
    guardCalls += 1;
  });
  useFileViewStore.getState().open(libTarget("a.pdf"));
  check("★ 同一目标 → 不问确认", guardCalls === 0, guardCalls);
}

console.log("\n【UI-012】关预览(close)也受保护");
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  useFileViewStore.getState().setDirty(true);
  let guardCalls = 0;
  let proceedRef: (() => void) | null = null;
  setFileOpenGuard((_next, proceed) => {
    guardCalls += 1;
    proceedRef = proceed;
  });
  useFileViewStore.getState().close();
  check("★ close() 有脏位 → 先确认、预览仍在", guardCalls === 1 && refOf() === "a.pdf", { guardCalls, target: refOf() });
  proceedRef?.();
  check("★ 确认后 close 才生效(target=null)", useFileViewStore.getState().target === null, useFileViewStore.getState().target);
}

console.log("\n【UI-012】「保存我」回调登记与调用");
{
  reset();
  let saved = 0;
  setFileSaveHandler(async () => {
    saved += 1;
    return true;
  });
  const ok = await saveCurrentPreview();
  check("★ saveCurrentPreview 调到登记的保存回调并返回其结果", ok === true && saved === 1, { ok, saved });
  setFileSaveHandler(null);
  const none = await saveCurrentPreview();
  check("没有登记保存回调时返回 false(不假装保存成功)", none === false);
}

console.log(`\nfile-view-unsaved-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);

/* ── 小助手 ── */
function refOf(): string | null {
  const t = useFileViewStore.getState().target;
  if (!t || t.source.kind !== "library") return null;
  return t.source.ref;
}
