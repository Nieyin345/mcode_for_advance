/** Isolated real-path and host-boundary regression: no user data or provider calls. */
import assert from 'node:assert/strict';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isKnownWorkspaceRoot } from '../../src/main/lib/pathGuard.js';
import { resolveModuleResource } from '../../src/main/modules/fileCapabilities.js';
import { getModuleHost } from '../../src/main/modules/service.js';
import { EXAMPLE_MODULE } from '@contracts/modules';

const root = process.env.M31_TEST_ROOT;
const dataRoot = process.env.M31_TEST_DATA_ROOT;
const projectAlias = process.env.M31_TEST_PROJECT_ALIAS;
assert.ok(root && dataRoot && projectAlias, 'Isolated test paths are required');
const library = join(dataRoot, 'library');
const docs = join(root, 'relocated-documents');
const nested = join(docs, 'notes');
const internal = join(dataRoot, 'internal');
const escape = join(library, 'escaped-root');
const project = join(root, 'actual-project');
const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
for (const dir of [dataRoot, docs, nested, internal, project]) await mkdir(dir, { recursive: true });
await writeFile(join(docs, 'public.txt'), 'Visible library note');
await writeFile(join(nested, 'child.txt'), 'Visible nested note');
await writeFile(join(internal, 'private.txt'), 'Internal app-state sentinel');
await writeFile(join(project, 'project.txt'), 'Explicit project root');
await symlink(docs, library, linkKind);
await symlink(dataRoot, join(docs, 'escaped-root'), linkKind);
await symlink(project, projectAlias, linkKind);
const leakedPath = join(escape, 'internal', 'private.txt');
const leaked = { projectPath: escape, path: leakedPath };
const host = await getModuleHost();
let passed = 0, failed = 0;
async function test(name: string, run: () => unknown): Promise<void> {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + String(error)); }
}
const call = (moduleId: string, contributionId: string, projectPath: string, path: string, requestId: string) => ({
  moduleId, contributionId, resource: { projectPath, path }, requestId,
});
await test('the real workspace guard admits a lexical library child, not the canonical private root', () => {
  assert.equal(isKnownWorkspaceRoot(escape), true);
  assert.equal(isKnownWorkspaceRoot(dataRoot), false);
  assert.equal(isKnownWorkspaceRoot(projectAlias), true);
});
await test('root symlink outside authorized documents cannot be promoted to a workspace', async () => {
  assert.equal(await realpath(escape), await realpath(dataRoot));
  await assert.rejects(resolveModuleResource(leaked, isKnownWorkspaceRoot), /workspace|outside|root/i);
});
await test('production workflow query rejects an implicitly trusted symlink-root escape', async () => {
  await assert.rejects(host.invokeForWorkflow(call('core.file-report', 'info', escape, leakedPath, 'wf-escape')), /workspace|outside|root/i);
});
await test('imported menu module cannot use the same symlink root to read app state', async () => {
  await host.install(EXAMPLE_MODULE);
  await assert.rejects(host.invoke(call(EXAMPLE_MODULE.id, 'inspect', escape, leakedPath, 'menu-escape')), /workspace|outside|root/i);
  assert.ok(host.catalog().workflowTargets?.every(target => target.moduleId !== EXAMPLE_MODULE.id));
});
await test('explicitly relocated library and its nested documents remain usable', async () => {
  for (const [workspace, path, bytes] of [
    [library, join(library, 'public.txt'), Buffer.byteLength('Visible library note')],
    [join(library, 'notes'), join(library, 'notes', 'child.txt'), Buffer.byteLength('Visible nested note')],
  ] as const) {
    const reply = await host.invokeForWorkflow(call('core.file-report', 'info', workspace, path, 'allowed-library'));
    assert.equal(reply.type, 'result');
    if (reply.type === 'result') assert.equal(reply.value.bytes, bytes);
  }
});
await test('registered project root through an explicit junction remains usable', async () => {
  const reply = await host.invokeForWorkflow(call('core.file-report', 'info', projectAlias, join(projectAlias, 'project.txt'), 'allowed-project'));
  assert.equal(reply.type, 'result');
  if (reply.type === 'result') assert.equal(reply.value.bytes, Buffer.byteLength('Explicit project root'));
});
await test('a file symlink leaving a legitimate root remains denied', async () => {
  // Use a directory junction on Windows, where creating a file symlink needs
  // developer privileges; the target is still a regular file outside the root.
  await symlink(internal, join(docs, 'external-directory'), linkKind);
  await assert.rejects(host.invokeForWorkflow(call('core.file-report', 'info', library, join(library, 'external-directory', 'private.txt'), 'file-escape')), /workspace|outside|root/i);
});
await test('uninstall cancels its running task and removes only its menu contribution', async () => {
  const { ModuleHost } = await import('../../src/main/modules/ModuleHost.js');
  const { ResourceSchema, ResultSchema } = await import('@contracts/modules');
  let finish!: (result: { bytes: number }) => void;
  const isolated = new ModuleHost({ authorize: async () => {}, persist: async () => {} });
  isolated.register({ id: 'core.test.pending', kind: 'task', input: ResourceSchema, output: ResultSchema,
    run: async () => new Promise(resolve => { finish = resolve; }) });
  await isolated.install({ ...EXAMPLE_MODULE, contributions: [{ ...EXAMPLE_MODULE.contributions[0], capability: 'core.test.pending' }] });
  const reply = await isolated.invoke(call(EXAMPLE_MODULE.id, 'inspect', projectAlias, join(projectAlias, 'project.txt'), 'pending'));
  assert.equal(reply.type, 'task');
  if (reply.type !== 'task') return;
  await isolated.remove(EXAMPLE_MODULE.id);
  assert.equal(isolated.task({ moduleId: EXAMPLE_MODULE.id, taskId: reply.task.id }).status, 'cancelled');
  finish({ bytes: 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(isolated.task({ moduleId: EXAMPLE_MODULE.id, taskId: reply.task.id }).status, 'cancelled');
  assert.equal(isolated.catalog().modules.some(module => module.id === EXAMPLE_MODULE.id), false);
  assert.equal(isolated.tasks({ projectPath: projectAlias }).length, 1);
});
console.log(`${passed} M31 checks passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
