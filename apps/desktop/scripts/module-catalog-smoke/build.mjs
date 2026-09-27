import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.ok(existsSync(join(desktop, 'src/main/modules/ModuleHost.ts')), 'Real module host required');
const pnpm = resolve(desktop, '../../node_modules/.pnpm');
const pkg = readdirSync(pnpm).find(name => name.startsWith('esbuild@'));
if (!pkg) throw Error('Installed esbuild required; do not use a test-only host substitute');
const { build } = await import(pathToFileURL(join(pnpm, pkg, 'node_modules/esbuild/lib/main.js')).href);

mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp/module-catalog-'));
await build({
  entryPoints: [join(desktop, 'scripts/module-catalog-smoke/main.ts')],
  bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'test.mjs'), tsconfig: join(desktop, 'tsconfig.json'),
  alias: {
    '@main/lib/dataRoot.js': join(desktop, 'scripts/module-catalog-smoke/stubs/dataRoot.ts'),
    '@main/lib/pathGuard.js': join(desktop, 'scripts/module-catalog-smoke/stubs/pathGuard.ts'),
  },
  banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
});
const result = spawnSync(process.execPath, [join(dir, 'test.mjs')], {
  encoding: 'utf8',
  env: {
    ...process.env,
    MODULE_CATALOG_TEST_DATA_ROOT: join(dir, 'data'),
    MODULE_CATALOG_TEST_WORKSPACE: join(dir, 'workspace'),
    MODULE_CATALOG_TEST_OUTSIDE: join(dir, 'outside'),
  },
});
const log = (result.stdout || '') + (result.stderr || '');
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
writeFileSync(join(dir, 'output.log'), log);
writeFileSync(join(dir, 'result.json'), JSON.stringify({ exitCode: result.status ?? 1, signal: result.signal, error: result.error?.message, log: join(dir, 'output.log') }, null, 2));
console.log(`Module catalog smoke log: ${join(dir, 'output.log')}`);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
