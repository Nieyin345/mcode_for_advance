import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(desktop, '../..');
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp/module-workflow-verify-'));
console.log(`Verification evidence: ${dir}`);
const checks = [
  ['contracts-typecheck', process.execPath, [join(repo, 'packages/contracts/node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'packages/contracts/tsconfig.json', '--pretty', 'false']],
  ['desktop-typecheck', process.execPath, [join(desktop, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'apps/desktop/tsconfig.json', '--pretty', 'false']],
  ['owned-diff-check', 'git', ['diff', '--check', '--', 'apps/desktop/src/main/orchestration/executionEngine.ts', 'apps/desktop/src/main/orchestration/runner.ts', 'apps/desktop/src/main/orchestration/scheduler.ts', 'apps/desktop/src/main/orchestration/nodeTypes.ts', 'apps/desktop/scripts/module-workflow-smoke', 'examples/workflows/module-file-inspect.json', 'docs/parallel-ui-modules/task-05.md']],
];
const records = [];
for (const [name, command, args] of checks) {
  console.log(`START ${name}`);
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(dir, name + '.log'), output);
  records.push({ name, command, args, exitCode: result.status ?? 1, signal: result.signal, error: result.error?.message });
  writeFileSync(join(dir, 'result.json'), JSON.stringify(records, null, 2));
  process.stdout.write(output); console.log(`END ${name}: exit ${result.status ?? 1}`);
}
process.exitCode = records.some(record => record.exitCode !== 0) ? 1 : 0;
