import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireOsFileLease } from '../../src/main/lib/osFileLease.js';

const root = mkdtempSync(join(tmpdir(), 'mcode-lease-health-'));
let ok = 0, bad = 0;
function check(label: string, success: boolean) { console.log(`${success ? 'PASS' : 'FAIL'} ${label}`); if (success) ok++; else bad++; }
try {
  const damaged = join(root, 'damaged.mcode-lock');
  writeFileSync(damaged, JSON.stringify({host: hostname(), pid: process.pid, token: '', createdAt: Date.now()-300000}));
  const old = new Date(Date.now()-60000);
  utimesSync(damaged, old, old);
  let reclaimed = false;
  try { const release = await acquireOsFileLease(damaged, 300); reclaimed = true; await release(); } catch {}
  check('stale invalid token is reclaimed even when pid is live', reclaimed);
  check('reclaimed lock is removed after release', !existsSync(damaged));
  const fresh = join(root, 'fresh.mcode-lock');
  writeFileSync(fresh, '{');
  let refusedFresh = false;
  try { const release = await acquireOsFileLease(fresh, 150); await release(); } catch(e) { refusedFresh = /FILE_VERSION_CONFLICT/.test(String(e)); }
  check('incomplete fresh lock is not stolen', refusedFresh && existsSync(fresh));
  const live = join(root, 'live.mcode-lock');
  writeFileSync(live, JSON.stringify({host: hostname(), pid: process.pid, token: randomUUID(), createdAt: Date.now()}));
  const unchanged = readFileSync(live, 'utf8');
  let refusedLive = false;
  try { const release = await acquireOsFileLease(live, 150); await release(); } catch(e) { refusedLive = /FILE_VERSION_CONFLICT/.test(String(e)); }
  check('valid live lock stays in place', refusedLive && readFileSync(live, 'utf8') === unchanged);
  const ordinary = join(root, 'normal.mcode-lock');
  const release = await acquireOsFileLease(ordinary, 300);
  check('normal lease acquired', existsSync(ordinary));
  await release();
  check('normal lease removed', !existsSync(ordinary));
} finally { rmSync(root, {recursive: true, force: true}); }
console.log(`os-file-lease-health-smoke: ${ok}/${ok+bad}`);
if (bad) process.exitCode = 1;
