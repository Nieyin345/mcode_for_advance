// 【O6】PDF 换壳的真 Electron 探针。
//
// 装载方式刻意选「vendor 自己构建产物里的独立入口」`apps/pdf/out/main/index.js`：
// 它 import 时就调用 `startPdfStandalone()`，注册**原厂**的 scheme 表、导航守卫、
// 上下文菜单、IPC 与预览协议，并用**原厂 preload** 打开**原厂 renderer**。
// 全程没有一行我们自己的复刻逻辑。
//
// 唯一被我们改的是 `app.setName()`：那是 Mcode 主进程对进程身份做的事
// （apps/desktop/src/main/index.ts 的 `app.setName("Mcode")`），也是 UA 里产品号的来源。
// 所以两次运行（`Mcode` / `GenOffice HTML`）的页面差异，只可能来自 `main.tsx` 的
// UA 开关 —— 这正是宿主与独立运行的真实差别。
//
// 本文件只取证，判断全部在 build.mjs。
const { app, nativeTheme } = require('electron')

// O6 暗色判据：GenOffice 的 UiTheme 只有 light/dark/system 三档，`system` 时
// 渲染端不设 data-theme，靠 `prefers-color-scheme` 走 tokens.css 的媒体查询块。
// 独立运行的 html/markdown 没有 shell 注册 `app:get-theme`，渲染端 catch 到
// 'system' —— 所以暗色的**真实触发路径**就是 system + OS 深色，
// 这里用 nativeTheme.themeSource 精确控制它（不影响其他进程）。
if (process.env.O6_THEME === 'dark') nativeTheme.themeSource = 'dark'
else if (process.env.O6_THEME === 'light') nativeTheme.themeSource = 'light'
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const DIR = process.env.O6_DIR
const APP_MAIN = process.env.O6_APP_MAIN
const APP_NAME = process.env.O6_APP_NAME
const userData = mkdtempSync(join(tmpdir(), 'o6-html-ud-'))

// 必须在 require 入口**之前**设：入口在模块顶层就注册 scheme 与 app 生命周期。
app.setName(APP_NAME)
app.setPath('userData', userData)
app.disableHardwareAcceleration()
process.env.AI_OFFICE_USER_DATA = userData

// ★ 套件绝不把窗口弹到用户眼前。
//
// vendor 入口（startHtmlStandalone / startMarkdownStandalone）建的是普通可见窗口；
// 套件跑在开发机上，弹窗会打断正在用机器的人。所以在 **require 入口之前**替换
// electron 模块上的 BrowserWindow：所有窗口强制 `show: false` + 不进任务栏。
// executeJavaScript 在隐藏窗口上照常工作，判据读的是 DOM，不依赖可见性。
//
// 改在构造处而不是事后 hide()：事后 hide 仍然会有一帧可见（窗口先 show 再被挪走）。
{
  const electron = require('electron')
  const RealBrowserWindow = electron.BrowserWindow
  const ForcedHidden = new Proxy(RealBrowserWindow, {
    construct(target, args) {
      const options = args[0] ?? {}
      return Reflect.construct(target, [
        {
          ...options,
          show: false,
          skipTaskbar: true,
          ...(Array.isArray(args) && args.length > 1 ? {} : {}),
        },
        ...args.slice(1),
      ])
    },
  })
  electron.BrowserWindow = ForcedHidden
}

const errors = []

const EVIDENCE_SCRIPT = `(() => {
  const sheets = [...document.styleSheets].map((s) => s.href).filter(Boolean)
  const q = (sel) => document.querySelector(sel)
  const bg = (sel) => { const el = q(sel); return el ? getComputedStyle(el).backgroundColor : null }
  const cs = getComputedStyle(document.documentElement)
  return JSON.stringify({
    ua: navigator.userAgent,
    sheets,
    mcodeSheets: sheets.filter((h) => h.includes('mcode-theme')),
    present: Object.fromEntries(
      ['.ribbon', '.app', '.status-bar', '.statusbar', '.pdf-page', 'canvas'].map((sel) => [sel, !!q(sel)]),
    ),
    tokens: {
      surface: cs.getPropertyValue('--surface').trim(),
      text: cs.getPropertyValue('--text').trim(),
      border: cs.getPropertyValue('--border').trim(),
      hover: cs.getPropertyValue('--hover').trim(),
      previewPageBg: cs.getPropertyValue('--preview-page-bg').trim(),
      gsFontSans: cs.getPropertyValue('--gs-font-sans').trim().split(',')[0].trim(),
    },
    computedBg: {
      ribbon: bg('.ribbon'),
      statusBar: bg('.status-bar') ?? bg('.statusbar'),
      body: bg('body'),
    },
    computedInk: q('.ribbon') ? getComputedStyle(q('.ribbon')).color : null,
    // PDF 的纸张是 app 私有的 --pdf-paper（styles.css:27）—— 本测试断言它从未被
    // 主题层覆盖，所以在宿主与独立两种模式下都应等于上游值 #fff。
    paperToken: cs.getPropertyValue('--pdf-paper').trim(),
    textLength: (document.body.innerText || '').trim().length,
  })
})()`

const settle = (payload) => {
  // 文件名必须带主题：同一 app 名在亮/暗两轮里各写一次，只按 app 名命名会互相覆盖，
  // 最后只剩一份证据（而且看起来「跑过了」）。
  const safe = `${APP_NAME}-${process.env.O6_THEME || 'light'}`.replace(/\s+/g, '-')
  writeFileSync(join(DIR, `evidence-${safe}.json`), JSON.stringify(payload, null, 2), 'utf8')
  app.exit(0)
}

async function inspect() {
  // 入口在 whenReady 里建窗；等它出现。
  let win = null
  for (let i = 0; i < 100 && !win; i++) {
    await new Promise((r) => setTimeout(r, 100))
    win = require('electron').BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
  }
  if (!win) return settle({ appName: app.getName(), probeError: 'no window', errors })

  // ★ 套件绝不把窗口留到用户眼前。vendor 入口建的是普通可见窗口；这里立刻把它
  //   挪到主屏之外并隐藏 —— 套件跑在开发机上，弹窗会打断正在用机器的人。
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
    settle({ appName: app.getName(), evidence, errors })
  } catch (error) {
    settle({ appName: app.getName(), probeError: String(error), errors })
  }
}

app.whenReady().then(() => {
  // require 之后入口自己的 whenReady 回调先排上；这里接在它后面。
  setTimeout(() => void inspect(), 0)
})

require(APP_MAIN)
