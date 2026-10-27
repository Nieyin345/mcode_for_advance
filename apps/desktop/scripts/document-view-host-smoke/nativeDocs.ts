/**
 * ARC-007 vendor-native Docs boundary smoke.  Tests the ACTUAL gitignored
 * GenOffice source, not the legacy Mcode docs stub; electron and fonts are
 * replaced only with deterministic fake transport/font data.
 */
import { calls, replies, exposed, listeners } from './stubs/nativeDocsElectron'
import { mcodeDocsDesktopApi as api, MCODE_DOCS_CHANNEL_POLICY as policy, installMcodeDocsViewPreload } from '../../../../genoffice/apps/docs/src/preload/mcode-view'
import { registerDocsIpc, MCODE_NATIVE_DOCS_CHANNELS } from '../../../../genoffice/apps/docs/src/main/mcode-ipc'
import { DOCS_PRIVILEGED_CHANNELS, type DocsPrivilegedPorts } from '../../../../genoffice/apps/docs/src/main/mcode-privileged'
import { runPrivilegedBoundarySmoke } from './privilegedDocs'
import { MCODE_DOCS_AI_HANDLERS, type DocsAiPorts } from '../../../../genoffice/apps/docs/src/main/mcode-ai'
import { checkAiBoundary } from './nativeAi'

