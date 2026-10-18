/**
 * 【MC-046 U1】真 Electron 下的设置覆盖层焦点所有权 —— 台账 remaining 明确写的
 * 「没有真 Electron/完整 AT U1」。
 *
 * ## 与 settings-layout-smoke 的分工
 *
 * `settings-layout-smoke` 用**真 Chrome**（CDP）验同一批焦点判据（真 App、真 Tab
 * 键、真 DOM）。本套件补它证明不了的一半：**Electron 的键盘事件链**（主进程
 * `webContents.sendInputEvent` → Chromium 原生焦点遍历 → `document.activeElement`）
 * 与 **Electron 的 inert/焦点清理时序**（Chromium 在 inert 应用的后续宏任务里
 * 把焦点清成 body —— useFocusTrap 文件头记录的那个时序，只有真 Electron 能验）。
 *
 * ## 判据（台账验收原文逐条）
 *
 *  1. 打开设置后 `document.activeElement` 在设置层内（不是 BODY）；
 *  2. 初始焦点是层内第一个可聚焦控件（标题栏「返回工作区」）；
 *  3. 后台工作区子树被 inert，且程序化 focus() 不接受；
 *  4. 层内首控件 Shift+Tab / 末控件 Tab 回绕，焦点不逃到层外（吐司栈是层外探针）；
 *  5. 连续 Tab 五次都留在层内；
 *  6. 关闭设置后焦点归还到打开前的工作区控件，inert 撤销；
 *  7. Escape 关闭（SettingsPage 自己的监听）后同样归还。
 *
 * ## 无头可观测性
 *
 * 隐藏窗口下 `sendInputEvent` 照样走 Chromium 的焦点遍历（真事件，不是页内
 * dispatchEvent）；判据只读 `document.activeElement` / DOM，不读像素。**没有伪造**：
 * 焦点没动就如实红。
 */
import { BrowserWindow, nativeTheme } from "electron";
import { writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
}

