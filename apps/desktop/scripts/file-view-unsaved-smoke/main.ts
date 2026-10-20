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
import { useSessionStore } from "@renderer/stores/sessionStore.js";
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
  const cap: { proceed?: () => void } = {};
  setFileOpenGuard((_next, proceed) => {
    guardCalls += 1;
    cap.proceed = proceed;
  });
  useFileViewStore.getState().open(libTarget("b.pdf"));
  check("★ open() 先调确认、**没有**立刻切换", guardCalls === 1 && refOf() === "a.pdf", { guardCalls, target: refOf() });
  // 用户确认 → proceed 才真正切。
  cap.proceed?.();
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
  const cap: { proceed?: () => void } = {};
  setFileOpenGuard((_next, proceed) => {
    guardCalls += 1;
    cap.proceed = proceed;
  });
  useFileViewStore.getState().close();
  check("★ close() 有脏位 → 先确认、预览仍在", guardCalls === 1 && refOf() === "a.pdf", { guardCalls, target: refOf() });
  cap.proceed?.();
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

console.log("\n【UI-012】重入打开相同目标与旧离开确认令牌");
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  useFileViewStore.getState().setDirty(true);
  const originalPreview = useFileViewStore.getState().target;
  useFileViewStore.getState().open(libTarget("a.pdf"));
  check("★★ reopening the same file cannot silently erase unsaved annotations", hasUnsavedChanges() === true);
  check("★★ reopening the same file must preserve target identity and skip PDF byte reload",
    useFileViewStore.getState().target === originalPreview,
    { original: originalPreview, now: useFileViewStore.getState().target });
}
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  useFileViewStore.getState().setDirty(true);
  const pending: Array<{ next: string | null; proceed: () => void }> = [];
  setFileOpenGuard((next, proceed) => {
    pending.push({ next: next?.source.kind === "library" ? next.source.ref : null, proceed });
  });
  useFileViewStore.getState().open(libTarget("b.pdf"));
  useFileViewStore.getState().open(libTarget("c.pdf"));
  pending[0]?.proceed();
  check("★★ older confirmation must not navigate over the newer pending request", refOf() === "a.pdf", { target: refOf(), pending: pending.length });
  pending[1]?.proceed();
  check("the newest confirmation still navigates to the intended file", refOf() === "c.pdf", refOf());
  useFileViewStore.getState().setDirty(true);
  pending[1]?.proceed();
  check("replayed confirmation cannot reset a document dirtied since navigation",
    refOf() === "c.pdf" && hasUnsavedChanges() === true,
    { target: refOf(), dirty: hasUnsavedChanges() });
}
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  useFileViewStore.getState().setDirty(true);
  let obsolete: (() => void) | undefined;
  setFileOpenGuard((_next, proceed) => { obsolete = proceed; });
  useFileViewStore.getState().close();
  setFileOpenGuard(null);
  // A separate, explicit discard has already cleared A's unsaved flag.
  // Otherwise the missing dialog must now fail closed, not navigate to C.
  useFileViewStore.getState().setDirty(false);
  useFileViewStore.getState().open(libTarget("c.pdf"));
  obsolete?.();
  check("★★ stale close confirmation cannot discard a newer preview", refOf() === "c.pdf", refOf());
}
console.log("\n【UI-012】旧 PDF 实例 cleanup 不得注销新保存回调");
{
  reset();
  const calls: string[] = [];
  const leaveA = setFileSaveHandler(async () => { calls.push("A"); return true; });
  const leaveB = setFileSaveHandler(async () => { calls.push("B"); return true; });
  if (typeof leaveA === "function") leaveA();
  const newResult = await saveCurrentPreview();
  check("★★ stale PDF cleanup keeps the latest preview's save handler",
    newResult === true && calls.join(",") === "B", { newResult, calls });
  if (typeof leaveB === "function") leaveB();
  const after = await saveCurrentPreview();
  check("unmount of active preview removes its own handler", after === false, after);
}

