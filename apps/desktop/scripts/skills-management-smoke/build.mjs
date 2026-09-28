import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(source, '../..');
const pnpm = resolve(desktop, '../../node_modules/.pnpm');
const installed = readdirSync(pnpm).filter(n => n.startsWith('esbuild@')).sort().at(-1);
if (!installed) throw Error('Installed esbuild is required; this test never installs dependencies.');
const esbuild = await import(pathToFileURL(join(pnpm, installed, 'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp/skills-management-'));
const home = join(dir, 'home');
mkdirSync(home);
console.log('Skills management artifacts: ' + dir);
const paths = ['src/main/ipc/skills.ts', 'src/main/lib/skillEngines.ts', '../../packages/contracts/src/ipc/skills.ts'];
writeFileSync(join(dir, 'sources.json'), JSON.stringify(Object.fromEntries(paths.map(p => [p, createHash('sha256').update(readFileSync(resolve(desktop, p))).digest('hex')])), null, 2));
await esbuild.build({
  entryPoints: [join(source, 'main.ts')], bundle: true, platform: 'node', format: 'esm',
  tsconfig: join(desktop, 'tsconfig.json'), absWorkingDir: desktop,
  banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
  alias: {
    '@main/lib/logger.js': join(desktop, 'scripts/run-store-smoke/stubs/logger.ts'),
    '@main/plugins/pluginManager.js': join(source, 'stubs/pluginManager.ts'),
    '@main/store/repositories.js': join(source, 'stubs/repositories.ts'),
    'electron': join(desktop, 'scripts/library-delete-smoke/stubs/electron.ts'),
  },
  outfile: join(dir, 'main.mjs'), logLevel: 'error',
});
const child = spawnSync(process.execPath, [join(dir, 'main.mjs')], {
  cwd: desktop, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, HOME: home, USERPROFILE: home, MCODE_SKILLS_SMOKE_HOME: home, MCODE_SKILLS_SMOKE_ARTIFACTS: dir },
});
writeFileSync(join(dir, 'stdout.log'), child.stdout ?? '');
writeFileSync(join(dir, 'stderr.log'), child.stderr ?? '');
process.stdout.write(child.stdout ?? '');
process.stderr.write(child.stderr ?? '');
const code = child.error || child.status !== 0 ? 1 : 0;
writeFileSync(join(dir, 'exit.json'), JSON.stringify({ exitCode: child.status, error: child.error?.message ?? null, verifierExitCode: code }, null, 2));
process.exitCode = code;