let count = 0
function check(name: string, yes: unknown): void {
  count++
  if (!yes) throw Error('FAIL: ' + name)
  console.log('  ok   ' + name)
}
function last() { return calls[calls.length - 1] }
async function main() {
  installMcodeDocsViewPreload()
  check('vendor factory publishes desktop API', exposed.get('desktop') === api)
  for (const key of ['openDocxDecrypt', 'saveDocxTo', 'saveDocxAs',
    'copyImageToClipboard',
    'kbRead', 'getPathForFile', 'projectApi'] as const) {
    check('high-risk API omitted: ' + key, !(key in api))
  }
  for (const ch of ['docs:open', 'docs:save-as', 'docs:save-to', 'docs:open-decrypt',
    'docs:copy-image-to-clipboard', 'project:appendChat'] as const) {
    check('dangerous channel not whitelisted: ' + ch, !(ch in policy))
  }
  check('default channel strategy does not route unknown channels',
    // Count is asserted as a floor, not an exact value: pinning 51 broke the
    // moment T98 added ai:tool-result, and the interesting property is that
    // unknown channels are NOT routed - not that the table never grows.
    Object.keys(policy).length >= 51 && Object.isFrozen(policy))
  // Every T05b DesktopApi method MUST route to the scoped host endpoint,
  // never to a standalone global docs:* / files:* handler.
  const privilegedPreloadCases: Array<[string, () => Promise<unknown>]> = [
    ['pick-image', () => api.pickImage()],
    ['save-image-as', () => api.saveImageAs('data:image/png;base64,AQID')],
    ['pick-export-images-target', () => api.pickExportImagesTarget()],
    ['take-export-pdf', () => api.takeExportPdf('/not/approved.pdf')],
    ['printers', () => api.listPrinters()],
    ['print', () => api.print()],
    ['files-pick', () => api.pickAttachments()],
    ['files-add', () => api.addAttachmentPaths(['/not/approved'])],
    ['files-read-image', () => api.readAttachmentImage('/not/approved')],
    ['write-export-image', () => api.writeExportImage('/not/approved', 'p.png', 'AQID')],
    ['export-pdf', () => api.exportPdf('test.docx', 12240, 15840)],
    ['print-pdf-buffer', () => api.printPdfBuffer(12240, 15840)],
    ['save-merged-pdf', () => api.saveMergedPdf('test', ['AQID'])],
    ['files-read', () => api.readAttachment('/not/approved', 0, 100)],
  ]
  for (const [name, call] of privilegedPreloadCases) {
    await call()
    check('T05b preload routes ' + name + ' only to scoped host IPC',
      last().channel === 'mcode:docs:privileged-' + name)
  }

  const aiCases: Array<[string, () => Promise<unknown>]> = [
    ['get-settings', () => api.getAiSettings()], ['stream', () => api.aiStream({requestId:'test',settings: {} as never,system:'',messages:[]})],
    ['stream-cancel', () => api.aiStreamCancel('test')], ['chat', () => api.aiChat({settings:{} as never,system:'',user:'hello'})],
    ['gsk-status', () => api.aiGskStatus()],
  ]
  for (const [name, fn] of aiCases) {
    await fn()
    check('T05c vendor AI call routes only to scoped Mcode backend: ' + name,
      last().channel === 'mcode:docs:ai-' + name)
  }
  const aiStop = api.onAiStream(() => {})
  check('T05c AI stream responds over Mcode-scoped event only', listeners.has('mcode:docs:ai-stream-chunk'))
  aiStop()

  const savedData = new Uint8Array([80, 75, 3, 4])
  replies.set('mcode:document-view:save', { ok: true })
  const save = await api.saveDocx('C:/outside/a.docx', savedData.buffer)
  check('native save result passes through host', save && (save as { ok?: boolean }).ok === true)
  check('save is routed to Mcode fenced channel', last().channel === 'mcode:document-view:save')
  const payload = last().args[0] as { bytes: Uint8Array; path?: unknown }
  check('source-selected save path not forwarded', !('path' in payload))
  check('bytes forwarded as isolated Uint8Array', payload.bytes instanceof Uint8Array && payload.bytes !== savedData && payload.bytes[0] === 80)
  savedData[0] = 1
  check('renderer mutation does not affect payload', payload.bytes[0] === 80)

  await api.saveDocxNew('../escape.docx', new Uint8Array([80, 75, 1, 2]).buffer)
  check('new save stays on same guarded host channel', last().channel === 'mcode:document-view:save')
  check('new file path only as name suggestion', (last().args[0] as { defaultName: string }).defaultName === '../escape.docx')

  replies.set('mcode:document-view:read-opened', { ok: true, result: { path: '/safe/a.docx', name: 'a.docx', dataUrl: 'data:test', hash: 'a' } })
  const opened = await api.openDocxPath('C:/evil.docx')
  check('host-returned path wins over caller path', opened?.path === '/safe/a.docx')
  check('open button never opens an OS dialog or forwards arbitrary paths', (await api.openDocx())?.path === '/safe/a.docx' && last().channel === 'mcode:document-view:read-opened')
  check('startup pending-open consumes only host-scoped grant', (await api.consumePendingOpenDocx())?.path === '/safe/a.docx' && last().channel === 'mcode:document-view:read-opened')
  check('native open does not invoke unguarded docs:open-path', last().channel === 'mcode:document-view:read-opened')
  check('no caller path in request', !JSON.stringify(last().args).includes('evil.docx'))
  replies.set('mcode:document-view:read-opened', { ok: false, reason: 'denied' })
  check('denied open unwraps to null', await api.openDocxPath('/evil') === null)

  await api.getRecentFiles()
  check('native recent triggers session commit only', last().channel === 'mcode:document-view:open-committed')
  const stopMenu = api.onMenuCommand(() => {})
  check('menu receives native event channel', listeners.has('menu:command'))
  stopMenu()
  check('unsubscribes menu event', listeners.get('menu:command')?.length === 0)
  // 这两条守的是「**fail-closed**」——拒绝或抛错都算，但**不能成功**。
  // 不锚定返回形状 `{ok:false}`：宿主侧没有注册该 handler 时 preload 的 invoke
  // 会 resolve 成 undefined，那同样是"没有假装成功"，而按 `.ok === false` 断言
  // 会直接抛 TypeError（把"拒绝"读成"套件坏了"）。
  // 用 `Promise.resolve().then(...)` 把调用包成 promise 再 await：
  // 直接写 `await api.x(...)` 再放进 async IIFE 里时，TS 会把结果当成
  // `then(onFulfilled, onRejected, ???)` 的第二/第三参来推断，报参数个数不符。
  const recovery = await Promise.resolve()
    .then(() => api.writeRecoveryCopy!('/arbitrary/a.docx', new ArrayBuffer(8)))
    .then((value) => ({ settled: true, value: value as { ok?: boolean } | undefined }))
    .catch(() => ({ settled: false, value: undefined as { ok?: boolean } | undefined }));
  check('binary crash recovery explicitly fails closed (no parallel DOCX store)',
    !recovery.settled || recovery.value?.ok !== true);
  const passwordRet = await Promise.resolve()
    .then(() => api.discardDocPasswordIntents!(0))
    .then((value) => ({ settled: true, value: value as { ok?: boolean } | undefined }))
    .catch(() => ({ settled: false, value: undefined as { ok?: boolean } | undefined }));
  check('password intent mutation explicitly fails closed (no vendor password store)',
    !passwordRet.settled || passwordRet.value?.ok !== true);
  await api.spellAddWord('testword')
  check('preload spelling add uses guarded native channel', last().channel === 'mcode:docs:native-spell-add-word')
  await api.spellIgnoreWord('testword')
  check('preload spelling ignore uses guarded native channel', last().channel === 'mcode:docs:native-spell-ignore-word')
  await api.spellReplace('testword')
  check('preload spelling replace uses guarded native channel', last().channel === 'mcode:docs:native-spell-replace')
  api.spellDiag('safe trace')
  check('preload spell trace uses guarded native channel', last().channel === 'mcode:docs:native-spell-diag')
  await api.respellKick()
  check('preload respell uses guarded native channel', last().channel === 'mcode:docs:native-respell-kick')
  api.armContextMenu()
  check('context arm uses sender-bound native channel', last().channel === 'mcode:docs:native-context-menu-arm')
  api.claimContextMenu(123)
  check('context claim uses synchronous native channel', last().channel === 'mcode:docs:native-context-menu-claim')
  const unsubscribeContext = api.onContextMenuRequest(() => {})
  check('context menu reply uses scoped event channel', listeners.has('mcode:docs:native-context-menu'))
  unsubscribeContext()
  api.reportViewMenuState({ aiSidebar: true, darkCanvas: true })
  check('view-menu state uses host-scoped channel', last().channel === 'mcode:docs:native-view-menu-state')
  const stopDirty = api.onCloseCheck(() => {})
  check('close-check maps to Mcode host', listeners.has('mcode:document-view:close-check'))
  stopDirty()
  api.reportCloseCheck({ dirty: 'true' })
  check('close-check cannot spoof dirty via truthy string', last().channel === 'mcode:document-view:close-check-result' && (last().args[0] as {dirty: boolean}).dirty === false)
  check('auto-save default follows native ABI', (await api.getAutoSaveDefault()).on === true)
  replies.set('mcode:docs:native-ui-language', 'en')
  check('Docs language follows Mcode UI setting (not hardcoded zh)', await api.getLanguage() === 'en' && last().channel === 'mcode:docs:native-ui-language')
  replies.set('mcode:docs:native-system-locale', 'ja-JP')
  check('Docs OS locale follows Electron host (not hardcoded zh-CN)', await api.getSystemLocale() === 'ja-JP' && last().channel === 'mcode:docs:native-system-locale')

  // Native main registrar: no global docs:* handlers. Sender authorization
  // is mandatory at every invocation including mutations.
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const removed: string[] = []
  const onHandlers = new Map<string, (event: unknown, raw?: unknown) => unknown>()
  const fakeIpc = {
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(ch, fn) },
    removeHandler: (ch: string) => { handlers.delete(ch); removed.push(ch) },
    on: (ch: string, fn: (event: unknown, raw?: unknown) => unknown) => { onHandlers.set(ch, fn) },
    removeListener: (ch: string) => { onHandlers.delete(ch) },
  }
  const smokeDataRoot = process.env.MCODE_SMOKE_DATA_ROOT
  if (!smokeDataRoot) throw new Error('isolated Mcode smoke data root required')
  const dispose = registerDocsIpc(fakeIpc as never, (sender) => sender === approved, () => 'en', () => smokeDataRoot, () => approved.__ports,
    (sender) => sender === approved && approved.__ai ? {ports: approved.__ai, context:{sessionId:'mcode-session',filePath:'/sandbox/doc.docx'}} : null)
  check('scoped native handlers installed, including UI and locale', handlers.size >= 5 && MCODE_NATIVE_DOCS_CHANNELS.every((ch) => handlers.has(ch)))
  const words = new Set<string>()
  let replacements = 0
  let kicks = 0
  const spell = {
    addWordToSpellCheckerDictionary(word: string) { words.add(word); return true },
    removeWordFromSpellCheckerDictionary(word: string) { words.delete(word); return true },
    availableSpellCheckerLanguages: ['en-US', 'zh-CN'],
    active: ['en-US'],
    getSpellCheckerLanguages() { return this.active },
    setSpellCheckerLanguages(next: string[]) { this.active = next },
  }
  const approved = { id: 123, session: spell, __ports: null as DocsPrivilegedPorts | null, __ai: null as DocsAiPorts | null, send: (_ch: string, _value: unknown) => {},  __print: null as null | ((cb: (ok: boolean, error?: string) => void) => void), print: (_options: unknown, cb: (ok: boolean, error?: string) => void) => approved.__print?.(cb), getPrintersAsync: async () => [{name: 'fake-queue', displayName: 'Isolated Test Printer', status: 9, options: {secret: 'must-not-return'}}], isDestroyed: () => false, focus: () => {}, sendInputEvent: () => { kicks++ }, replaceMisspelling: () => { replacements++ }, once: (_event: string, _cb: () => void) => {}, on: (_event: string, _cb: (...args: unknown[]) => void) => {} }
  const forged = { id: 124, session: spell, isDestroyed: () => false, send: (_channel: string, _message: unknown) => {} }
  const invoke = (ch: string, sender: unknown, raw?: unknown): unknown =>
    handlers.get(ch)!({ sender }, raw)
  check('unauthorized font read denied', invoke('mcode:docs:native-font-metrics', forged, 'Arial') === null)
  check('authorized native font engine used', (invoke('mcode:docs:native-font-metrics', approved, 'Arial') as { inspectedFamily: string }).inspectedFamily === 'Arial')
  check('authorized UI language resolves from Mcode', invoke('mcode:docs:native-ui-language', approved) === 'en')
  check('unauthorized UI language denied', invoke('mcode:docs:native-ui-language', forged) === null)
  check('native system locale guarded', typeof invoke('mcode:docs:native-system-locale', approved) === 'string' && invoke('mcode:docs:native-system-locale', forged) === null)
  check('oversized font name rejected', invoke('mcode:docs:native-font-metrics', approved, 'a'.repeat(129)) === null)
  const before = spell.active.slice()
  invoke('mcode:docs:native-spell-set-languages', forged, ['zh-CN'])
  check('untrusted sender cannot change spell session', spell.active.join() === before.join())
  check('unauthorized spell add is refused', invoke('mcode:docs:native-spell-add-word', forged, 'guest') === false && !words.has('guest'))
  check('authorized spell add reaches Chromium', invoke('mcode:docs:native-spell-add-word', approved, 'alpha') === true && words.has('alpha'))
  check('authorized ignore is registered', invoke('mcode:docs:native-spell-ignore-word', approved, 'bravo') === true && words.has('bravo'))
  check('misspelling replacement remains sender-guarded', invoke('mcode:docs:native-spell-replace', forged, 'bad') === undefined && replacements === 0)
  invoke('mcode:docs:native-spell-replace', approved, 'good')
  check('authorized spelling replacement uses Chromium', replacements === 1)
  await invoke('mcode:docs:native-respell-kick', approved)
  check('respell triggers trusted Chromium events', kicks === 3)
  invoke('mcode:docs:native-spell-set-languages', approved, ['invalid', 'zh-CN'])
  check('authorized spell language filtered to installed', spell.active.join() === 'zh-CN')
  check('native context/menu event handlers exist', ['mcode:docs:native-context-menu-claim', 'mcode:docs:native-context-menu-arm', 'mcode:docs:native-view-menu-state'].every((ch) => onHandlers.has(ch)))
  const rightClicks: Array<(...args: unknown[]) => void> = []
  approved.on = (_event: string, cb: (...args: unknown[]) => void) => { rightClicks.push(cb) }
  onHandlers.get('mcode:docs:native-context-menu-arm')!({ sender: approved })
  const claimEvent: { sender: typeof approved; returnValue?: boolean } = { sender: approved }
  onHandlers.get('mcode:docs:native-context-menu-claim')!(claimEvent, 123)
  check('claim is synchronous', claimEvent.returnValue === true)
  check('context armed only once', rightClicks.length === 1)
  const disposeSecond = registerDocsIpc(fakeIpc as never, (sender) => sender === forged, () => 'zh')
  check('additional DocumentViewHost shares registrar without duplicate IPC handles', handlers.size === MCODE_NATIVE_DOCS_CHANNELS.length + DOCS_PRIVILEGED_CHANNELS.length + MCODE_DOCS_AI_HANDLERS.length)
  check('second host can authorize its own sender', invoke('mcode:docs:native-ui-language', forged) === 'zh')
  disposeSecond()
  check('removed second host cannot retain privileged access', invoke('mcode:docs:native-ui-language', forged) === null)
  await runPrivilegedBoundarySmoke(handlers, approved, forged, smokeDataRoot, check)
  await checkAiBoundary(handlers, approved, forged, check)
  dispose()
  check('native registrations can be released', handlers.size === 0 && onHandlers.size === 0 && removed.length === MCODE_NATIVE_DOCS_CHANNELS.length + DOCS_PRIVILEGED_CHANNELS.length + MCODE_DOCS_AI_HANDLERS.length)
  console.log(`native-docs-boundary: ${count}/${count} PASS`)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