console.log("\n【UI-012】确认桥缺席时未保存改动必须 fail-closed");
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  useFileViewStore.getState().setDirty(true);
  // FileViewer may be between mounts, or its dialog registration may have
  // been torn down unexpectedly. Absence of UI approval cannot mean discard.
  setFileOpenGuard(null);
  useFileViewStore.getState().open(libTarget("b.pdf"));
  check("★★ missing confirmation handler may not silently switch away from dirty PDF",
    refOf() === "a.pdf" && hasUnsavedChanges(), { target: refOf(), dirty: hasUnsavedChanges() });
  useFileViewStore.getState().close();
  check("★★ missing confirmation handler may not silently close dirty PDF",
    refOf() === "a.pdf" && hasUnsavedChanges(), { target: refOf(), dirty: hasUnsavedChanges() });
  // The positive control matters: only unsaved exits fail closed, not first
  // opens or ordinary clean documents.
  useFileViewStore.getState().setDirty(false);
  useFileViewStore.getState().open(libTarget("b.pdf"));
  check("clean file can still switch without an active confirmation dialog", refOf() === "b.pdf", refOf());
  useFileViewStore.getState().close();
  check("clean file can still close without an active confirmation dialog",
    useFileViewStore.getState().target === null, useFileViewStore.getState().target);
}

console.log("\n【UI-012】旧 FileViewer cleanup 不可解绑新实例的确认桥");
{
  reset();
  useFileViewStore.getState().open(libTarget("a.pdf"));
  useFileViewStore.getState().setDirty(true);
  let oldCalls = 0, nextCalls = 0;
  const disposeOld = setFileOpenGuard(() => { oldCalls++; });
  const disposeNext = setFileOpenGuard(() => { nextCalls++; });
  // Before this fix FileViewer's cleanup was setFileOpenGuard(null), wiping
  // the newer B dialog. Replay exactly that old shape when no disposer exists.
  if (typeof disposeOld === "function") disposeOld();
  else setFileOpenGuard(null);
  useFileViewStore.getState().open(libTarget("b.pdf"));
  check("★★ late cleanup of viewer A must keep B's unsaved confirmation handler",
    nextCalls === 1 && oldCalls === 0 && refOf() === "a.pdf",
    { oldCalls, nextCalls, target: refOf() });
  if (typeof disposeNext === "function") disposeNext();
  useFileViewStore.getState().open(libTarget("c.pdf"));
  check("removing the active B guard must fail closed while the current PDF is dirty",
    nextCalls === 1 && refOf() === "a.pdf",
    { nextCalls, target: refOf() });
}

console.log("\n【UI-012/ARC-005】迟到的打开后侧栏展开不可覆盖后续导航");
{
  await new Promise<void>(resolve => setTimeout(resolve, 0)); // settle earlier opens
  reset();
  useSessionStore.setState({ rightOpen: false, rightPanelTab: "files", activeSessionId: null });
  useFileViewStore.getState().open(libTarget("abandoned.pdf"));
  useFileViewStore.getState().close(); // before dynamic sessionStore import resolves
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  check("★★ async right-pane activation from a file already closed must be ignored",
    useSessionStore.getState().rightOpen === false && useSessionStore.getState().rightPanelTab === "files",
    { rightOpen: useSessionStore.getState().rightOpen, tab: useSessionStore.getState().rightPanelTab });
}
{
  reset();
  useSessionStore.setState({ rightOpen: false, rightPanelTab: "files", activeSessionId: null });
  useFileViewStore.getState().open(libTarget("quick-A.pdf"));
  useFileViewStore.getState().open(libTarget("quick-B.pdf"));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  check("★★ stale A cannot open the right pane after B replaces its target",
    useSessionStore.getState().rightOpen === false && refOf() === "quick-B.pdf",
    { rightOpen: useSessionStore.getState().rightOpen, target: refOf() });
}
{
  reset();
  useSessionStore.setState({ rightOpen: false, rightPanelTab: "files", activeSessionId: null });
  useFileViewStore.getState().open(libTarget("live.pdf"));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  check("still-current initial file still activates normal right-pane workflow",
    useSessionStore.getState().rightOpen === true && useSessionStore.getState().rightPanelTab === "flow",
    { rightOpen: useSessionStore.getState().rightOpen, tab: useSessionStore.getState().rightPanelTab });
}

console.log(`\nfile-view-unsaved-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);

/* ── 小助手 ── */
function refOf(): string | null {
  const t = useFileViewStore.getState().target;
  if (!t || t.source.kind !== "library") return null;
  return t.source.ref;
}
