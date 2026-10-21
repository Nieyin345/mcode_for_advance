/**
 * T05c mutation tests: reject a vendor cloud response in place of Mcode's
 * actual three-SDK dispatch, and reject bypassing each-turn approval.
 * Restore byte-for-byte even when smoke fails. Uses isolated smoke datasets.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const source = join(root, 'genoffice/apps/docs/src/main/mcode-ai.ts')
const original = readFileSync(source)
const content = original.toString('utf8')
const variants = [
  {
    name: 'vendor-cloud-instead-of-Mcode-SDK',
    needle: 'await authority.ports.run(request, send, controller.signal)',
    replacement: "send({ requestId, type: 'delta', text: 'vendor-cloud-response' }); send({ requestId, type: 'done' })",
    red: 'T05c approved stream uses Mcode-selected session',
  },
  {
    name: 'skip-dangerous-approval',
    needle: 'if (!await authority.ports.confirm(authority.context, true)) {',
    replacement: 'if (false) { // MUTATION: skip user confirmation',
    red: 'T05c no approval means no SDK dispatch',
  },
]
for (const v of variants) {
  if (!readFileSync(source).equals(original)) throw Error('T05c source changed before mutation')
  if (content.split(v.needle).length !== 2) throw Error('T05c mutation site ambiguous: ' + v.name)
  const patched = Buffer.from(content.replace(v.needle, v.replacement))
  let red = false
  try {
    writeFileSync(source, patched)
    const run = spawnSync(process.execPath, [
      'apps/desktop/scripts/run-smokes.mjs', 'document-view-host-smoke',
    ], { cwd:root, encoding:'utf8', timeout:240000, maxBuffer:10*1024*1024 })
    const output = (run.stdout ?? '') + (run.stderr ?? '')
    red = run.status !== 0 && output.includes('FAIL  document-view-host-smoke') && output.includes(v.red)
    console.log(v.name, {exit:run.status, expectedRed:red})
    if (!red) console.error(output.slice(-2500))
  } finally {
    if (!readFileSync(source).equals(patched)) throw Error('Concurrent edit detected; refusing to overwrite')
    writeFileSync(source, original)
    if (!readFileSync(source).equals(original)) throw Error('mutation byte restore failed')
  }
  if (!red) process.exitCode = 1
}
