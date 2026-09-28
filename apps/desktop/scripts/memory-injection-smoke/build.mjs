import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const source = dirname(fileURLToPath(import.meta.url)), desktop = resolve(source, '../..');
const pnpm = resolve(desktop, '../../node_modules/.pnpm');
const packageDir = readdirSync(pnpm).filter(n => n.startsWith('esbuild@')).sort().at(-1);
if (!packageDir) throw Error('Installed esbuild is required; dependencies are never installed by this suite');
const esbuild = await import(pathToFileURL(join(pnpm, packageDir, 'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp/memory-injection-'));
const home = join(dir, 'home'), data = join(dir, 'data');
mkdirSync(home); mkdirSync(data);
const aliases = {
  '@main/lib/dataRoot.js': join(source, 'stubs/dataRoot.ts'),
  '@main/lib/logger.js': join(desktop, 'scripts/run-store-smoke/stubs/logger.ts'),
  '@main/store/repositories.js': join(source, 'stubs/repositories.ts'),
  '@main/plugins/pluginManager.js': join(desktop, 'scripts/memory-smoke/stubs/pluginManager.ts'),
  '@main/workflows/seed.js': join(desktop, 'scripts/library-delete-smoke/stubs/workflowsSeed.ts'),
};
await esbuild.build({ entryPoints: [join(source, 'main.ts')], bundle: true, platform: 'node', format: 'esm',
  tsconfig: join(desktop, 'tsconfig.json'), absWorkingDir: desktop, alias: aliases, external: ['typescript'],
  banner: { js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);" },
  outfile: join(dir, 'main.mjs'), logLevel: 'error' });
const paths = ['src/main/memory/retrieval.ts', 'src/main/orchestration/nodeInputBuilders.ts', 'src/main/orchestration/runner.ts'];
writeFileSync(join(dir, 'sources.json'), JSON.stringify(Object.fromEntries(paths.map(p => [p, createHash('sha256').update(readFileSync(join(desktop, p))).digest('hex')])), null, 2));
console.log('Memory injection artifacts: ' + dir);
const result = spawnSync(process.execPath, [join(dir, 'main.mjs')], { cwd: desktop, encoding: 'utf8',
  env: { ...process.env, HOME: home, USERPROFILE: home, MCODE_SMOKE_DATA_ROOT: data, MEMORY_INJECTION_ARTIFACTS: dir } });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
process.exitCode = result.status === 0 && !result.signal ? 0 : 1;
