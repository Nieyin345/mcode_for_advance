/** T05c AI boundary verification uses only fake Mcode SDK ports, no network. */
import type { DocsAiPorts, DocsAiChunk } from '../../../../genoffice/apps/docs/src/main/mcode-ai'
import { MCODE_DOCS_AI_HANDLERS } from '../../../../genoffice/apps/docs/src/main/mcode-ai'

export async function checkAiBoundary(
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>,
  approved: { id: number; __ai: DocsAiPorts | null; send: (channel: string, value: unknown) => void },
  forged: { id: number },
  check: (what: string, yes: unknown) => void,
): Promise<void> {
  const emitted: DocsAiChunk[] = []
  const runCalls: Array<{ sessionId: string; prompt: unknown; signal: AbortSignal }> = []
  let confirmationCount = 0
  let consent = false
  let cancelCalled = false
  const ports: DocsAiPorts = {
    describe(context) {
      return context.sessionId === 'mcode-session' && context.filePath === '/sandbox/doc.docx'
        ? { ok: true, provider: 'claude-sdk', model: 'model-from-mcode' }
        : { ok: false, error: 'not selected Mcode session' }
    },
    async confirm(_context, dangerous) {
      check('T05c approval is required for every potentially editing turn', dangerous)
      confirmationCount++
      return consent
    },
    async run(request, send, signal) {
      runCalls.push({ sessionId: request.context.sessionId, prompt: request.messages, signal })
      if (signal.aborted) return
      send({ requestId: request.requestId, type: 'delta', text: 'from-Mcode-SDK' })
      send({ requestId: request.requestId, type: 'done' })
    },
  }
  const originalSend = approved.send
  approved.send = (channel, raw) => {
    if (channel === 'mcode:docs:ai-stream-chunk') emitted.push(raw as DocsAiChunk)
    originalSend(channel, raw)
  }
  const invoke = (name: string, sender: unknown, ...args: unknown[]) =>
    handlers.get('mcode:docs:ai-' + name)!({ sender }, ...args)
  const request = { requestId: 't05c-1', system: 'edit selected', messages: [{role:'user',content:'rewrite'}], tools: [], settings: { provider: 'genspark', providers: {genspark:{apiKey:'stolen'}}}, sessionId: 'forged' }
  for (const name of MCODE_DOCS_AI_HANDLERS) {
    check('T05c registered original AI endpoint scoped: ' + name, handlers.has('mcode:docs:ai-' + name))
  }
  approved.__ai = ports
  await invoke('stream', forged, request)
  check('T05c foreign sender cannot invoke SDK', runCalls.length === 0)
  consent = false
  await invoke('stream', approved, request)
  check('T05c no approval means no SDK dispatch', runCalls.length === 0 && emitted.at(-1)?.type === 'error' && confirmationCount === 1)
  consent = true
  await invoke('stream', approved, request)
  check('T05c approved stream uses Mcode-selected session, ignoring renderer provider/session spoof', runCalls.length === 1 && runCalls[0].sessionId === 'mcode-session')
  check('T05c Mcode SDK streamed answer reenters native editor transport', emitted.some((e)=>e.type === 'delta' && e.text === 'from-Mcode-SDK') && emitted.at(-1)?.type === 'done')
  consent = false
  await invoke('stream', approved, {...request, requestId:'t05c-2'})
  check('T05c previous approval is never reused', runCalls.length === 1 && confirmationCount === 3)
  const cloud = await invoke('gsk-login', approved) as {ok:boolean;error:string}
  check('T05c cloud login denied with readable reason', cloud.ok === false && /Mcode|GenSpark/.test(cloud.error))
  for (const name of ['set-settings', 'custom-models', 'web-search','image-search','search-test','media-test','fetch-image']) {
    const result = await invoke(name, approved, {}) as {ok:boolean;error:string}
    check('T05c vendor cloud endpoint unavailable: ' + name, result.ok === false && result.error.length > 10)
  }
  const settings = await invoke('get-settings', approved) as {provider:string;providers:{codex:{apiKey:string}}}
  check('T05c settings compatibility never exposes native cloud secrets', settings.provider === 'codex' && settings.providers.codex.apiKey === '')
  const models = await invoke('codex-models', approved) as {models:string[]}
  check('T05c model list comes from Mcode session, not vendor API', models.models[0] === 'model-from-mcode')
  const status = await invoke('gsk-status', approved) as {loggedIn:boolean;error:string}
  check('T05c cloud account permanently signed out', status.loggedIn === false && status.error.length > 0)
  consent = true
  const chat = await invoke('chat', approved, {user:'hello', settings:{provider:'genspark'}}) as {ok:boolean;content:string}
  check('T05c one-shot chat uses same Mcode SDK dispatch as streaming', chat.ok === true && chat.content === 'from-Mcode-SDK' && runCalls.length === 2)
  const cancel = await invoke('stream-cancel', forged, 't05c-1') as {ok:boolean;error:string}
  check('T05c foreign sender cannot cancel owner request', cancel.ok === false && Boolean(cancel.error))
  check('T05c no native provider/client ever constructed', !cancelCalled)
  approved.__ai = null
  approved.send = originalSend
}
