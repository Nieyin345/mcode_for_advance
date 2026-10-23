/**
 * T46 —— 审批卡的**真 Electron U1** 旅程。
 *
 * ## 为什么不是 E1 的重复
 *
 * `approval-keyboard-safety-smoke` 是隔离组件证据（真 React、真组件、真 CDP
 * 按键，但**没有 BrowserWindow**）。它覆盖不到、而本卡专门验的三件事：
 *
 *  1. **真窗口键盘**：`webContents.sendInputEvent` 走 Chromium 输入管线，
 *     不是 CDP `Input.dispatchKeyEvent`；
 *  2. **多窗口焦点**：另一个 BrowserWindow 抢焦点时审批卡不误决策；
 *  3. **`settingsOpen` 暂停**：设置面板打开时卡片不抢焦点、不决策。
 *
 * ## 对照组（总控的硬要求）
 *
 * 「全绿的 U1 也可能什么都没验」（T24 的 59/59 漏掉 T40 就是这么来的）。所以每条
 * 「不该发生」的断言都配一条**在同一页面、同一键盘驱动下**的「该发生」正控：
 *
 * | 场景 | 不该发生 | 同源的该发生（对照） |
 * |---|---|---|
 * | 焦点在卡片上按 Escape | — | 决策 = deny（正控） |
 * | 模态打开时后到的卡 | 焦点不进卡、Escape 不决策 | 关掉模态后同样操作 → 焦点进卡、Escape 拒绝 |
 * | `settingsOpen` | 焦点不进卡、Escape 不决策 | `settingsOpen=false` 后同样操作 → 拒绝 |
 * | `active=false`（后台会话） | 不抢焦点、不决策 | `active=true` → 抢焦点、决策 |
 * | 焦点在卡上按 Enter | 不产生决策 | Tab 到「允许」+ 延迟后 Enter → 决策 = allow |
 * | 另一窗口抢焦点 | 本窗口卡片不被误决策 | 回到本窗口 → Escape 仍能拒绝 |
 *
 * ## 窗口「看不见」
 *
 * U1 runner 建的宿主窗口是 `show:true, opacity:0, x/y:-10000`（屏幕外 + 全透明，
 * 用户看不见）。**为什么不能 `show:false`**：隐藏窗口的 `document.hasFocus()` 恒
 * false，而本卡要验的正是焦点语义。多窗口场景的第二个窗口用同样技巧。
 *
 * ## 变异
 *
 * `mutate-t46.mjs` 把 `ApprovalPrompt` 的 `hasTopmostForeignDialog(...)` 守卫撤掉 →
 * 模态/对照两条断言必须变红 → `cmp` 还原。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import type { BrowserWindow, WebContents } from "electron";

interface Probe {
  card: boolean;
  settingsOpen: boolean | null;
  modalOpen: boolean;
  active: { tag: string; id: string | null; role: string | null; inCard: boolean } | null;
  allowDisabled: boolean | null;
  decisions: Array<{ granted: boolean; always?: boolean; at: number }>;
  focusLog: string[];
}

interface T46Runtime {
  win: BrowserWindow;
  wc: WebContents;
  /** 第二个窗口（多窗口焦点场景）。 */
  other: BrowserWindow | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 页面探针（主进程执行 `<表达式>` 取回 JSON）。 */
async function probe(wc: WebContents): Promise<Probe> {
  return (await wc.executeJavaScript("labProbe()", true)) as Probe;
}
/** 主进程直接调页面探针接口。 */
async function call(wc: WebContents, expr: string): Promise<unknown> {
  return await wc.executeJavaScript(expr, true);
}
/** 自 `since` 以来落到过哪些元素（页面按时间戳切片）—— 「卡有没有抢过焦点」
 *  这类否定判据必须按场景切片，否则会把上一组留下的条目算进来。 */
async function focusedSince(wc: WebContents, since: number): Promise<string[]> {
  return (await wc.executeJavaScript(`labFocusedSince(${since})`, true)) as string[];
}
/** 等某个条件成立（有界）。 */
async function until<T>(fn: () => Promise<T | null | false | undefined>, timeoutMs: number, stepMs = 100): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

