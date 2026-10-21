/** T05c host→RuntimeManager actual production adapter, three fake SDK ids. */
import { docsAiPorts } from '../../src/main/document/docsAiPorts'
import { calls, targetSession, events } from './stubs/nativeAiMcode'

let tests = 0
function check(label: string, condition: unknown) {
  tests++
  if (!condition) throw Error('FAIL: ' + label)
  console.log('  ok  ' + label)
}
async function main() {
  const context = { sessionId: 'session-1', filePath: 'C:/sandbox/doc.docx' }
  for (const providerId of ['claude-sdk','pi-sdk','codex-sdk']) {
    targetSession.providerId = providerId
    const d = docsAiPorts.describe(context)
    check('Mcode session selects exact three SDKs: ' + providerId,
      d.ok && d.provider === providerId)
    const chunks: Array<{type:string;text?:string}> = []
    await docsAiPorts.run({
      context, requestId: 'id-' + providerId, system: 'editor instructions',
      messages: [{role:'user',content:'selected paragraph'}],
    }, (chunk) => chunks.push(chunk), new AbortController().signal)
    check('real Docs host adapter dispatched through RuntimeManager.sendTurn: ' + providerId,
      calls.at(-1)?.providerId === providerId && calls.at(-1)?.prompt.includes('selected paragraph'))
    check('Mcode RuntimeManager streamed tokens back to native panel: ' + providerId,
      chunks.some((c)=>c.type === 'delta' && c.text === 'native-' + providerId) &&
      chunks.at(-1)?.type === 'done')
    check('same Mcode conversation receives user message: ' + providerId,
      JSON.stringify(calls.at(-1)?.userMessage).includes('selected paragraph'))
    check('unsubscribe prevents stray future turn data: ' + providerId, events.size === 0)
  }
  const before = calls.length
  targetSession.providerId = 'genspark'
  check('vendor cloud provider is not eligible for Mcode SDK selection', !docsAiPorts.describe(context).ok)
  const foreign = { sessionId: 'session-1', filePath: 'C:/not-this-project/secret.docx' }
  check('workspace mismatch is refused before SDK dispatch', !docsAiPorts.describe(foreign).ok)
  try { await docsAiPorts.run({
    context: foreign, requestId:'bad', messages:[{role:'user',content:'secret'}],
  }, () => { throw Error('must not get chunks') }, new AbortController().signal); throw Error('unexpected approval') }
  catch (err) { check('Mcode SDK never called for foreign document', calls.length === before && /工作区/.test(String(err))) }
  console.log('native-mcode-docs-ai-sdk: ' + tests + '/' + tests + ' PASS')
}
main().catch((err) => { console.error(err); process.exitCode = 1 })
