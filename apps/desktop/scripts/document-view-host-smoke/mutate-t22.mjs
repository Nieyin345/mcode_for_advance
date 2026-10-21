/**
 * T22 mutation proof: run only when no other AI is editing the vendor module.
 * Every variant changes one trusted boundary, checks the exact red assertion,
 * and restores the original bytes before the next variant.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const source = join(root, 'genoffice/apps/docs/src/main/mcode-privileged.ts')
const original = readFileSync(source)
const baseline = original.toString('utf8')
const variants = [
  {
    name: 'exportPdf-workspace-fence',
    needle: "!fenced(ports, target, true) || extname(target).toLowerCase() !== '.pdf'",
    replacement: "false || extname(target).toLowerCase() !== '.pdf' /* MUTATION: export PDF gate removed */",
    assertion: 'T22 exportPdf disallows picker-selected path outside workspace before printing',
  },
  {
    name: 'network-image-denial',
    needle: "return denied(err instanceof Error ? err.message : 'Mcode network image download denied')",
    replacement: "return {ok:true,path:'MUTATION_NETWORK_BYPASS'} /* MUTATION: denied HTTP image accepted */",
    assertion: 'T22 http(s) defaults to readable denial',
  },
]
for (const variant of variants) {
  if (!readFileSync(source).equals(original)) throw Error('concurrent vendor change detected before mutation')
  if (baseline.split(variant.needle).length !== 2) throw Error('mutation site not unique: ' + variant.name)
  const changed = Buffer.from(baseline.replace(variant.needle, variant.replacement))
  let caught = false
  try {
    writeFileSync(source, changed)
    if (!readFileSync(source).equals(changed)) throw Error('mutation did not land')
    const trial = spawnSync(process.execPath, [
      'apps/desktop/scripts/run-smokes.mjs', 'document-view-host-smoke',
    ], { cwd: root, encoding: 'utf8', timeout: 230000, maxBuffer: 16 * 1024 * 1024 })
    const log = (trial.stdout ?? '') + (trial.stderr ?? '')
    caught = trial.status !== 0 && log.includes(variant.assertion) &&
      log.includes('FAIL  document-view-host-smoke')
    console.log('T22 MUTATION', variant.name, 'detected=', caught, 'suiteExit=', trial.status)
    if (!caught) console.error(log.slice(-3800))
  } finally {
    if (!readFileSync(source).equals(changed)) {
      throw Error('concurrent write during mutation; refusing to overwrite vendor source')
    }
    writeFileSync(source, original)
    if (!readFileSync(source).equals(original)) throw Error('source byte restore mismatch')
  }
  if (!caught) process.exitCode = 1
}
