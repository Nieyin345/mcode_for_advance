/**
 * T05b source-level mutation proofs. Mutations run only on the scoped vendor
 * implementation, one at a time. Restore byte-for-byte, refusing to clobber
 * any concurrent change. All smoke data is isolated by run-smokes.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const base = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const source = join(base, 'genoffice/apps/docs/src/main/mcode-privileged.ts')
const original = readFileSync(source)
const text = original.toString('utf8')
const cases = [
  {
    name: 'fence',
    old: 'if (!within(realRoot, physical)) return null',
    replacement: 'if (false) return null /* mutation: bypass physical fence */',
    expected: 'T05b save-image-as outside root denied with reason',
  },
  {
    name: 'print',
    old: "if (!await ports.confirmPrint().catch(() => false)) return denied('print was not confirmed by the user')",
    replacement: "if (false) return denied('print was not confirmed by the user') /* mutation: bypass confirmation */",
    expected: 'T05b no print unless user confirms each call',
  },
]
for (const variant of cases) {
  if (!readFileSync(source).equals(original)) throw Error('source changed before mutation; refusing to overwrite')
  if (text.split(variant.old).length !== 2) throw Error('mutation site not unique: ' + variant.name)
  const patched = Buffer.from(text.replace(variant.old, variant.replacement))
  let red = false
  try {
    writeFileSync(source, patched)
    const trial = spawnSync(process.execPath, [
      'apps/desktop/scripts/run-smokes.mjs', 'document-view-host-smoke',
    ], { cwd: base, encoding: 'utf8', timeout: 220000, maxBuffer: 10 * 1024 * 1024 })
    const combined = (trial.stdout ?? '') + (trial.stderr ?? '')
    red = trial.status !== 0 && combined.includes('FAIL  document-view-host-smoke')
    console.log(variant.name, { exit: trial.status, expectedRed: red, seen: combined.includes(variant.expected) })
    if (!red || !combined.includes(variant.expected)) console.error(combined.slice(-2500))
    red &&= combined.includes(variant.expected)
  } finally {
    if (!readFileSync(source).equals(patched)) {
      throw Error('Concurrent source edit during mutation; original saved only in executing process, not overwriting')
    }
    writeFileSync(source, original)
    if (!readFileSync(source).equals(original)) throw Error('byte restore did not match original')
  }
  if (!red) process.exitCode = 1
}
