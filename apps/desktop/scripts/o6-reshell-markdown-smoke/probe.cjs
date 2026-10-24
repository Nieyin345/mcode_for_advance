// 【O6】Markdown 换壳的真 Electron 探针（取证；判断在 build.mjs）。
//
// 装载方式与 html 套件相同：跑 vendor 自己构建产物的独立入口
// `apps/markdown/out/main/index.js` —— 它 import 时就 `startMarkdownStandalone()`，
// 注册原厂 scheme、守卫、IPC 与预览协议，用原厂 preload 打开原厂 renderer。
// 我们只改 `app.setName()`（Mcode 主进程对进程身份做的事，也是 UA 产品号的来源）。
//
// 除 chrome token 外，这里额外取 `.doc-page`（预览纸张，正文渲染在里面）的
// background-color 与它作用域内的 --surface / --text —— 那是**文档内容**，
// 换壳不许动它。`.editor-scroll`（画布底，属 chrome）作为对照：它**应该**换。
const { app, nativeTheme } = require('electron')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const DIR = process.env.O6_DIR
const APP_MAIN = process.env.O6_APP_MAIN
const APP_NAME = process.env.O6_APP_NAME
const userData = mkdtempSync(join(tmpdir(), 'o6-md-ud-'))

app.setName(APP_NAME)
app.setPath('userData', userData)
app.disableHardwareAcceleration()
process.env.AI_OFFICE_USER_DATA = userData

// O6 暗色判据：GenOffice 的 UiTheme 只有 light/dark/system；`system` 时渲染端不设
// data-theme，暗色靠 `prefers-color-scheme`。独立运行的 markdown 没有 shell 注册
// `app:get-theme`（渲染端 catch 到 'system'），所以**真实路径**就是 system + OS 深色。
// nativeTheme.themeSource 精确控制它，只影响本进程。
if (process.env.O6_THEME === 'dark') nativeTheme.themeSource = 'dark'
else if (process.env.O6_THEME === 'light') nativeTheme.themeSource = 'light'

// O6 纸张主题回归：vendor 自己的 `getMarkdownTheme` 读 userData/markdown-settings.json
// 的 `markdownTheme`（markdown-main.ts:959/994）。预置它，走**真实**读取链，
// 而不是在渲染端硬 setAttribute —— 后者验的是「属性有效」，不是「用户选主题时有效」。
if (process.env.O6_PAPER_THEME) {
  require('node:fs').writeFileSync(
    join(userData, 'markdown-settings.json'),
    JSON.stringify({ markdownTheme: process.env.O6_PAPER_THEME }),
    'utf8',
  )
}

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
  const page = q('.doc-page')
  const pageCs = page ? getComputedStyle(page) : null
  return JSON.stringify({
    ua: navigator.userAgent,
    sheets,
    mcodeSheets: sheets.filter((h) => h.includes('mcode-theme')),
    present: Object.fromEntries(
      ['.ribbon', '.app', '.app-main', '.app-content', '.doc-page', '.editor-scroll',
       '.status-bar', '.copilot'].map((sel) => [sel, !!q(sel)]),
    ),
    tokens: {
      surface: cs.getPropertyValue('--surface').trim(),
      text: cs.getPropertyValue('--text').trim(),
      border: cs.getPropertyValue('--border').trim(),
      gsFontSans: cs.getPropertyValue('--gs-font-sans').trim().split(',')[0].trim(),
      docPage: {
        surface: pageCs ? pageCs.getPropertyValue('--surface').trim() : null,
        text: pageCs ? pageCs.getPropertyValue('--text').trim() : null,
      },
    },
    computedBg: {
      ribbon: bg('.ribbon'),
      statusBar: bg('.status-bar'),
      docPage: bg('.doc-page'),
      editorScroll: bg('.editor-scroll'),
      body: bg('body'),
    },
    textLength: (document.body.innerText || '').trim().length,
  })
})()`

const settle = (payload) => {
  // 文件名必须带主题：同一 app 名在亮/暗两轮里各写一次，只按 app 名命名会互相覆盖，
  // 最后只剩一份证据（而且看起来「跑过了」）。
  const paper = process.env.O6_PAPER_THEME || ''
  const safe = `${APP_NAME}-${process.env.O6_THEME || 'light'}${paper ? `-${paper}` : ''}`.replace(/\s+/g, '-')
  writeFileSync(join(DIR, `evidence-${safe}.json`), JSON.stringify(payload, null, 2), 'utf8')
  app.exit(0)
}

async function inspect() {
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

  await new Promise((r) => setTimeout(r, 7000))
  try {
    const evidence = JSON.parse(await win.webContents.executeJavaScript(EVIDENCE_SCRIPT))
    settle({ appName: app.getName(), evidence, errors })
  } catch (error) {
    settle({ appName: app.getName(), probeError: String(error), errors })
  }
}

app.whenReady().then(() => {
  setTimeout(() => void inspect(), 0)
})

require(APP_MAIN)
