/**
 * chat-derived smoke — see run.sh. Simulates a streaming session the way the
 * store updates it (immutable: a changed message is a new object, untouched
 * ones keep identity) and checks results against the old naive derivations.
 */
import {
  buildBeforeMap, collectHistoryTexts, collectPlanBlocks, collectTurnFileBlocks, useShallowStable,
} from "../../src/renderer/components/chat/chatDerived.js";
import { render, resetHooks } from "./react-stub.js";
import type { Block, ChatMessage } from "../../src/renderer/stores/sessionStore.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

// ── the pre-change implementations, verbatim in spirit ──
function naiveBefore(messages: ChatMessage[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const msg of messages) for (const b of msg.blocks) if (b.kind === "turn-files") for (const f of b.files) m.set(f.filePath, f.before as string | null);
  return m;
}
const naivePlans = (messages: ChatMessage[]) => messages.flatMap((m) => m.blocks).filter((b) => b.kind === "plan");
function naiveHistory(messages: ChatMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.blocks) if (b.kind === "text" && b.text.trim().length > 0) { out.push(b.text); break; }
  }
  return out;
}

const B = (x: unknown) => x as Block;
let seq = 0;
const msg = (role: "user" | "assistant", blocks: Block[]): ChatMessage => ({ id: `m${seq++}`, role, blocks } as unknown as ChatMessage);
const text = (t: string) => B({ kind: "text", text: t });
const plan = (id: string) => B({ kind: "plan", planId: id, plan: `plan ${id}`, phase: "ready" });
const turnFiles = (id: string, files: [string, string | null][]) =>
  B({ kind: "turn-files", filesId: id, files: files.map(([filePath, before]) => ({ filePath, kind: "edit", adds: 1, dels: 0, before })) });

// A history: 200 turns, some with plans / turn-files / attachment-only users.
let messages: ChatMessage[] = [];
for (let i = 0; i < 200; i++) {
  messages.push(msg("user", i % 17 === 0 ? [B({ kind: "image", data: "x", mimeType: "image/png" })] : [text(i % 9 === 0 ? "   " : `question ${i}`), text("second")]));
  const blocks: Block[] = [text(`answer ${i}`)];
  if (i % 23 === 0) blocks.push(plan(`p${i}`));
  if (i % 11 === 0) blocks.push(turnFiles(`t${i}`, [[`f${i % 5}.ts`, `before ${i}`], [`g${i}.ts`, null]]));
  messages.push(msg("assistant", blocks));
}

console.log("A. correctness vs. the old derivations");
{
  const bm = buildBeforeMap(collectTurnFileBlocks(messages));
  const nb = naiveBefore(messages);
  check("beforeMap equal (size)", bm.size === nb.size, [bm.size, nb.size]);
  check("beforeMap equal (entries, later turns win)", [...nb].every(([k, v]) => bm.get(k) === v));
  const pl = collectPlanBlocks(messages), np = naivePlans(messages);
  check("planBlocks equal", pl.length === np.length && pl.every((b, i) => b === np[i]));
  const ht = collectHistoryTexts(messages), nh = naiveHistory(messages);
  check("historyTexts equal", JSON.stringify(ht) === JSON.stringify(nh), [ht.length, nh.length]);
}

