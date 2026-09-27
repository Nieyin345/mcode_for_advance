import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const suite = join(desktop, 'scripts/module-workflow-smoke');
const pnpm = resolve(desktop, '../../node_modules/.pnpm');
const installed = readdirSync(pnpm).find(name => name.startsWith('esbuild@'));
if (!installed) throw new Error('Installed esbuild required; no dependency installation is permitted');
const { build } = await import(pathToFileURL(join(pnpm, installed, 'node_modules/esbuild/lib/main.js')).href);
const ts = (await import(pathToFileURL(join(desktop, 'node_modules/typescript/lib/typescript.js')).href)).default;
const baseline = process.argv.includes('--baseline');
const saveGuard = process.argv.includes('--save-guard');
const mutation = process.argv.includes('--mutation-fallback') ? 'fallback'
  : process.argv.includes('--mutation-identity') ? 'identity' : null;
const entry = join(suite, baseline ? 'baseline.ts' : saveGuard ? 'save-guard.ts' : 'main.ts');
if (!existsSync(entry)) throw new Error(`Test entry is missing: ${entry}`);
const contracts = resolve(desktop, '../../packages/contracts/src');
const nodeTypeSource = readFileSync(join(contracts, 'nodeType.ts'), 'utf8');
const nodeTypeAst = ts.createSourceFile('nodeType.ts', nodeTypeSource, ts.ScriptTarget.Latest, true);
function declaration(ast, name) {
  const matches = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (matches.length !== 1 || !matches[0].initializer) throw new Error(`Harness: expected exactly one initialized ${name}`);
  return matches[0].initializer;
}
const gateOpen = declaration(nodeTypeAst, 'IMPLEMENTED_RUNNER_KINDS').getText(nodeTypeAst).includes('module-capability');
let runnerFixture;
if (!baseline && !saveGuard) {
  const runnerSource = readFileSync(join(desktop, 'src/main/orchestration/runner.ts'), 'utf8');
  const runnerAst = ts.createSourceFile('runner.ts', runnerSource, ts.ScriptTarget.Latest, true);
  const registration = declaration(runnerAst, 'runEngine').getText(runnerAst);
  const ports = declaration(runnerAst, 'ports');
  if (!ts.isObjectLiteralExpression(ports)) throw new Error('Harness: ports must be an object literal');
  const input = ports.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(runnerAst) === 'buildInput');
  if (!input) throw new Error('Harness: runner input binding was not found');
  const kinds = declaration(runnerAst, 'executorKinds').getText(runnerAst);
  runnerFixture = `
    import { createBuiltinExecutionEngine, createWorkflowInputBuilder } from "../../src/main/orchestration/executionEngine.js";
    export function createRunnerFixture(runInConversation, runInNodeSession) { return ${registration}; }
    export function runnerInputFixture(session, runId) { return ${input.initializer.getText(runnerAst)}; }
    export function runnerKindsFixture(runEngine) { return ${kinds}; }
  `;
}
mkdirSync(join(desktop, '.tmp'), { recursive: true });
const dir = mkdtempSync(join(desktop, '.tmp/module-workflow-'));
console.log(`Module workflow evidence: ${dir}`);
const sourceHashes = {};
for (const name of ['executionEngine.ts', 'runner.ts', 'scheduler.ts', 'nodeTypes.ts', 'nodeInputBuilders.ts', 'moduleCapabilityExecutor.ts']) {
  sourceHashes[name] = createHash('sha256').update(readFileSync(join(desktop, 'src/main/orchestration', name))).digest('hex');
}
sourceHashes['contracts/nodeType.ts'] = createHash('sha256').update(nodeTypeSource).digest('hex');
const phases = baseline ? ['baseline'] : saveGuard ? ['save-guard'] : gateOpen ? ['native-open'] : ['native-closed', 'fixture-open'];
const records = [];
let combined = '';
for (const phase of phases) {
  const phaseDir = join(dir, phase); mkdirSync(phaseDir);
  const plugins = [{ name: 'test-only-extractions-and-mutations', setup(builder) {
    builder.onLoad({ filter: /runnerPath\.ts$/ }, () => {
      if (!runnerFixture) throw new Error('Harness: runner fixture was not extracted');
      return { contents: runnerFixture, loader: 'ts', resolveDir: suite };
    });
    if (phase === 'fixture-open') builder.onLoad({ filter: /[\\/]contracts[\\/]src[\\/]nodeType\.ts$/ }, args => {
      const source = readFileSync(args.path, 'utf8');
      const original = declaration(nodeTypeAst, 'IMPLEMENTED_RUNNER_KINDS').getText(nodeTypeAst);
      if (!source.includes(original)) throw new Error('Harness: gate changed during build');
      const opened = original.replace(/\]\s+as const$/, ', "module-capability"] as const');
      if (opened === original) throw new Error('Harness: cannot open the test-only gate');
      return { contents: source.replace(original, opened), loader: 'ts' };
    });
    if (mutation) builder.onLoad({ filter: /[\\/]orchestration[\\/]executionEngine\.ts$/ }, args => {
      const source = readFileSync(args.path, 'utf8');
      const before = mutation === 'fallback'
        ? '?? (kind === MODULE_CAPABILITY_RUNNER_KIND ? undefined : this.fallback)'
        : 'identity.nodeId, randomUUID()';
      const after = mutation === 'fallback' ? '?? this.fallback' : 'identity.nodeId, "fixed-dispatch"';
      if (source.split(before).length !== 2) throw new Error(`Harness: mutation target is not unique: ${mutation}`);
      return { contents: source.replace(before, after), loader: 'ts' };
    });
  } }];
  try {
    await build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'esm',
      outfile: join(phaseDir, 'test.mjs'), tsconfig: join(desktop, 'tsconfig.json'), plugins,
      alias: {
        '@main/lib/dataRoot.js': join(suite, 'stubs/dataRoot.ts'),
        '@main/lib/pathGuard.js': join(suite, 'stubs/pathGuard.ts'),
        '@main/library/groupRegistry.js': join(suite, 'stubs/catalogSources.ts'),
        '@main/plugins/pluginManager.js': join(suite, 'stubs/catalogSources.ts'),
        '@main/lib/spawnRun.js': join(suite, 'stubs/spawnRun.ts'),
        '@main/store/repositories.js': join(suite, 'stubs/repositories.ts'),
        'electron': join(suite, 'stubs/electron.ts'),
      },
      banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
    });
    const result = spawnSync(process.execPath, [join(phaseDir, 'test.mjs')], {
      cwd: desktop, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, P2_WORKFLOW_DATA_ROOT: join(phaseDir, 'data'), P2_WORKFLOW_WORKSPACE: join(phaseDir, 'workspace'), P2_WORKFLOW_EVIDENCE: phaseDir, P2_WORKFLOW_PHASE: phase },
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    combined += `\n=== ${phase} ===\n${output}`;
    writeFileSync(join(phaseDir, 'output.log'), output);
    records.push({ phase, exitCode: result.status ?? 1, signal: result.signal, error: result.error?.message });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  } catch (error) {
    records.push({ phase, exitCode: 1, harnessError: String(error) });
    combined += `HARNESS ERROR ${String(error)}\n`; console.error(error);
  }
}
writeFileSync(join(dir, 'output.log'), combined);
const exitCode = records.some(record => record.exitCode !== 0) ? 1 : 0;
writeFileSync(join(dir, 'result.json'), JSON.stringify({ baseline, saveGuard, mutation, nativeGateOpen: gateOpen, sourceHashes, records, exitCode }, null, 2));
console.log(`Module workflow log: ${join(dir, 'output.log')}`);
process.exitCode = exitCode;
