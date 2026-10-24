// 【O8】docs 换壳开关的真假 —— 真 Electron 探针。
//
// 装载方式与 O6 五套相同：跑 vendor 自己构建产物里的独立入口
// `apps/docs/out/main/index.js`（它顶层调 `startDocsStandalone()`），
// 用**原厂 preload** 打开**原厂 renderer**。全程没有一行我们自己的复刻逻辑。
//
// 唯一被改的是 `app.setName()` —— 那是 Mcode 主进程对进程身份做的事
// （`apps/desktop/src/main/index.ts` 的 `app.setName("Mcode")`），也是 UA 里产品号的来源。
//
// ## 为什么这一套必须存在
//
// 0014（docs 换壳）的守卫是 `if (window.desktop)`，而 `desktop` 是 **docs 自己的
// preload 命名空间**（`docs/src/preload/index.ts:284` `exposeInMainWorld('desktop', api)`），
// **独立运行时也存在** —— 所以那个守卫对它承诺要防的场景（「单独跑 GenOffice 不换壳」）
// 根本没生效，而套件只断言了源码里有那行，一直绿着。
//
// 这一套让同一份构建产物跑两遍，比较页面里**真实**发生了什么事。
//
// ## 额外取证：`window.desktop` 的其余能力仍然工作（判据 1b）
//
// docs 的 `renderer/` 里有 **127 处** `window.desktop`（17 个文件），其中 126 处问的
// 是「这个命名空间有没有某个能力」，答案在独立运行时也是「有」—— 那些是对的。
// 只有 `main.tsx:26` 那个 `import('./mcode-theme.css')` 问错了问题。
// 所以本探针额外读 `window.desktop.getTheme()`：**改错版本（把 getTheme 也换成 UA 判断）
// 会让它返回 undefined**，这一条专门防那种改法。
const { app, nativeTheme } = require('electron')

if (process.env.O8_THEME === 'dark') nativeTheme.themeSource = 'dark'
else if (process.env.O8_THEME === 'light') nativeTheme.themeSource = 'light'

const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const DIR = process.env.O8_DIR
const APP_MAIN = process.env.O8_APP_MAIN
const APP_NAME = process.env.O8_APP_NAME
const userData = mkdtempSync(join(tmpdir(), 'o8-docs-ud-'))

// 必须在 require 入口**之前**设：入口在模块顶层就注册 scheme 与 app 生命周期。
app.setName(APP_NAME)
app.setPath('userData', userData)
app.disableHardwareAcceleration()
process.env.AI_OFFICE_USER_DATA = userData

// ★ 套件绝不把窗口弹到用户眼前。
//
// vendor 入口（startDocsStandalone）建的是普通可见窗口；套件跑在开发机上，
// 弹窗会打断正在用机器的人。在 **require 入口之前**替换 electron 模块上的
// BrowserWindow：所有窗口强制 `show:false` + 不进任务栏。
// executeJavaScript 在隐藏窗口上照常工作，判据读的是 DOM，不依赖可见性。
//
// 改在构造处而不是事后 hide()：事后 hide 仍然会有一帧可见（窗口先 show 再被挪走）。
{
  const electron = require('electron')
  const RealBrowserWindow = electron.BrowserWindow
  const ForcedHidden = new Proxy(RealBrowserWindow, {
    construct(target, args) {
      const options = args[0] ?? {}
      return Reflect.construct(target, [{ ...options, show: false, skipTaskbar: true }, ...args.slice(1)])
    },
  })
  electron.BrowserWindow = ForcedHidden
}

const errors = []

// 必须在 app.whenReady() 之后注册：Electron 在 ready 之前调 ipcMain.handle 会抛。
// 第一版放在模块顶层，套件两次都是 nativeLanguageHits === undefined。
let nativeLanguageHits = 0
let languageHandlerError = null
function registerLanguageProbe() {
  try {
    const { ipcMain } = require('electron')
    ipcMain.handle('mcode:docs:native-ui-language', () => {
      nativeLanguageHits += 1
      return process.env.O8_LANGUAGE_SENTINEL || 'zh'
    })
  } catch (err) {
    languageHandlerError = String(err)
  }
}

// ── 判据 1b 的行为面：主进程侧计数器 ─────────────────────────────────────
//
// 为什么需要它（O6 会话复核时指出的两条假行为判据）：
//
//   1. 在探针里 `window.desktop.getTheme()` 只能证明"探针能调到"，不能证明
//      "页面启动时调了" —— 把 main.tsx 里的调用短路成常量后，探针照样能调到。
//   2. `getTheme` 在 mcode-view.ts:255 是**写死的常量** `Promise.resolve('system')`，
//      调不调用、抛不抛错，页面上都是同一个值 —— 返回值分不出真假。
//
// 而 `getLanguage` 是真的走 IPC：main.tsx → mcode-view.ts:249
// → route('app:get-language') → 'mcode:docs:native-ui-language'。
//
// 生产里那个通道由 Mcode 主进程的 `registerDocsIpc` 注册（documentViewHost.ts:504）。
// 本探针跑的是 vendor 独立入口，它**不调** registerDocsIpc —— 所以在这里自己装一个
// 计数器当哨兵：页面每发起一次真实请求，计数 +1。
//
// 它证明的是「页面启动时确实调了 getLanguage，而且请求真的出了渲染进程」。
// 它**不**证明「Mcode 真的实现了那个通道」（那是 document-view-host-smoke 的范围）。