const FOCUSABLE_SEL = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable]:not([contenteditable=\"false\"])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export async function runSettingsFocusProbe(dir: string): Promise<void> {
  const evidence = join(dir, "checks.json");
  const checks: Check[] = [];
  let win: BrowserWindow | undefined;

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS SFE " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.log("FAIL SFE " + name + " — " + String(error));
      throw error;
    } finally {
      writeFileSync(evidence, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };
  async function until(predicate: () => Promise<boolean> | boolean, label: string, timeout = 20000): Promise<void> {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > timeout) throw new Error("Timed out: " + label);
      await delay(50);
    }
  }

  // 主进程侧：主题 handler（真 App 的 useTheme 会订阅 theme.changed）。
  const { ipcMain } = await import("electron");
  const effective = (): "dark" | "light" => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  ipcMain.handle("theme:get", () => ({ theme: "light", effective: effective() }));
  ipcMain.handle("theme:set", () => ({ theme: "light", effective: effective() }));

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      preload: join(dir, "bridge.cjs"),
    },
  });
  const wc = win.webContents;

  const js = async <T = unknown>(expression: string): Promise<T> =>
    (await wc.executeJavaScript(expression, true)) as T;

  await wc.loadFile(join(dir, "page.html"));
  await until(() => js<boolean>("window.__mounted === true"), "app mounted");
  await until(
    () => js<boolean>("document.querySelector('[data-testid=workspace-main]') !== null"),
    "workspace rendered",
  );
  await delay(500); // 设置页懒加载 + 面板落地

  /** 派发一次**真实** Tab 键（Electron 输入管线 → Chromium 焦点遍历）。 */
  const pressTab = async (shift: boolean): Promise<void> => {
    const modifiers: Array<"shift"> = shift ? ["shift"] : [];
    wc.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers });
    await delay(120);
  };

  /** 焦点现场：activeElement 是否在设置层里 / 是否在 inert 后台里。 */
  const focusWhere = async (): Promise<{
    insideRoot: boolean;
    inInert: boolean;
    tag: string | null;
    isFirst: boolean;
    isLast: boolean;
  }> =>
    js(`(() => {
      const a = document.activeElement;
      const root = document.querySelector(".settings-root");
      const list = root ? [...root.querySelectorAll(${JSON.stringify(FOCUSABLE_SEL)})].filter(
        (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
      ) : [];
      return {
        insideRoot: !!(root && a && root.contains(a)),
        inInert: !!(a && a.closest && a.closest("[inert]")),
        tag: a ? a.tagName : null,
        isFirst: !!(list.length && a === list[0]),
        isLast: !!(list.length && a === list[list.length - 1]),
      };
    })()`);

  // ── 夹具：打开前先在真实工作区里聚焦一个可见控件（焦点归还的锚点）。 ──
  const preFocused = await js<boolean>(`(() => {
    const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const list = [...document.querySelectorAll('[data-testid="workspace-main"] ${FOCUSABLE_SEL}')].filter(vis);
    if (!list.length) return false;
    window.__preFocusTarget = list[0];
    list[0].focus();
    return document.activeElement === list[0];
  })()`);
  await check("★ 前置：打开设置前能聚焦工作区可见控件", async () => {
    assert(preFocused === true, "no visible focusable control in workspace-main");
  });

  // 层外探针：吐司栈挂在根级、在设置层与 inert 壳之外。
  // 吐司是 React 订阅 store 后渲染的 —— push 与检查必须分两次执行（同一次
  // executeJavaScript 里 React 还没提交）。
  await js(`window.__toast.getState().push({ kind: "info", title: "MC-046 层外焦点探针", duration: 0 })`);
  await check("★ 前置：层外焦点探针（吐司按钮）渲染且可见", async () => {
    await until(
      () => js<boolean>(`(() => {
        const t = document.querySelector("[data-toast-id]");
        const b = t && t.querySelector("button");
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })()`),
      "outside-layer toast probe",
      8000,
    );
  });

  // ── 像用户那样打开设置（走 store 的同一个动作）。 ──
  await js(`window.__store.getState().setSettingsOpen(true)`);
  await until(() => js<boolean>('document.querySelector(".settings-root") !== null'), "settings overlay");
  await delay(500);

  await check("★ 打开设置后焦点立即落在设置层内（不是 BODY）", async () => {
    const f = await focusWhere();
    assert(f.insideRoot && f.tag !== "BODY", JSON.stringify(f));
  });

  await check("★ 初始焦点是层内第一个可聚焦控件（「返回工作区」按钮）", async () => {
    const f = await focusWhere();
    assert(f.isFirst, JSON.stringify(f));
    const text = await js<string>(
      `document.activeElement ? document.activeElement.textContent.slice(0, 40) : ""`,
    );
    assert(text.includes("返回工作区"), "first focusable is not the back button: " + text);
  });

  await check("★ 后台工作区子树被 inert", async () => {
    const inert = await js<boolean | null>(
      `(() => { const w = document.querySelector("[data-testid=workspace-main]"); return w ? !!w.closest("[inert]") : null; })()`,
    );
    assert(inert === true, JSON.stringify(inert));
  });

  await check("★ inert 真生效：后台控件即使被程序化聚焦也不接受", async () => {
    const r = await js<{ found: boolean; focusMoved: boolean }>(`(() => {
      const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const list = [...document.querySelectorAll('[data-testid="workspace-main"] ${FOCUSABLE_SEL}')].filter(vis);
      if (!list.length) return { found: false, focusMoved: false };
      const b = list[0];
      b.focus();
      return { found: true, focusMoved: document.activeElement === b };
    })()`);
    assert(r.found && !r.focusMoved, JSON.stringify(r));
  });

  // 回绕断言前重取层内首/尾。
  const ends = async (): Promise<{ first: string | null; last: string | null; count: number }> =>
    js(`(() => {
      const root = document.querySelector(".settings-root");
      const list = root ? [...root.querySelectorAll(${JSON.stringify(FOCUSABLE_SEL)})].filter(
        (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
      ) : [];
      return {
        first: list[0] ? list[0].textContent.slice(0, 20) : null,
        last: list.length ? list[list.length - 1].textContent.slice(0, 20) : null,
        count: list.length,
      };
    })()`);

  const fence = await ends();
  await check("★ 层内可聚焦元素足够做首尾回绕断言（夹具有效性）", async () => {
    assert(fence.count >= 3, JSON.stringify(fence));
  });

  await check("★ 层内首控件上 Shift+Tab 回绕到层内末控件（不逃到层外）", async () => {
    await js(`(() => {
      const root = document.querySelector(".settings-root");
      const list = [...root.querySelectorAll(${JSON.stringify(FOCUSABLE_SEL)})].filter(
        (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
      );
      list[0].focus();
    })()`);
    await pressTab(true);
    const f = await focusWhere();
    assert(f.insideRoot && f.isLast, JSON.stringify(f));
  });

  await check("★ 层内末控件上 Tab 回绕到层内首控件（不落进层外吐司）", async () => {
    await js(`(() => {
      const root = document.querySelector(".settings-root");
      const list = [...root.querySelectorAll(${JSON.stringify(FOCUSABLE_SEL)})].filter(
        (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
      );
      list[list.length - 1].focus();
    })()`);
    await pressTab(false);
    const f = await focusWhere();
    assert(f.insideRoot && f.isFirst, JSON.stringify(f));
  });

  await check("★ 自末控件起连续 Tab 五次，每一步焦点都在设置层内", async () => {
    await js(`(() => {
      const root = document.querySelector(".settings-root");
      const list = [...root.querySelectorAll(${JSON.stringify(FOCUSABLE_SEL)})].filter(
        (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
      );
      list[list.length - 1].focus();
    })()`);
    const trail: Array<{ step: number; inside: boolean; tag: string | null }> = [];
    for (let i = 0; i < 5; i++) {
      await pressTab(false);
      const f = await focusWhere();
      trail.push({ step: i + 1, inside: f.insideRoot, tag: f.tag });
    }
    assert(trail.every((t) => t.inside), JSON.stringify(trail));
  });

  // ── 关闭：走真实的标题栏「返回工作区」按钮（鼠标事件）。 ──
  await check("★ 关闭设置后焦点归还到打开前的工作区控件", async () => {
    const rect = await js<{ x: number; y: number } | null>(`(() => {
      const b = [...document.querySelectorAll(".settings-root button")].find((e) => e.textContent.includes("返回工作区"));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    assert(rect !== null, "back button not found");
    wc.sendInputEvent({ type: "mouseDown", x: rect!.x, y: rect!.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: rect!.x, y: rect!.y, button: "left", clickCount: 1 });
    await until(() => js<boolean>('document.querySelector(".settings-root") === null'), "settings closed");
    await delay(350);
    const restored = await js<boolean>("document.activeElement === window.__preFocusTarget");
    assert(restored === true, "focus was not restored to the pre-open workspace control");
  });

  await check("★ 关闭设置后工作区的 inert 被撤销", async () => {
    const cleared = await js<boolean>(
      `(() => { const w = document.querySelector("[data-testid=workspace-main]"); return w ? !w.closest("[inert]") : false; })()`,
    );
    assert(cleared === true, "workspace still inert after close");
    // 清掉层外焦点探针。
    await js("window.__toast.getState().clear()");
  });

  // ── Escape 关闭路径（SettingsPage 自己的监听）后同样归还焦点。 ──
  await check("★ Escape 关闭设置后焦点同样归还", async () => {
    await js(`(() => {
      const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const list = [...document.querySelectorAll('[data-testid="workspace-main"] ${FOCUSABLE_SEL}')].filter(vis);
      window.__preFocusTarget = list[0];
      list[0].focus();
    })()`);
    await js(`window.__store.getState().setSettingsOpen(true)`);
    await until(() => js<boolean>('document.querySelector(".settings-root") !== null'), "settings reopened");
    await delay(450);
    wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(() => js<boolean>('document.querySelector(".settings-root") === null'), "escape closed settings");
    await delay(400);
    const restored = await js<boolean>("document.activeElement === window.__preFocusTarget");
    assert(restored === true, "focus was not restored after Escape close");
  });

  win.destroy();
  win = undefined;
undefined}