console.log("B. identity across streaming deltas");
{
  const series = (derive: (m: ChatMessage[]) => unknown[], mutate: () => void, label: string, expectChange: boolean) => {
    resetHooks();
    const a = render(() => useShallowStable(derive(messages))).value;
    mutate();
    const b = render(() => useShallowStable(derive(messages)));
    check(`${label}: ${expectChange ? "changes identity" : "keeps identity"}`, expectChange ? b.value !== a : b.value === a);
    return b;
  };
  // Simulate a streaming turn: a new assistant message whose text grows.
  messages = [...messages, msg("user", [text("stream now")])];
  let tail = msg("assistant", [text("")]);
  messages = [...messages, tail];
  const delta = () => {
    tail = { ...tail, blocks: [text((tail.blocks[0] as { text: string }).text + "tok ")] } as ChatMessage;
    messages = [...messages.slice(0, -1), tail];
  };
  series(collectPlanBlocks, delta, "planBlocks on text delta", false);
  series((m) => collectTurnFileBlocks(m), delta, "turn-files blocks on text delta", false);
  series(collectHistoryTexts, delta, "historyTexts on assistant delta", false);
  series(collectPlanBlocks, () => { tail = { ...tail, blocks: [...tail.blocks, plan("live")] } as ChatMessage; messages = [...messages.slice(0, -1), tail]; }, "planBlocks when a plan block arrives", true);
  series((m) => collectTurnFileBlocks(m), () => { tail = { ...tail, blocks: [...tail.blocks, turnFiles("current", [["f1.ts", "live"]])] } as ChatMessage; messages = [...messages.slice(0, -1), tail]; }, "turn-files blocks when turn.files arrives", true);
  series(collectHistoryTexts, () => { messages = [...messages, msg("user", [text("next question")])]; }, "historyTexts when the user sends", true);
  const settle = series(collectPlanBlocks, delta, "planBlocks settles again after the change", false);
  check("a changed value costs at most one extra render pass", settle.passes <= 2, settle.passes);

  const bm = buildBeforeMap(collectTurnFileBlocks(messages));
  check("live turn-files overrides earlier before for the same path", bm.get("f1.ts") === "live");
}

console.log("C. per-message caching");
{
  // Same objects → cached result reused: mutate a block array in place (never
  // done by the store) and confirm the cache, not a rescan, answered.
  const m = msg("assistant", [plan("cached")]);
  const first = collectPlanBlocks([m]);
  (m.blocks as Block[]).push(plan("sneaky"));
  const second = collectPlanBlocks([m]);
  check("unchanged message object is not rescanned", second.length === 1 && second[0] === first[0]);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) { collectPlanBlocks(messages); collectTurnFileBlocks(messages); collectHistoryTexts(messages); }
  const per = (performance.now() - t0) / 200;
  console.log(`  (warm 3-way derivation over ${messages.length} messages: ${per.toFixed(3)}ms per flush)`);
  check("warm derivation is cheap (<2ms per flush for ~400 messages)", per < 2, per);
}

/**
 * 工作流步骤卡上的「引擎 · 模型」那行,不许把主进程的哨兵串 `"default"` 原样摊出来。
 *
 * `runner.ts` 落 `NodeExecutionRecord.model` 时写的是 `executionSession.model || "default"`,
 * 于是没显式选模型的节点,`block.model` 就是字面量 `"default"`。卡片从前直接
 * `block.model || "default"` 填进模板 `chatStream.workflowStep.engine` =「引擎 {provider} · 模型 {model}」
 * —— 中文界面上冒出一句「模型 default」,而 "default" 根本不是模型名。判据钉在**源码**上
 * (组件在无头下跑不出渲染结果):哨兵那一支必须交给 i18n 键,不许出现裸的 `"default"` 字面量。
 */
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/chat/WorkflowStepCard.tsx"), "utf8");
  // 去掉行注释,免得注释里提到的 "default" 造成假绿。
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("★ 步骤卡的模型哨兵走 i18n(不是裸 \"default\")", code.includes('t("chat.model.default")'));
  check("★ 不再有 `block.model || \"default\"` 那种原样摊出哨兵", !/block\.model\s*\|\|\s*"default"/.test(code));
  check("★ 真模型名仍然原样显示(不是把非哨兵也吞掉)", /block\.model === "default"\s*\?\s*t\("chat\.model\.default"\)\s*:\s*block\.model/.test(code));
}

