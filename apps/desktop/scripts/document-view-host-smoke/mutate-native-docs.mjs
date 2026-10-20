/**
 * ARC-007 genuine mutation proof: remove the vendor 'docs:save' permission,
 * require a RED document-view-host-smoke, and restore the exact original bytes.
 * Execute only when no other test/edit touches the vendor mcode-view.ts.
 */
import { copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const suite = dirname(fileURLToPath(import.meta.url))
const root = resolve(suite, '../../../..')
const source = join(root, 'genoffice/apps/docs/src/preload/mcode-view.ts')
const backup = join(suite, '.nativeDocs-mutation-backup')
const gitBash = 'C:/Program Files/Git/bin/bash.exe'
const cmp = 'C:/Program Files/Git/usr/bin/cmp.exe'
const original = readFileSync(source)
const needle = "  'docs:save': { kind: 'invoke', to: 'mcode:document-view:save' },"
const src = original.toString('utf8')
if (src.split(needle).length !== 2 || existsSync(backup)) throw Error('ambiguous mutation site or stale backup')
let red = false
let restored = false
try {
  copyFileSync(source, backup)
  const mutated = src.replace(needle, "  // MUTATION: removed docs:save guarded route")
  writeFileSync(source, mutated)
  if (readFileSync(source).equals(original)) throw Error('mutation did not take')
  const run = spawnSync(gitBash, ['scripts/document-view-host-smoke/run.sh'], {
    cwd: join(root, 'apps/desktop'), encoding: 'utf8', timeout: 180000, maxBuffer: 12 * 1024 * 1024,
  })
  red = run.status !== 0 &&
    ((run.stdout ?? '') + (run.stderr ?? '')).includes('FAIL: default channel strategy does not route unknown channels')
  console.log(`MUTATION: status=${run.status} expected_policy_red=${red}`)
  if (!red) console.error(((run.stdout ?? '') + (run.stderr ?? '')).slice(-2500))
} finally {
  if (existsSync(backup)) {
    copyFileSync(backup, source)
    if (existsSync(cmp)) restored = spawnSync(cmp, ['-s', backup, source]).status === 0
    else throw Error('cmp unavailable: byte-level restore unverified')
    rmSync(backup)
  }
}
console.log(`CMP ORIGINAL: ${restored ? 'identical' : 'DIFFERENT'}`)
if (!red || !restored) process.exitCode = 1