const EVIDENCE_SCRIPT = `(async () => {
  const sheets = [...document.styleSheets].map((s) => s.href).filter(Boolean)
  const q = (sel) => document.querySelector(sel)
  const bg = (sel) => { const el = q(sel); return el ? getComputedStyle(el).backgroundColor : null }
  const cs = getComputedStyle(document.documentElement)

  // 判据 1b 的页面侧取证：只记录 window.desktop 上**有哪些方法**，以及它们的返回值。
  //
  // 注意这一层**不制造调用**。早先的版本在探针里主动调 getTheme() 并计数，
  // 但那样计数的是"探针能调到"，不是"页面启动时调了" —— 两者被 M4 变异区分开过：
  // 把 main.tsx 里的 getTheme() 短路成常量后，探针照样能调到，计数照样是 1。
  //
  // "页面启动时真的调了"由主进程侧的计数器证明（见 probe.cjs 顶部的
  // nativeLanguageHits），那是页面自己发起、打到主进程的请求。
  let desktopProbe
  try {
    if (typeof window.desktop !== 'object' || window.desktop === null) {
      desktopProbe = { present: false }
    } else {
      desktopProbe = {
        present: true,
        keys: Object.keys(window.desktop).length,
        hasGetTheme: typeof window.desktop.getTheme === 'function',
        hasGetLanguage: typeof window.desktop.getLanguage === 'function',
        hasGetDocumentTheme: typeof window.desktop.getDocumentTheme === 'function',
        hasOnThemeChanged: typeof window.desktop.onThemeChanged === 'function',
        hasOnDocumentThemeChanged: typeof window.desktop.onDocumentThemeChanged === 'function',
        hasOnAiPanelPrefsChanged: typeof window.desktop.onAiPanelPrefsChanged === 'function',
        hasOnAuthorNameChanged: typeof window.desktop.onAuthorNameChanged === 'function',
      }
      // 取值供 9c 用。这一次调用同样会打到主进程计数器（9b），所以两处交叉验证 ——
      // 若被测代码启动时不调，9b 已经红了；这里取到值只说明"探针能调"。
      try { desktopProbe.lang = await window.desktop.getLanguage() }
      catch (e) { desktopProbe.lang = 'THREW: ' + String(e).slice(0, 120) }
      try { desktopProbe.theme = await window.desktop.getTheme() }
      catch (e) { desktopProbe.theme = 'THREW: ' + String(e).slice(0, 120) }
    }
  } catch (e) {
    desktopProbe = { present: false, error: String(e) }
  }

  return JSON.stringify({
    ua: navigator.userAgent,
    sheets,
    mcodeSheets: sheets.filter((h) => h.includes('mcode-theme')),
    present: Object.fromEntries(
      ['.app', '.app-main', '.app-content', '.editor-area', '.doc-page', '.page-wrap',
       '.status-bar', '.ribbon'].map((sel) => [sel, !!q(sel)]),
    ),
    tokens: {
      surface: cs.getPropertyValue('--surface').trim(),
      text: cs.getPropertyValue('--text').trim(),
      border: cs.getPropertyValue('--border').trim(),
      chromeBg: cs.getPropertyValue('--chrome-bg').trim(),
    },
    computedBg: {
      appMain: bg('.app-main'),
      docPage: bg('.doc-page'),
      body: bg('body'),
    },
    desktopProbe,
    textLength: (document.body.innerText || '').trim().length,
  })
})()`

const settle = (payload) => {
  // 文件名必须带主题：同一 app 名在亮/暗两轮里各写一次，只按 app 名命名会互相覆盖，
  // 最后只剩一份证据（而且看起来「跑过了」）。
  const safe = `${APP_NAME}-${process.env.O8_THEME || 'light'}`.replace(/\s+/g, '-')
  writeFileSync(join(DIR, `evidence-${safe}.json`), JSON.stringify(payload, null, 2), 'utf8')
  app.exit(0)
}

async function inspect() {
  let win = null
  for (let i = 0; i < 100 && !win; i++) {
    await new Promise((r) => setTimeout(r, 100))
    win = require('electron').BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
  }
  if (!win) return settle({ appName: app.getName(), probeError: 'no window', errors, nativeLanguageHits, languageHandlerError })

  // ★ 套件绝不把窗口留到用户眼前。
  try {
    const { screen } = require('electron')
    const primary = screen.getPrimaryDisplay()
    const other = screen.getAllDisplays().find((d) => d.id !== primary.id)
    const spot = other
      ? { x: other.workArea.x + 40, y: other.workArea.y + 40 }
      : { x: -20000, y: -20000 }
    win.setBounds({ ...spot, width: 1280, height: 860 })
    win.setSkipTaskbar?.(true)
    win.blur?.()
    win.hide()
  } catch {
    /* 平台不支持时退化为原行为；判据读 DOM，不依赖可见性 */
  }

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push({ type: 'console', message: String(message).slice(0, 300) })
  })

  // 让 React 挂载，并让懒加载的 mcode-theme chunk 落地。
  await new Promise((r) => setTimeout(r, 7000))
  try {
    const evidence = JSON.parse(await win.webContents.executeJavaScript(EVIDENCE_SCRIPT))
    settle({ appName: app.getName(), evidence, errors, nativeLanguageHits, languageHandlerError })
  } catch (error) {
    settle({ appName: app.getName(), probeError: String(error), errors, nativeLanguageHits, languageHandlerError })
  }
}

app.whenReady().then(() => {
  // 先装计数器（页面可能立刻发起请求），再接 inspect。
  registerLanguageProbe()
  setTimeout(() => void inspect(), 0)
})

require(APP_MAIN)
