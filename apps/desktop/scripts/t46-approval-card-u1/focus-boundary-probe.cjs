/**
 * T46 附带交付 —— **焦点边界判别探针**（结论写进 `tasks/T42-u1-silent-mode.md`）。
 *
 * 跑法（仓库根）：
 *   ELECTRON=$(node -p "require('./apps/desktop/node_modules/electron')")
 *   "$ELECTRON" apps/desktop/scripts/t46-approval-card-u1/focus-boundary-probe.cjs
 *   "$ELECTRON" apps/desktop/scripts/t46-approval-card-u1/focus-boundary-probe-hidden.cjs
 *
 * 第一条回答「两窗口都 show:true 屏幕外，B 持焦点时只调 A.webContents.focus()」；
 * 第二条回答「A 用 show:false 真隐藏时只调 A.webContents.focus()」。
 * 两条合起来是「visible vs truly hidden」这条边界的证据。
 *
 * ⚠️ 一次进程里**只建一对窗口**：先建一对、destroy、再建第二对会出现后续 loadURL
 * 挂起/ERR_FAILED（本机实测，与本结论无关，但别把它写进别的套件）。
 *
 * 原 v2 判别性探针：**多窗口下 `webContents.focus()` 单独够不够。**
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
    // ══ 第一对：两窗口都「显示但屏幕外」══
    const { a, b } = await pair("P1", true);
    b.focus();
    await sleep(300);
    const start = { aDoc: await docHasFocus(a), aWin: a.isFocused(), bWin: b.isFocused() };
    console.log("P1-START " + JSON.stringify(start));

    // 判别点 1：只调 wc.focus()
    a.webContents.focus();
    await sleep(400);
    const wcOnly = { aDoc: await docHasFocus(a), aWin: a.isFocused(), bWin: b.isFocused(), aVisible: a.isVisible() };
    console.log("P1-WC-ONLY " + JSON.stringify(wcOnly));

    // 判别点 2：如果 wc.focus() 没拿到，再用窗口级 focus
    let winLevel = null;
    if (wcOnly.aDoc !== true) {
      a.focus();
      winLevel = { aDoc: await untilFocus(a), aWin: a.isFocused(), bWin: b.isFocused() };
      console.log("P1-WIN-LEVEL " + JSON.stringify(winLevel));
    }
    a.destroy(); b.destroy();
    await sleep(500);

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
