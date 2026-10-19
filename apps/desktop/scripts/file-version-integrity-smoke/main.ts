import { fileContentVersion } from '../../src/main/lib/fileVersion.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

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
  const large = Buffer.alloc(4 * 1024 * 1024, 79);
  writeFileSync(existing, large);
  check('multi-megabyte version remains same raw-byte SHA256',
    await fileContentVersion(existing) === createHash('sha256').update(large).digest('hex'));
  const source = readFileSync(resolve('src/main/lib/fileVersion.ts'), 'utf8');
  check('file version hashing must stream rather than read all bytes into RAM',
    source.includes('createReadStream(') && !source.includes('await readFile(filePath)'));
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
