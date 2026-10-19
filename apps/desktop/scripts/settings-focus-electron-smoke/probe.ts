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
    // 真实焦点事件需要窗口真的"有焦点"：隐藏窗口里 document.hasFocus()=false，
    // 浏览器不派发 focus/focusin —— base-ui 的 FocusGuard 回弹（依赖 React 合成
    // onFocus）因此不可观测。用 opacity:0 + 屏幕外位置：窗口存在、可聚焦、
    // 用户看不见，判据仍只读 DOM。
    show: true,
    opacity: 0,
    x: -10000,
    y: -10000,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      preload: join(dir, "bridge.cjs"),
    },
  });
  const wc = win.webContents;
  win.focus();

  const js = async <T = unknown>(expression: string): Promise<T> =>
    (await wc.executeJavaScript(expression, true)) as T;

  await wc.loadFile(join(dir, "page.html"));
  // 可观测性自检：隐藏窗口里 rAF 若被暂停，base-ui 的 FocusGuard 恢复（enqueueFocus
  // 走 rAF）就永远不会执行 —— 那不是产品缺陷，是观测环境问题。探针先测一下。
  const rafWorks = await wc.executeJavaScript(
    "new Promise((r) => { const t = setTimeout(() => r(false), 1500); requestAnimationFrame(() => { clearTimeout(t); r(true); }); })",
    true,
  );
  console.log("RAF AVAILABLE: " + String(rafWorks));
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

  // Visible-but-inert/aria-hidden descendants must NOT enter our Tab ring.
  // Otherwise pressing Tab from the last real setting tries to focus the
  // inert button (no-op/stuck) or sends focus to an a11y-hidden control.
  for (const mode of ["inert", "aria-hidden", "fieldset", "negative-tabindex", "negative-other"] as const) {
    await check("★ 设置焦点循环跳过 " + mode + " 子树，仍回绕首个控件", async () => {
      const prepared = await js<boolean>(`(() => {
        const root = document.querySelector(".settings-root");
        const list = [...root.querySelectorAll(${JSON.stringify(FOCUSABLE_SEL)})].filter(
          el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
        );
        const first = list[0], last = list[list.length - 1];
        const mode = "${mode}";
        const ignored = document.createElement(mode === "fieldset" ? "fieldset" : "div");
        ignored.setAttribute("data-sfe-ignored", "");
        if (mode === "inert") ignored.setAttribute("inert", "");
        if (mode === "aria-hidden") ignored.setAttribute("aria-hidden", "true");
        if (mode === "fieldset") ignored.setAttribute("disabled", "");
        const hiddenButton = document.createElement("button");
        hiddenButton.textContent = "unreachable inner button";
        if (mode === "negative-tabindex") hiddenButton.tabIndex = -1;
        if (mode === "negative-other") hiddenButton.tabIndex = -2;
        ignored.appendChild(hiddenButton);
        root.appendChild(ignored);
        window.__sfeTrapFirst = first;
        last.focus();
        return document.activeElement === last;
      })()`);
      await pressTab(false);
      const wrapped = await js<boolean>(`document.activeElement === window.__sfeTrapFirst`);
      await js(`document.querySelector("[data-sfe-ignored]")?.remove()`);
      assert(prepared && wrapped, "Tab must wrap to first real setting: " + JSON.stringify({ mode, prepared, wrapped }));
    });
  }

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

  // ══════════ 嵌套弹窗（base-ui Portal）的焦点让位 ══════════
  //
  // 场景：设置页「扩展」面板（CustomUiPanel）里有一条真实自定义项，点它的
  // 「删除」→ 真 ConfirmDialog（components/ui/confirm-dialog.tsx → Dialog.Portal，
  // 与设置层是**两个**顶层）。useFocusTrap 的契约：焦点在别的顶层里时让位
  // （"activeElement 不在本层（或 body）"即不劫持），关闭后 base-ui 自己把焦点
  // 还给触发它的按钮。
  //
  // 为什么走真实设置面板而不是手搭一个 Dialog：设置页里真实存在的嵌套弹窗就是
  // CustomUiPanel 的删除确认（grep 见报告）。

  await check("★ 嵌套：设置页「扩展」面板渲染出真实自定义项与删除按钮", async () => {
    await js(`window.__store.getState().setSettingsOpen(true, "custom-ui")`);
    await until(() => js<boolean>('document.querySelector(".settings-root") !== null'), "settings open");
    await until(
      () => js<boolean>('[...document.querySelectorAll("[data-testid=custom-ui-row]")].some((r) => r.textContent.includes("焦点探针项"))'),
      "custom UI row",
    );
    const hasDelete = await js<boolean>(`(() => {
      const row = [...document.querySelectorAll("[data-testid=custom-ui-row]")].find((r) => r.textContent.includes("焦点探针项"));
      if (!row) return false;
      const btn = [...row.querySelectorAll("button")].find((b) => b.title === "删除");
      if (!btn) return false;
      btn.setAttribute("data-sfe-delete", "");
      return true;
    })()`);
    assert(hasDelete, "seeded custom UI row has no delete button");
  });

  await check("★ 嵌套：焦点移入删除按钮（触发前锚点）", async () => {
    await js('document.querySelector("[data-sfe-delete]").focus()');
    const focused = await js<boolean>('document.activeElement === document.querySelector("[data-sfe-delete]")');
    assert(focused, "delete button did not take focus");
  });

  await check("★ 嵌套弹窗打开时焦点在弹窗内（不是设置层、不是后台）", async () => {
    await js('document.querySelector("[data-sfe-delete]").click()');
    await until(() => js<boolean>('document.querySelector("[role=dialog]") !== null'), "nested dialog opened");
    // base-ui 在弹窗**焦点落位**后才算打开完成；等 activeElement 进弹窗（有超时，
    // 不伪造成功 —— 真不进就红）。
    await until(
      () => js<boolean>('(() => { const d = document.querySelector("[role=dialog]"); const a = document.activeElement; return !!(d && a && d.contains(a)); })()'),
      "focus entered nested dialog",
      5000,
    ).catch(() => undefined);
    await delay(200);
    const f = await js<{ inDialog: boolean; inSettingsRoot: boolean; inInert: boolean; tag: string | null }>(`(() => {
      const a = document.activeElement;
      const dlg = document.querySelector("[role=dialog]");
      const root = document.querySelector(".settings-root");
      return {
        inDialog: !!(dlg && a && dlg.contains(a)),
        inSettingsRoot: !!(root && a && root.contains(a)),
        inInert: !!(a && a.closest && a.closest("[inert]")),
        tag: a ? a.tagName : null,
      };
    })()`);
    if (!f.inDialog) {
      console.log("DIAG dialog: " + await js<string>(`(() => {
        const dlg = document.querySelector("[role=dialog]");
        const a = document.activeElement;
        return JSON.stringify({
          dialogOuter: dlg ? dlg.outerHTML.slice(0, 300) : null,
          active: a ? a.outerHTML.slice(0, 200) : null,
          activeIsDelete: a === document.querySelector("[data-sfe-delete]"),
          dialogCount: document.querySelectorAll("[role=dialog]").length,
          popups: document.querySelectorAll("[data-base-ui-portal]").length,
        });
      })()`));
    }
    // Base UI portals are outside the Settings container; Electron evidence
    // confirms role=dialog is present even without aria-modal=true. This
    // cannot be diagnosed using [aria-modal=true] alone.
    const isPortalOwner = await js<boolean>(`(() => {
      const d = document.querySelector("[role=dialog]");
      const root = document.querySelector(".settings-root");
      return !!(d && root && !root.contains(d) && d.getAttribute("aria-modal") !== "false");
    })()`);
    assert(isPortalOwner, "nested Base UI dialog must be the top external layer");
    assert(f.inDialog, "focus is not inside the nested dialog: " + JSON.stringify(f));
    assert(f.tag !== "BODY", "focus fell to BODY: " + JSON.stringify(f));
    assert(!f.inInert, "focus fell into the inert workspace: " + JSON.stringify(f));
  });

  await check("★ 嵌套弹窗内 Tab 不逃回设置层/后台（连续五次都在弹窗内）", async () => {
    const trail: Array<{ step: number; inDialog: boolean; inInert: boolean }> = [];
    for (let i = 0; i < 5; i++) {
      await pressTab(false);
      const f = await js<{ inDialog: boolean; inInert: boolean }>(`(() => {
        const a = document.activeElement;
        const dlg = document.querySelector("[role=dialog]");
        return { inDialog: !!(dlg && a && dlg.contains(a)), inInert: !!(a && a.closest && a.closest("[inert]")) };
      })()`);
      const where = await js<string>(`(() => {
        const a = document.activeElement;
        return JSON.stringify({ tag: a ? a.tagName : null, text: a ? (a.textContent || "").slice(0, 20) : null, cls: a ? String(a.className).slice(0, 40) : null, inSettings: !!(a && a.closest && a.closest(".settings-root")), inBody: a === document.body });
      })()`);
      trail.push({ step: i + 1, inDialog: f.inDialog, inInert: f.inInert });
      console.log("TRAIL " + (i + 1) + " " + where);
    }
    assert(trail.every((t) => t.inDialog && !t.inInert), JSON.stringify(trail));
  });

  await check("★ 嵌套：Escape 关闭弹窗后焦点回到触发它的删除按钮", async () => {
    wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(() => js<boolean>('document.querySelector("[role=dialog]") === null'), "nested dialog closed");
    await delay(350);
    const back = await js<boolean>('document.activeElement === document.querySelector("[data-sfe-delete]")');
    assert(back, "focus did not return to the delete button");
    // 设置层仍在、后台仍 inert —— 关闭的只是嵌套层。
    const still = await js<{ settings: boolean; inert: boolean }>(`(() => {
      const root = document.querySelector(".settings-root");
      const w = document.querySelector("[data-testid=workspace-main]");
      return { settings: !!root, inert: w ? !!w.closest("[inert]") : false };
    })()`);
    assert(still.settings && still.inert, JSON.stringify(still));
  });

  await check("★ 嵌套：全程焦点没有落进后台工作区", async () => {
    const f = await focusWhere();
    assert(!f.inInert, JSON.stringify(f));
    // 再验一次 Tab 也不进后台（此刻回到设置层）。
    await pressTab(false);
    const after = await js<boolean>(`(() => {
      const a = document.activeElement;
      return !!(a && !(a.closest && a.closest("[inert]")));
    })()`);
    assert(after, "a Tab left focus inside the inert workspace");
  });

  win.destroy();
  win = undefined;
}
