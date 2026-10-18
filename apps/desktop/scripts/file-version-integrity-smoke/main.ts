import { fileContentVersion } from '../../src/main/lib/fileVersion.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mcode-revision-smoke-'));
let good = 0, bad = 0;
function check(label: string, success: boolean) { console.log(`${success ? 'PASS' : 'FAIL'} ${label}`); if (success) good++; else bad++; }
try {
  const absent = join(root, 'missing.docx');
  check('missing file returns null', await fileContentVersion(absent) === null);
  const existing = join(root, 'file.docx');
  writeFileSync(existing, Buffer.alloc(0));
  check('existing empty file has SHA256', await fileContentVersion(existing) === createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  const bytes = Buffer.from([0, 255, 34, 13]);
  writeFileSync(existing, bytes);
  check('existing bytes have SHA256', await fileContentVersion(existing) === createHash('sha256').update(bytes).digest('hex'));
  const directory = join(root, 'directory.docx');
  mkdirSync(directory);
  let threw = false;
  try { await fileContentVersion(directory); } catch (error) { threw = (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  check('directory read errors must not be interpreted as missing', threw);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`file-version-integrity-smoke: ${good}/${good + bad}`);
if (bad) process.exitCode = 1;