/**
 * 撤销本轮文件改动(`claude.rewindTurn`)失败必须是**用户看得见**的失败。
 *
 * `TurnFilesCard.handleRewind` 是 `await rewindTurn(...)` 之后**无条件** `setDone(true)`
 * —— 卡上画出「已撤销 ✓」。而 store 的 `rewindTurn` 从前把 IPC rejection 吞成
 * `console.error`、照样 resolve,于是真正失败时用户看到"撤销成功"、文件一个字节没回滚
 * (破坏性动作,他不会再去看)。判据钉源码:store 必须**抛出**真错,卡片必须接住并
 * 报一句(toast)。
 */
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const store = strip(readFileSync(join(process.cwd(), "src/renderer/stores/sessionStore.ts"), "utf8"));
  const at = store.indexOf("rewindTurn: async");
  const body = store.slice(at, store.indexOf("\n  },", at));
  check("★ store 的 rewindTurn 失败会抛出(不再吞成 console.error)", at >= 0 && /console\.error\([^)]*rewindTurn failed[\s\S]{0,120}throw err;/.test(body), body.slice(-260));
  const card = strip(readFileSync(join(process.cwd(), "src/renderer/components/chat/TurnFilesCard.tsx"), "utf8"));
  const cAt = card.indexOf("const handleRewind");
  const cBody = card.slice(cAt, card.indexOf("\n  };", cAt));
  check("★ 撤销失败时卡片报出来(不再无条件画「已撤销 ✓」)", cAt >= 0 && /catch\s*\([^)]*\)\s*\{[\s\S]*?useToastStore[\s\S]*?push\(/.test(cBody) && cBody.includes("store.toast.rewindFailed"), cBody.slice(0, 300));
}

/**
 * `PlanViewer`(PlanViewer.tsx)编辑模式下的 Ctrl+S 必须**存的是当前草稿**。
 *
 * `@monaco-editor/react` 把 `onMount` 存进一个只读一次的 ref(`useRef(onMount)`,
 * 从不重赋),而键位是在 onMount 里 `addCommand` 注册的 —— 于是绑的永远是**进入编辑
 * 那一刻**的 `handleSave` 闭包,那时 `draft` 还是种子值(原计划文本)。用户敲完按
 * Ctrl+S,存进去的是**改之前**的文本,却照报「已保存」。(组件无头跑不出渲染结果,
 * 判据钉源码;`FileEditor` 的同一键位早用 `handleSaveRef` 兜住了这层。)
 *
 * 撤掉修复(键位回调改回直接 `void handleSave()`)时,第一条断言转红。
 */
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const v = strip(readFileSync(join(process.cwd(), "src/renderer/components/chat/PlanViewer.tsx"), "utf8"));
  check("★ PlanViewer 为 Ctrl+S 保留 live handleSave ref", /const\s+handleSaveRef\s*=\s*useRef\(handleSave\)/.test(v) && /handleSaveRef\.current\s*=\s*handleSave/.test(v));
  const mountAt = v.indexOf("const handleEditorMount");
  // 窗口取到 onMount 回调之后足够长的一段(addCommand 跨了多行)。
  const mountBody = v.slice(mountAt, mountAt + 500);
  check("★ Ctrl+S 键位读 ref(不再钉死在挂载那一刻的闭包)", mountAt >= 0 && /addCommand\([\s\S]*?handleSaveRef\.current\(\)/.test(mountBody));
  check("★ 键位回调不再直接调用闭包里的 handleSave()", mountAt >= 0 && !/addCommand\([\s\S]*?void\s+handleSave\(\)/.test(mountBody));
}

/* ── ModelDropdown:每个供应商子菜单的 Popup 都要带 `ref={subPopupRef}` ──
 *
 * `useSuppressBrowserView(open || hint !== null, [popupRef, subPopupRef, hintRef])` 只在
 * **测量到**的弹层矩形与内嵌浏览器舞台重叠时收起那个原生 WebContentsView。子菜单里的
 * Popup 没有这个 ref,量不到矩形 —— 打开供应商子菜单、而它恰好压住浏览器面板时,OS 级
 * 视图仍盖在上面,子菜单画在它底下、点不动。三段子菜单(Pi / Codex / 自定义端点)几乎是
 * 同一块代码抄了三遍,Codex 那一段**漂开了**(少了 ref)。判据钉源码:有多少个
 * `Menu.SubmenuRoot`,就得有多少个 `ref={subPopupRef}`。 */
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const md = strip(readFileSync(join(process.cwd(), "src/renderer/components/chat/ModelDropdown.tsx"), "utf8"));
  const submenus = (md.match(/<Menu\.SubmenuRoot/g) ?? []).length;
  const refs = (md.match(/ref=\{subPopupRef\}/g) ?? []).length;
  check("★ 每个 ModelDropdown 子菜单 Popup 都带 ref={subPopupRef}(浏览器视图抑制要量到它)", submenus > 0 && submenus === refs, { submenus, refs });
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);