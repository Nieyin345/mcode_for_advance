import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.ok(existsSync(join(desktop, 'src/main/modules/fileCapabilities.ts')), 'Use the production module capability implementation');
const pnpm = resolve(desktop, '../../node_modules/.pnpm');
const pkg = readdirSync(pnpm).find(name => name.startsWith('esbuild@'));
if (!pkg) throw Error('Installed esbuild is required');
const { build } = await import(pathToFileURL(join(pnpm, pkg, 'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp/maint-m31-'));
await build({
  entryPoints: [join(desktop, 'scripts/maint-m31-smoke/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(dir, 'test.mjs'),
  tsconfig: join(desktop, 'tsconfig.json'),
  alias: {
    '@main/lib/dataRoot.js': join(desktop, 'scripts/maint-m31-smoke/stubs/dataRoot.ts'),
    '@main/store/repositories.js': join(desktop, 'scripts/maint-m31-smoke/stubs/repositories.ts'),
  },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const result = spawnSync(process.execPath, [join(dir, 'test.mjs')], {
  encoding: 'utf8',
  timeout: 20_000,
  env: {
    ...process.env,
    M31_TEST_ROOT: dir,
    M31_TEST_DATA_ROOT: join(dir, 'data'),
    M31_TEST_PROJECT_ALIAS: join(dir, 'project-alias'),
  },
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
const log = (result.stdout || '') + (result.stderr || '');
writeFileSync(join(dir, 'output.log'), log);
writeFileSync(join(dir, 'result.json'), JSON.stringify({
  exitCode: result.status ?? 1,
  signal: result.signal,
  error: result.error?.message,
  log: join(dir, 'output.log'),
}, null, 2));
console.log(`M31 smoke log: ${join(dir, 'output.log')}`);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
