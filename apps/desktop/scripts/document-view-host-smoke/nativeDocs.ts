/**
 * ARC-007 vendor-native Docs boundary smoke.  Tests the ACTUAL gitignored
 * GenOffice source, not the legacy Mcode docs stub; electron and fonts are
 * replaced only with deterministic fake transport/font data.
 */
import { calls, replies, exposed, listeners } from './stubs/nativeDocsElectron'
import { mcodeDocsDesktopApi as api, MCODE_DOCS_CHANNEL_POLICY as policy, installMcodeDocsViewPreload } from '../../../../genoffice/apps/docs/src/preload/mcode-view'
import { registerDocsIpc, MCODE_NATIVE_DOCS_CHANNELS } from '../../../../genoffice/apps/docs/src/main/mcode-ipc'

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
  for (const key of ['openDocx', 'openDocxDecrypt', 'saveDocxTo', 'saveDocxAs',
    'pickAttachments', 'copyImageToClipboard', 'aiChat', 'aiStream',
    'kbRead', 'readAttachment', 'getPathForFile', 'projectApi'] as const) {
    check('high-risk API omitted: ' + key, !(key in api))
  }
  for (const ch of ['docs:open', 'docs:save-as', 'docs:save-to', 'docs:open-decrypt',
    'docs:copy-image-to-clipboard', 'files:pick', 'ai:stream', 'project:appendChat'] as const) {
    check('dangerous channel not whitelisted: ' + ch, !(ch in policy))
  }
  check('default channel strategy does not route unknown channels',
    Object.keys(policy).length === 11 && Object.isFrozen(policy))

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
  const stopDirty = api.onCloseCheck(() => {})
  check('close-check maps to Mcode host', listeners.has('mcode:document-view:close-check'))
  stopDirty()
  api.reportCloseCheck({ dirty: 'true' })
  check('close-check cannot spoof dirty via truthy string', last().channel === 'mcode:document-view:close-check-result' && (last().args[0] as {dirty: boolean}).dirty === false)
  check('auto-save default follows native ABI', (await api.getAutoSaveDefault()).on === true)

  // Native main registrar: no global docs:* handlers. Sender authorization
  // is mandatory at every invocation including mutations.
  const handlers = new Map<string, (event: unknown, raw?: unknown) => unknown>()
  const removed: string[] = []
  const fakeIpc = {
    handle: (ch: string, fn: (event: unknown, raw?: unknown) => unknown) => { handlers.set(ch, fn) },
    removeHandler: (ch: string) => { handlers.delete(ch); removed.push(ch) },
  }
  const dispose = registerDocsIpc(fakeIpc as never, (sender) => sender === approved)
  check('only three native scoped handlers installed', handlers.size === 3 && MCODE_NATIVE_DOCS_CHANNELS.every((ch) => handlers.has(ch)))
  const spell = {
    availableSpellCheckerLanguages: ['en-US', 'zh-CN'],
    active: ['en-US'],
    getSpellCheckerLanguages() { return this.active },
    setSpellCheckerLanguages(next: string[]) { this.active = next },
  }
  const approved = { session: spell }
  const forged = { session: spell }
  const invoke = (ch: string, sender: unknown, raw?: unknown): unknown =>
    handlers.get(ch)!({ sender }, raw)
  check('unauthorized font read denied', invoke('mcode:docs:native-font-metrics', forged, 'Arial') === null)
  check('authorized native font engine used', (invoke('mcode:docs:native-font-metrics', approved, 'Arial') as { inspectedFamily: string }).inspectedFamily === 'Arial')
  check('oversized font name rejected', invoke('mcode:docs:native-font-metrics', approved, 'a'.repeat(129)) === null)
  const before = spell.active.slice()
  invoke('mcode:docs:native-spell-set-languages', forged, ['zh-CN'])
  check('untrusted sender cannot change spell session', spell.active.join() === before.join())
  invoke('mcode:docs:native-spell-set-languages', approved, ['invalid', 'zh-CN'])
  check('authorized spell language filtered to installed', spell.active.join() === 'zh-CN')
  dispose()
  check('native registrations can be released', handlers.size === 0 && removed.length === 3)
  console.log(`native-docs-boundary: ${count}/${count} PASS`)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