/** 真键盘：`sendInputEvent` 走 Chromium 输入管线（不是 CDP）。
 *  Enter 必须带 `char` 变体才会触发按钮的默认激活 —— 这是 E1 记录过的同一件事，
 *  这里用 Electron 的原生事件形状。 */
async function pressKey(wc: WebContents, key: "Escape" | "Enter" | "Tab", withChar: boolean): Promise<void> {
  if (withChar) {
    wc.sendInputEvent({ type: "keyDown", keyCode: key });
    wc.sendInputEvent({ type: "char", keyCode: key });
    wc.sendInputEvent({ type: "keyUp", keyCode: key });
  } else {
    wc.sendInputEvent({ type: "keyDown", keyCode: key });
    wc.sendInputEvent({ type: "keyUp", keyCode: key });
  }
  await sleep(120);
}

const journey = defineU1Journey({
  name: "t46-approval-card-u1",
  launch: {
    // 探针页面由 prebuild 打进 buildDir（`--prebuild=scripts/t46-approval-card-u1/prebuild.mjs`）。
    page: { file: "t46-approval.html" },
    window: true,
    size: { width: 1100, height: 820 },
    defaultTimeoutMs: 20_000,
    // 三档断言全开：dom（焦点/决策）、visual（截图）、sideEffect（无磁盘副作用）。
    assertions: { dom: true, visual: true, sideEffect: true },
    setup: async (ctx) => {
      if (ctx.win === null) throw Error("T46: 需要宿主窗口");
      const wc = ctx.win.webContents;
      const ready = await until(async () => (await wc.executeJavaScript("!!window.__mounted && typeof window.labProbe === 'function'", true)) === true, 20_000);
      if (!ready) throw Error("T46: 探针页面 20s 内未挂载（见 run-g*.log 的 RENDERER 行）");
      const runtime: T46Runtime = { win: ctx.win, wc, other: null };
      return {
        // 不指定 pageFromView：默认用宿主窗口自己的 webContents（这正是要验的「真窗口」）。
        runtime,
        dispose() {
          try { runtime.other?.destroy(); } catch { /* 已销毁 */ }
        },
      };
    },
  },
  steps: [
    // ═════════════ 0. 前置：页面就绪 + 窗口确实「用户看不见」 ═════════════
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      return {
        ok: !rt.win.isDestroyed() && !rt.wc.isDestroyed(),
        observed: {
          // 如实记录：可见性设置是 show:true + 屏幕外 + 全透明（不是 show:false，
          // 隐藏窗口的 document.hasFocus() 恒 false，本卡要验焦点语义）。
          winVisible: rt.win.isVisible(),
          opacity: rt.win.getOpacity(),
          bounds: rt.win.getBounds(),
          hasFocus: await rt.wc.executeJavaScript("document.hasFocus()", true),
        },
      };
    }, "window-facts", { assert: false }),

    // ═════════════ 1. 键盘：焦点在卡上，Enter 不批准、Escape 拒绝 ═════════════
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labMountApproval({ toolName: "Bash", input: { command: "echo t46" } })`);
      const p = await until(async () => {
        const q = await probe(rt.wc);
        return q.card && q.active?.inCard ? q : null;
      }, 8_000);
      return p
        ? { ok: true, observed: { active: p.active, card: p.card } }
        : { ok: false, observed: await probe(rt.wc), detail: "卡片挂载后焦点没有落在卡上" };
    }, "card-takes-focus-on-mount", { assert: true }),

    // 真窗口里的按键必须真的送达 —— 先证明「键盘通了」（否则下面两条「没有决策」
    // 全是空过）。用 Escape 作探针：焦点在卡上时它必定产生一条 deny。
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      const before = (await probe(rt.wc)).decisions.length;
      await pressKey(rt.wc, "Enter", false);
      const afterEnter = await probe(rt.wc);
      // Enter 落在 alertdialog 本身（tabIndex=-1，没有默认动作）→ 必须没有决策。
      const enterSafe = afterEnter.decisions.length === before;
      // 对照：同一条键盘路径发 Escape 必须真产生 deny —— 证明输入管线是通的，
      // 上一条的「没有决策」不是因为键盘根本没送达。
      await pressKey(rt.wc, "Escape", false);
      const afterEsc = await probe(rt.wc);
      const denied = afterEsc.decisions.length === before + 1 && afterEsc.decisions.at(-1)?.granted === false;
      return enterSafe && denied
        ? { ok: true, observed: { afterEnter: afterEnter.decisions, afterEsc: afterEsc.decisions.at(-1) } }
        : {
            ok: false,
            observed: { before, afterEnter: afterEnter.decisions, afterEsc: afterEsc.decisions },
            detail: enterSafe
              ? "Escape 没有产生拒绝 —— 真键盘没有送达（后面的「无决策」断言会空过）"
              : "焦点在卡片上时按 Enter 产生了决策（可能批准了）",
          };
    }, "enter-on-card-is-inert-escape-denies", { assert: true }),

    // 正控：Tab 到「允许」→ 等过 arming 延迟 → Enter 必须真的批准。
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labUnmount()`);
      await call(rt.wc, `labMountApproval({ toolName: "Bash", input: { command: "echo t46-allow" } })`);
      const armed = await until(async () => {
        const q = await probe(rt.wc);
        return q.card && q.allowDisabled === false ? q : null;
      }, 8_000);
      if (!armed) return { ok: false, observed: await probe(rt.wc), detail: "「允许」按钮在 8s 内没有从 disabled 变为可点" };
      // 真 Tab 走到「允许」，再真 Enter。Tab 用 sendInputEvent 的 keyDown/keyUp。
      const focusedButton = await until(async () => {
        const q = await rt.wc.executeJavaScript(`(() => {
          const card = document.querySelector('[role=alertdialog]');
          const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').trim().endsWith('允许'));
          if (!btn) return null;
          btn.focus();
          return document.activeElement === btn;
        })()`, true);
        return q === true ? q : null;
      }, 3_000);
      if (!focusedButton) return { ok: false, detail: "无法把焦点放到「允许」按钮上" };
      const before = (await probe(rt.wc)).decisions.length;
      await pressKey(rt.wc, "Enter", true);
      const after = await probe(rt.wc);
      const allowed = after.decisions.length === before + 1 && after.decisions.at(-1)?.granted === true;
      return allowed
        ? { ok: true, observed: { decision: after.decisions.at(-1), keyPath: "sendInputEvent keyDown+char+keyUp" } }
        : { ok: false, observed: { before, after: after.decisions }, detail: "焦点在「允许」+ 已武装后，真 Enter 没有产生批准（键盘激活路径不通，正控失效）" };
    }, "tab-to-allow-then-enter-approves", { assert: true }),

    // ═════════════ 2. 模态：后到的卡不得抢焦点；关掉模态后同操作必须生效 ═════════════
    //  ⚠️ 「卡是否抢过焦点」只能看**本场景期间**的焦点日志：`labDecisionTs` 记下
    //  开始时刻，日志里带时间戳，按它切片。用全量 `focusLog` 会把上一组（正常
    //  挂卡）留下的 `card:` 条目算进来 —— 那不是本场景抢的（第一次跑就踩了这个坑）。
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labUnmount()`);
      const startedAt = Date.now();
      await call(rt.wc, `labOpenModal()`);
      await sleep(250);
      // 模态先开、卡后到（生产时序：用户正开着设置/命令面板，请求到达）。
      await call(rt.wc, `labMountApproval({ toolName: "Bash", input: { command: "echo t46-modal" } })`);
      await sleep(600);
      const p = await probe(rt.wc);
      const windowLog = await focusedSince(rt.wc, startedAt);
      const didNotSteal = !p.active?.inCard && windowLog.filter((x) => x.startsWith("card:")).length === 0;
      // Esc 在模态 input 上：卡片不该决策（本场景开始时先清空决策日志）。
      const baseline = p.decisions.length;
      await pressKey(rt.wc, "Escape", false);
      const afterEsc = await probe(rt.wc);
      const noDecision = afterEsc.decisions.length === baseline;
      // 对照：关模态 + 重挂卡 → 同一条 Escape 必须产生**一条新的**拒绝。
      await call(rt.wc, `labCloseModal()`);
      await sleep(250);
      await call(rt.wc, `labUnmount()`);
      await call(rt.wc, `labMountApproval({ toolName: "Bash", input: { command: "echo t46-after-modal" } })`);
      const back = await until(async () => {
        const q = await probe(rt.wc);
        return q.card && q.active?.inCard ? q : null;
      }, 8_000);
      const beforeControl = (await probe(rt.wc)).decisions.length;
      await pressKey(rt.wc, "Escape", false);
      const afterControl = await probe(rt.wc);
      const controlDenied = afterControl.decisions.length === beforeControl + 1 &&
        afterControl.decisions.at(-1)?.granted === false;
      return didNotSteal && noDecision && back !== null && controlDenied
        ? { ok: true, observed: { modalActive: p.active, windowLog, control: afterControl.decisions.slice(-1) } }
        : {
            ok: false,
            observed: { active: p.active, windowLog, baseline, decisionsAfterEsc: afterEsc.decisions, back, beforeControl, control: afterControl.decisions },
            detail: !didNotSteal
              ? "模态已打开后到的卡把焦点抢走了（T6 修复的正是这条）"
              : !noDecision
                ? "模态打开时按 Escape 产生了决策"
                : "对照组失败：关掉模态后同一条 Escape 没有拒绝（说明上面的「无决策」可能是键盘没送达）",
          };
    }, "modal-open-later-card-yields-control-works", { assert: true }),

    // ═════════════ 3. settingsOpen：暂停提示；关掉后恢复 ═════════════
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labUnmount()`);
      await call(rt.wc, `labSetStore({ settingsOpen: true })`);
      const startedAt = Date.now();
      await call(rt.wc, `labMountApproval({ toolName: "Bash", input: { command: "echo t46-settings" } })`);
      await sleep(600);
      const paused = await probe(rt.wc);
      const windowLog = await focusedSince(rt.wc, startedAt);
      const noFocusWhileSettings = !paused.active?.inCard && windowLog.filter((x) => x.startsWith("card:")).length === 0;
      const baseline = paused.decisions.length;
      await pressKey(rt.wc, "Escape", false);
      const pausedAfterEsc = await probe(rt.wc);
      const noDecision = pausedAfterEsc.decisions.length === baseline;
      // 对照：settingsOpen=false（不重挂卡片 —— 证明是 store 驱动的暂停/恢复）。
      await call(rt.wc, `labSetStore({ settingsOpen: false })`);
      const resumed = await until(async () => {
        const q = await probe(rt.wc);
        return q.card && q.active?.inCard ? q : null;
      }, 5_000);
      const beforeControl = (await probe(rt.wc)).decisions.length;
      await pressKey(rt.wc, "Escape", false);
      const resumedAfterEsc = await probe(rt.wc);
      const controlDenied = resumedAfterEsc.decisions.length === beforeControl + 1 &&
        resumedAfterEsc.decisions.at(-1)?.granted === false;
      return noFocusWhileSettings && noDecision && resumed !== null && controlDenied
        ? { ok: true, observed: { paused: paused.active, settingsOpen: paused.settingsOpen, windowLog, control: resumedAfterEsc.decisions.slice(-1) } }
        : {
            ok: false,
            observed: { paused: paused.active, settingsOpen: paused.settingsOpen, windowLog, baseline, decisions: pausedAfterEsc.decisions, resumed, beforeControl, control: resumedAfterEsc.decisions },
            detail: !noFocusWhileSettings
              ? "settingsOpen 时卡片仍抢走了焦点"
              : !noDecision
                ? "settingsOpen 时 Escape 产生了决策"
                : "对照组失败：settingsOpen=false 后卡片没有恢复（焦点/决策都没回来）",
          };
    }, "settings-open-pauses-and-resuming-works", { assert: true }),

    // ═════════════ 4. active=false（后台会话）：不抢焦点、不决策；active=true 对照 ═════════════
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labUnmount()`);
      const startedAt = Date.now();
      await call(rt.wc, `labMountApproval({ active: false, toolName: "Bash", input: { command: "echo t46-background" } })`);
      await sleep(500);
      const bg = await probe(rt.wc);
      const windowLog = await focusedSince(rt.wc, startedAt);
      const noFocus = !bg.active?.inCard && windowLog.filter((x) => x.startsWith("card:")).length === 0;
      const baseline = bg.decisions.length;
      await pressKey(rt.wc, "Escape", false);
      const bgAfter = await probe(rt.wc);
      const noDecision = bgAfter.decisions.length === baseline;
      await call(rt.wc, `labUnmount()`);
      await call(rt.wc, `labMountApproval({ active: true, toolName: "Bash", input: { command: "echo t46-active" } })`);
      const fg = await until(async () => {
        const q = await probe(rt.wc);
        return q.card && q.active?.inCard ? q : null;
      }, 8_000);
      const beforeControl = (await probe(rt.wc)).decisions.length;
      await pressKey(rt.wc, "Escape", false);
      const fgAfter = await probe(rt.wc);
      const controlDenied = fgAfter.decisions.length === beforeControl + 1 &&
        fgAfter.decisions.at(-1)?.granted === false;
      return noFocus && noDecision && fg !== null && controlDenied
        ? { ok: true, observed: { background: bg.active, windowLog, control: fgAfter.decisions.slice(-1) } }
        : {
            ok: false,
            observed: { background: bg.active, windowLog, decisions: bgAfter.decisions, foreground: fg?.active ?? null, beforeControl, control: fgAfter.decisions },
            detail: "后台会话的审批卡不该抢焦点/决策；或前台对照没有恢复",
          };
    }, "inactive-session-is-inert-active-controls", { assert: true }),

    // ═════════════ 5. 多窗口：另一窗口抢焦点时不误决策；回来后仍能拒绝 ═════════════
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labUnmount()`);
      await call(rt.wc, `labMountApproval({ toolName: "Bash", input: { command: "echo t46-multiwindow" } })`);
      const ready = await until(async () => {
        const q = await probe(rt.wc);
        return q.card && q.active?.inCard ? q : null;
      }, 8_000);
      if (!ready) return { ok: false, observed: await probe(rt.wc), detail: "卡片未就绪" };
      // 第二个窗口：与宿主同一个「屏幕外 + 全透明」技巧（用户看不见）。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BrowserWindow } = require("electron") as typeof import("electron");
      const other = new BrowserWindow({
        width: 480, height: 320, show: true, opacity: 0, x: -10000, y: -10000,
        focusable: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      rt.other = other;
      await other.loadURL("data:text/html,<title>other window</title><body>other</body>");
      await sleep(300);
      // 抢焦点：另一个窗口成为前台。
      other.focus();
      await sleep(400);
      const otherFocused = other.isFocused();
      const mainHasFocus = rt.wc.executeJavaScript("document.hasFocus()", true);
      const baseline = (await probe(rt.wc)).decisions.length;
      const during = await probe(rt.wc);
      // 另一窗口在前台时，本窗口的卡片仍应存在且**没有新增**决策。
      const noDecision = during.decisions.length === baseline;
      // 回到本窗口：真键盘必须仍然能拒绝（对照）。
      rt.win.focus();
      rt.wc.focus();
      await sleep(300);
      const backFocus = await rt.wc.executeJavaScript("document.hasFocus()", true);
      await pressKey(rt.wc, "Escape", false);
      const after = await probe(rt.wc);
      const controlDenied = after.decisions.length === baseline + 1 && after.decisions.at(-1)?.granted === false;
      other.destroy();
      rt.other = null;
      return otherFocused && (await mainHasFocus) === false && noDecision && backFocus === true && controlDenied
        ? { ok: true, observed: { otherFocused, control: after.decisions, backFocus } }
        : {
            ok: false,
            observed: { otherFocused, mainHasFocus: await mainHasFocus, decisions: during.decisions, backFocus, control: after.decisions },
            detail: !otherFocused
              ? "第二个窗口没能成为前台（多窗口场景没造出来，本组断言会空过）"
              : !noDecision
                ? "另一窗口在前台时本窗口卡片产生了决策"
                : !backFocus
                  ? "回到本窗口后 document.hasFocus() 仍为 false（键盘对照组不成立）"
                  : "回到本窗口后 Escape 没有拒绝",
          };
    }, "multi-window-focus-no-false-decision", { assert: true }),

    // ═════════════ 6. IME：合成输入（isComposing / keyCode 229）不得拒绝 ═════════════
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labUnmount()`);
      await call(rt.wc, `labMountApproval({ toolName: "Bash", input: { command: "echo t46-ime" } })`);
      await until(async () => {
        const q = await probe(rt.wc);
        return q.card && q.active?.inCard ? q : null;
      }, 8_000);
      // 真窗口里用 CDP 之外的路径不可行（IME composition 属 CDP），这里直接派
      // DOM 合成事件 —— 它验的是**生产守卫**（`isComposing` / `keyCode 229`），
      // 与 E1 同一入口；真 IME（搜狗/微软拼音）仍为未做项。
      const imeResult = await rt.wc.executeJavaScript(`(() => {
        const card = document.querySelector('[role=alertdialog]');
        if (!card) return { ok: false, reason: '卡片不在' };
        const before = window.labProbe().decisions.length;
        const dispatch = (init) => card.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: 'Escape', bubbles: true, cancelable: true }, init)));
        dispatch({ isComposing: true });
        dispatch({ keyCode: 229 });
        const after = window.labProbe().decisions.length;
        return { ok: after === before, before, after };
      })()`, true) as { ok: boolean; before?: number; after?: number; reason?: string };
      // 对照：同一条 DOM 路径、普通 Escape 必须拒绝（证明合成事件路径本身有效）。
      const control = await rt.wc.executeJavaScript(`(() => {
        const card = document.querySelector('[role=alertdialog]');
        const before = window.labProbe().decisions.length;
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const after = window.labProbe().decisions.length;
        return { before, after, denied: after === before + 1 && window.labProbe().decisions.at(-1).granted === false };
      })()`, true) as { before: number; after: number; denied: boolean };
      return imeResult.ok && control.denied
        ? { ok: true, observed: { ime: imeResult, control } }
        : { ok: false, observed: { ime: imeResult, control }, detail: imeResult.ok ? "对照组失败：普通 Escape 没有拒绝" : "IME 合成按键产生了决策" };
    }, "ime-composition-does-not-deny", { assert: true }),

    // ═════════════ 7. 危险工具：无 always-allow，且「允许」永远不带 always ═════════════
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labUnmount()`);
      await call(rt.wc, `labMountApproval({ toolName: "mcode-app-danger:app_write_files", input: { paths: ["a.txt"] } })`);
      const armed = await until(async () => {
        const q = await probe(rt.wc);
        return q.card && q.allowDisabled === false ? q : null;
      }, 8_000);
      if (!armed) return { ok: false, observed: await probe(rt.wc), detail: "危险工具卡片未武装" };
      const shape = await rt.wc.executeJavaScript(`(() => {
        const card = document.querySelector('[role=alertdialog]');
        const boxes = card.querySelectorAll('input[type=checkbox]');
        const buttons = [...card.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
        return { checkboxes: boxes.length, hasAlwaysLabel: buttons.some((t) => t.includes('始终允许')), buttons };
      })()`, true) as { checkboxes: number; hasAlwaysLabel: boolean; buttons: string[] };
      // 点「允许」→ 决策必须不带 always（danger 不给常允）。
      const allow = await rt.wc.executeJavaScript(`(() => {
        const card = document.querySelector('[role=alertdialog]');
        const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').trim().endsWith('允许'));
        if (!btn) return { ok: false, reason: '没有允许按钮' };
        btn.click();
        const d = window.labProbe().decisions.at(-1);
        return { ok: !!d && d.granted === true && d.always === undefined, decision: d };
      })()`, true) as { ok: boolean; decision?: unknown; reason?: string };
      const noAlwaysUi = shape.checkboxes === 0 && shape.hasAlwaysLabel === false;
      return noAlwaysUi && allow.ok
        ? { ok: true, observed: { shape, decision: allow.decision } }
        : { ok: false, observed: { shape, allow }, detail: noAlwaysUi ? "危险工具「允许」带上了 always（绕过逐次审批）" : "危险工具卡仍显示 always-allow 控件" };
    }, "danger-tool-has-no-always-allow", { assert: true }),

    // ═════════════ 8. 收尾：拆卡 + 断言无未捕获异常 ═════════════
    step.run(async ({ runtime }) => {
      const rt = runtime as T46Runtime;
      await call(rt.wc, `labUnmount()`);
      await sleep(150);
      const p = await probe(rt.wc);
      return p.card === false
        ? { ok: true, observed: { finalDecisions: p.decisions.length } }
        : { ok: false, observed: p, detail: "卸载后卡片仍在 DOM 里" };
    }, "unmount-clean", { assert: true }),
  ],
});

export const journeys = [journey];
