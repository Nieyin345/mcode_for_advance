/**
 * T46 附带交付 —— 焦点边界探针（**真隐藏窗口**那一档）。
 * 见同目录 `focus-boundary-probe.cjs` 的文件头。
 *
 * v1 卡在「第二组建窗时 `loadURL` 不返回」—— 反复 destroy/新建窗口在屏幕外 +
 * opacity 0 的组合下会让后续 load 失败（ERR_FAILED）或挂起。v2 改为**只建一次
 * 两窗口**，全部判别都在这一对上做，靠「谁调用 focus」隔离变量。
 *
 * 判别顺序（每一次都记录 `document.hasFocus()`（渲染端事实）与 `win.isFocused()`（OS 事实））：
 *   A. B 抢走焦点后 → **只** `A.webContents.focus()` → A 拿到文档焦点了吗？窗口焦点呢？
 *   B. 再把焦点交给 B → `A.focus()`（窗口级）→ 记录差异
 *   C. A 用 `show:false` 真隐藏时，`webContents.focus()` 能不能拿到（另一对窗口）
 *
 * 硬超时自杀。
 */
const { app, BrowserWindow } = require("electron");
const HARD = setTimeout(() => { console.log("PROBE-FATAL timeout"); app.exit(2); }, 90_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function docHasFocus(win) {
  try { return await win.webContents.executeJavaScript("document.hasFocus()", true); } catch { return null; }
}
async function untilFocus(win, ms = 1500) {
  const end = Date.now() + ms;
  for (;;) {
    if ((await docHasFocus(win)) === true) return true;
    if (Date.now() > end) return false;
    await sleep(40);
  }
}
function facts(tag, win) {
  return { tag, doc: win.isDestroyed() ? null : undefined };
}

async function pair(prefix, showA) {
  const mk = (name) => new BrowserWindow({
    width: 480, height: 320, show: false, opacity: 0, x: -10000, y: -10000, title: name,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  const a = mk(prefix + "-A");
  const b = mk(prefix + "-B");
  await a.loadURL("about:blank");
  await b.loadURL("about:blank");
  if (showA) { a.showInactive(); }
  b.showInactive();
  await sleep(200);
  return { a, b };
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    // ══ 第二对：A 真隐藏（show:false 未显示），B 显示并持焦点 ══
    const { a: ha, b: hb } = await pair("P2", false);
    hb.focus();
    await sleep(300);
    const hStart = { aVisible: ha.isVisible(), aDoc: await docHasFocus(ha), hbWin: hb.isFocused() };
    ha.webContents.focus();
    await sleep(400);
    const hWcOnly = { aVisible: ha.isVisible(), aDoc: await docHasFocus(ha), aWin: ha.isFocused(), hbWin: hb.isFocused() };
    console.log("P2-HIDDEN-WC-ONLY " + JSON.stringify({ start: hStart, after: hWcOnly }));
    ha.destroy(); hb.destroy();
  } catch (e) {
    console.log("PROBE-ERROR " + String((e && e.stack) || e));
  } finally {
    clearTimeout(HARD);
    app.exit(0);
  }
});
