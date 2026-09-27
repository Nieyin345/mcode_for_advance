import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXAMPLE_MODULE, ResourceSchema, ResultSchema, type ModuleInvoke, type ModuleReply, type ModuleResult } from '@contracts/modules';
import { ModuleCatalogSchema } from '@contracts/moduleCapability';
import { ModuleHost } from '../../src/main/modules/ModuleHost.js';
import { fileCapabilities, resolveModuleResource } from '../../src/main/modules/fileCapabilities.js';
import { getModuleHost } from '../../src/main/modules/service.js';
import { dataRootCalls } from './stubs/dataRoot.js';

let passed = 0;
let failed = 0;
async function test(name: string, run: () => unknown): Promise<void> {
  try {
    await run();
    passed++;
    console.log('PASS ' + name);
  } catch (error) {
    failed++;
    console.error('FAIL ' + name, error);
  }
}
async function denied(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof Error);
    assert.notEqual(error.name, 'TypeError', 'a missing method is not a valid security rejection');
    assert.match(error.message, message);
    return true;
  });
}
// A missing entry point must fail explicitly, not count TypeError as denial.
function workflow(host: ModuleHost, input: ModuleInvoke): Promise<ModuleReply> {
  const method = host.invokeForWorkflow;
  if (typeof method !== 'function') throw Error('ModuleHost.invokeForWorkflow must be implemented');
  return method.call(host, input);
}
async function settled(host: ModuleHost, moduleId: string, taskId: string) {
  for (let i = 0; i < 100; i++) {
    const task = host.task({ moduleId, taskId });
    if (task.status !== 'running') return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Task did not settle within the smoke timeout');
}

const root = process.env.MODULE_CATALOG_TEST_WORKSPACE;
const outside = process.env.MODULE_CATALOG_TEST_OUTSIDE;
assert.ok(root && outside, 'Isolated workspace paths required');
await mkdir(root);
await mkdir(outside);
const path = join(root, 'source.txt');
const secret = join(outside, 'secret.txt');
const body = 'module catalog smoke fixture\n';
await writeFile(path, body);
await writeFile(secret, 'outside the fixture workspace');
const resource = { projectPath: root, path };
const input = (moduleId: string, contributionId: string, requestId: string, file = path): ModuleInvoke =>
  ({ moduleId, contributionId, requestId, resource: { projectPath: root, path: file } });
let authorized = 0;
let persisted = 0;
const host = new ModuleHost({
  authorize: async r => { authorized++; await resolveModuleResource(r, p => p === root); },
  persist: async () => { persisted++; },
});
const definitions = fileCapabilities(p => p === root);
for (const definition of definitions) host.register(definition);
const builtin = {
  ...EXAMPLE_MODULE, id: 'core.file-report',
  contributions: [
    EXAMPLE_MODULE.contributions[0],
    { ...EXAMPLE_MODULE.contributions[0], id: 'info', capability: 'core.file.info',
      title: { zh: '文件信息', en: 'File information' },
      view: { title: { zh: '文件信息', en: 'File information' }, fields: [
        { key: 'bytes', title: { zh: '字节数', en: 'Bytes' } },
        { key: 'modifiedAt', title: { zh: '修改时间', en: 'Modified at' } },
      ] },
    },
  ],
};
host.addBuiltin(builtin);
host.restore(EXAMPLE_MODULE);

await test('real file capabilities publish accurate discoverable metadata', () => {
  const capabilities = host.catalog().capabilities;
  for (const id of ['core.file.inspect', 'core.file.info']) {
    const descriptor = capabilities.find(capability => capability.id === id);
    assert.ok(descriptor, `${id} is missing`);
    const metadata = 'metadata' in descriptor ? descriptor.metadata : undefined;
    assert.ok(metadata && typeof metadata === 'object', `${id} metadata is missing`);
    assert.match(String(metadata.version), /^\d+\.\d+\.\d+$/);
    assert.deepEqual(metadata.permissions, ['resource.read']);
    for (const key of ['title', 'description', 'inputSchema', 'outputSchema'] as const) {
      assert.ok(metadata[key] && typeof metadata[key] === 'object', `${id} is missing ${key}`);
    }
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.supportsCancellation, id === 'core.file.inspect');
    if (id === 'core.file.inspect') {
      assert.deepEqual(metadata.limits, { maxFileBytes: 32 * 1024 * 1024, taskTimeoutMs: 30_000 });
    } else {
      assert.ok(!metadata.limits || !('maxFileBytes' in metadata.limits), 'info query has no 32 MiB read limit');
      assert.ok(!metadata.limits || !('taskTimeoutMs' in metadata.limits), 'info query has no task timeout');
    }
  }
});
await test('catalog targets are derived solely from registered built-in read-only contributions', () => {
  const catalog = host.catalog();
  const targets = 'workflowTargets' in catalog ? catalog.workflowTargets : undefined;
  assert.ok(Array.isArray(targets), 'workflowTargets must be published');
  assert.deepEqual(targets, [
    { moduleId: 'core.file-report', contributionId: 'inspect', capabilityId: 'core.file.inspect' },
    { moduleId: 'core.file-report', contributionId: 'info', capabilityId: 'core.file.info' },
  ]);
  assert.equal(catalog.modules.length, 2);
  assert.ok(catalog.modules.some(m => m.id === 'user.file-report'), 'menu user module remains installed');
});
await test('the host catalog is JSON-safe and satisfies the frozen catalog schema', () => {
  const serialized = JSON.stringify(host.catalog());
  const parsed = ModuleCatalogSchema.parse(JSON.parse(serialized));
  assert.equal(parsed.capabilities.length, 2);
  assert.equal(parsed.workflowTargets?.length, 2);
  assert.equal(parsed.modules.length, 2);
});
await test('mutating metadata and targets from a catalog snapshot does not alter host state', () => {
  const snapshot = host.catalog();
  const baseline = host.catalog();
  const descriptor = snapshot.capabilities.find(c => c.id === 'core.file.inspect');
  assert.ok(descriptor && 'metadata' in descriptor && descriptor.metadata);
  const metadata = descriptor.metadata as { title: { en: string }; inputSchema: Record<string, unknown> };
  metadata.title.en = 'caller mutation';
  metadata.inputSchema.properties = { mutated: true };
  snapshot.modules[0].contributions[0].capability = 'core.invalid';
  const targets = 'workflowTargets' in snapshot ? snapshot.workflowTargets : undefined;
  assert.ok(Array.isArray(targets));
  targets[0].moduleId = 'user.file-report';
  assert.deepEqual(host.catalog(), baseline);
});
await test('duplicate capability cannot replace registered metadata or implementation', () => {
  const before = host.catalog();
  assert.throws(() => host.register(definitions[0]), /Duplicate capability/);
  assert.deepEqual(host.catalog(), before);
});
await test('registration validates bounded metadata and detaches it from the caller', () => {
  const original = definitions[0];
  const validMetadata = original.metadata;
  assert.ok(validMetadata, 'a built-in definition must include metadata');
  const callerMetadata = structuredClone(validMetadata);
  const isolated = new ModuleHost({ authorize: async () => {}, persist: async () => {} });
  isolated.register({ ...original, metadata: callerMetadata });
  const before = isolated.catalog();
  callerMetadata.title.en = 'changed after registration';
  callerMetadata.inputSchema.properties = { tampered: true };
  assert.deepEqual(isolated.catalog(), before);

  assert.throws(() => isolated.register({ ...original, id: 'core.bad-permission',
    metadata: { ...validMetadata, permissions: ['resource.write'] },
  } as unknown as typeof original), /resource.read/);
  assert.throws(() => isolated.register({ ...original, id: 'core.remote-schema',
    metadata: { ...validMetadata, inputSchema: { $ref: 'https://invalid.example/schema' } },
  }), /JSON schema|ref|URL|Invalid/i);
  assert.deepEqual(isolated.catalog(), before, 'invalid descriptors may not enter the registry');
});
await test('registered implementation cannot be swapped through a caller-held definition', async () => {
  const isolated = new ModuleHost({
    authorize: async r => { await resolveModuleResource(r, p => p === root); }, persist: async () => {},
  });
  const definition = { ...definitions[1], id: 'core.file.stable' };
  isolated.register(definition);
  isolated.addBuiltin({ ...builtin, id: 'core.stable-report', contributions: [
    { ...builtin.contributions[1], capability: definition.id },
  ] });
  definition.run = async () => ({ bytes: -123 });
  const result = await workflow(isolated, input('core.stable-report', 'info', 'stable-definition'));
  assert.equal(result.type, 'result');
  if (result.type !== 'result') throw Error('Synchronous query expected');
  assert.equal(result.value.bytes, Buffer.byteLength(body));
});
await test('metadata cannot understate host read permission or invent query cancellation/timeout', () => {
  const original = definitions[1], metadata = original.metadata;
  assert.ok(metadata);
  const isolated = new ModuleHost({ authorize: async () => {}, persist: async () => {} });
  assert.throws(() => isolated.register({ ...original, id: 'core.no-read',
    metadata: { ...metadata, permissions: [] },
  }), /resource.read/);
  assert.throws(() => isolated.register({ ...original, id: 'core.query-cancel',
    metadata: { ...metadata, supportsCancellation: true },
  }), /query|cancel/i);
  assert.throws(() => isolated.register({ ...original, id: 'core.query-timeout',
    metadata: { ...metadata, limits: { taskTimeoutMs: 30_000 } },
  }), /query|timeout/i);
  assert.deepEqual(isolated.catalog().capabilities, []);
});
await test('only actual built-ins may use core namespace; action contributions cannot become targets', async () => {
  await denied(host.install({ ...EXAMPLE_MODULE, id: 'core.forged' }), /External IDs must start with user\./);
  assert.throws(() => host.restore({ ...EXAMPLE_MODULE, id: 'core.forged' }), /Invalid persisted module ID/);
  const action = { ...definitions[0], id: 'core.file.mutate', kind: 'action' as const };
  host.register(action);
  assert.throws(() => host.addBuiltin({ ...builtin, id: 'core.action', contributions: [
    { ...EXAMPLE_MODULE.contributions[0], capability: action.id },
  ] }), /Actions require/);
  const targets = 'workflowTargets' in host.catalog() ? host.catalog().workflowTargets : undefined;
  assert.ok(Array.isArray(targets));
  assert.ok(targets.every(target => target.capabilityId !== action.id));
  assert.equal(persisted, 0, 'failed attempts never persist external definitions');
});
await test('user module still works from menu but workflow denies it before file authorization', async () => {
  const before = authorized;
  await denied(workflow(host, input('user.file-report', 'inspect', 'user-workflow')), /[Bb]uiltin|[Ww]orkflow|[Tt]rust/);
  assert.equal(authorized, before, 'workflow must reject untrusted module before authorize');
  const menu = await host.invoke(input('user.file-report', 'inspect', 'user-menu'));
  assert.equal(menu.type, 'task');
  if (menu.type !== 'task') throw Error('User menu task expected');
  assert.equal((await settled(host, 'user.file-report', menu.task.id)).status, 'completed');
});
await test('unknown and missing contributions are rejected, not treated as capabilities', async () => {
  await denied(workflow(host, input('core.unknown', 'inspect', 'unknown')), /[Bb]uiltin|[Uu]navailable|[Uu]nknown/);
  await denied(workflow(host, input('core.file-report', 'missing', 'missing')), /[Cc]ontribution|[Uu]navailable|[Uu]nknown/);
});
await test('builtin extension restrictions are enforced before authorization', async () => {
  host.addBuiltin({ ...builtin, id: 'core.text-only', contributions: [
    { ...EXAMPLE_MODULE.contributions[0], extensions: ['.txt'] },
  ] });
  const other = join(root, 'other.md');
  await writeFile(other, 'not a text extension');
  const before = authorized;
  await denied(workflow(host, input('core.text-only', 'inspect', 'wrong-extension', other)), /Unsupported file type/);
  assert.equal(authorized, before);
});
await test('workflow input cannot declare itself trusted or override the capability', async () => {
  const before = authorized;
  await denied(workflow(host, { ...input('core.file-report', 'inspect', 'inject'), trusted: true } as ModuleInvoke), /[Uu]nrecognized|[Uu]nknown|[Ss]trict/);
  await denied(workflow(host, { ...input('core.file-report', 'inspect', 'inject-cap'), capabilityId: 'core.file.info' } as ModuleInvoke), /[Uu]nrecognized|[Uu]nknown|[Ss]trict/);
  assert.equal(authorized, before);
});
await test('menu and workflow share the actual query capability and resource authorization', async () => {
  const menu = await host.invoke(input('core.file-report', 'info', 'menu-info'));
  const internal = await workflow(host, input('core.file-report', 'info', 'workflow-info'));
  assert.equal(menu.type, 'result');
  assert.equal(internal.type, 'result');
  if (menu.type !== 'result' || internal.type !== 'result') throw Error('Synchronous query expected');
  assert.deepEqual(internal.value, menu.value);
  assert.equal(internal.value.bytes, Buffer.byteLength(body));
});
await test('workflow task returns a handle with actual hash and reuses normal idempotency', async () => {
  const request = input('core.file-report', 'inspect', 'workflow-inspect');
  const first = await workflow(host, request);
  const second = await workflow(host, request);
  const menu = await host.invoke(request);
  assert.equal(first.type, 'task');
  assert.equal(second.type, 'task');
  assert.equal(menu.type, 'task');
  if (first.type !== 'task' || second.type !== 'task' || menu.type !== 'task') throw Error('Task handles expected');
  assert.equal(first.task.id, second.task.id);
  assert.equal(first.task.id, menu.task.id, 'menu and workflow must share the host job table');
  const done = await settled(host, request.moduleId, first.task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result?.bytes, Buffer.byteLength(body));
  assert.equal(done.result?.sha256, createHash('sha256').update(body).digest('hex'));
  await denied(workflow(host, { ...request, resource: { ...resource, path: secret } }), /[Rr]equest ID reused|[Oo]utside/);
});
await test('workflow task cancellation uses the same host job table', async () => {
  const request = input('core.file-report', 'inspect', 'workflow-cancel');
  const reply = await workflow(host, request);
  assert.equal(reply.type, 'task');
  if (reply.type !== 'task') throw Error('Task expected');
  const cancelled = host.cancel({ moduleId: request.moduleId, taskId: reply.task.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(host.task({ moduleId: request.moduleId, taskId: reply.task.id }).status, 'cancelled');
});
await test('menu and workflow share the four-running-task limit, with cancellation releasing a slot', async () => {
  const limited = new ModuleHost({
    authorize: async r => { await resolveModuleResource(r, p => p === root); }, persist: async () => {},
  });
  limited.register({
    id: 'core.test.wait', kind: 'task', input: ResourceSchema, output: ResultSchema,
    run: (_resource, context) => new Promise<ModuleResult>((_resolve, reject) => {
      const abort = () => reject(Error('Test task cancelled'));
      if (context.signal.aborted) abort();
      else context.signal.addEventListener('abort', abort, { once: true });
    }),
  });
  limited.addBuiltin({ ...EXAMPLE_MODULE, id: 'core.wait-report', contributions: [
    { ...EXAMPLE_MODULE.contributions[0], capability: 'core.test.wait' },
  ] });
  const refs: { moduleId: string; taskId: string }[] = [];
  try {
    for (let n = 0; n < 4; n++) {
      const request = input('core.wait-report', 'inspect', `shared-limit-${n}`);
      const reply = n % 2 ? await limited.invoke(request) : await workflow(limited, request);
      assert.equal(reply.type, 'task');
      if (reply.type !== 'task') throw Error('Task handle expected');
      refs.push({ moduleId: reply.task.moduleId, taskId: reply.task.id });
    }
    assert.equal(limited.tasks({ projectPath: root }).filter(task => task.status === 'running').length, 4);
    await denied(workflow(limited, input('core.wait-report', 'inspect', 'shared-limit-rejected')), /Too many active tasks/);
    assert.equal(limited.cancel(refs[0]).status, 'cancelled');
    const reopened = await workflow(limited, input('core.wait-report', 'inspect', 'shared-limit-reopened'));
    assert.equal(reopened.type, 'task');
    if (reopened.type !== 'task') throw Error('A cancelled task must free a slot');
    refs.push({ moduleId: reopened.task.moduleId, taskId: reopened.task.id });
  } finally {
    for (const ref of refs) if (limited.task(ref).status === 'running') limited.cancel(ref);
  }
});
await test('unknown workspace, escaping paths and non-files fail from the workflow entrance', async () => {
  await denied(workflow(host, { ...input('core.file-report', 'info', 'wrong-root'), resource: { projectPath: outside, path: secret } }), /Unknown workspace/);
  await denied(workflow(host, input('core.file-report', 'info', 'outside', secret)), /outside workspace/);
  await denied(workflow(host, input('core.file-report', 'inspect', 'task-outside', secret)), /outside workspace/);
  await denied(workflow(host, input('core.file-report', 'info', 'directory', root)), /regular file/);
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await denied(workflow(host, input('core.file-report', 'info', 'symlink', join(root, 'escape', 'secret.txt'))), /outside workspace/);
});
await test('32 MiB belongs to inspect task, not the info query', async () => {
  const big = join(root, 'sparse.bin');
  await writeFile(big, 'x');
  await truncate(big, 32 * 1024 * 1024 + 1);
  const info = await workflow(host, input('core.file-report', 'info', 'big-info', big));
  assert.equal(info.type, 'result');
  if (info.type !== 'result') throw Error('Query expected');
  assert.equal(info.value.bytes, 32 * 1024 * 1024 + 1);
  const inspect = await workflow(host, input('core.file-report', 'inspect', 'big-inspect', big));
  assert.equal(inspect.type, 'task');
  if (inspect.type !== 'task') throw Error('Task expected');
  const done = await settled(host, 'core.file-report', inspect.task.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error ?? '', /32 MiB/);
});
await test('service stays lazy and publishes both real built-in contributions', async () => {
  assert.equal(dataRootCalls(), 0, 'importing service opened a data root');
  const serviceHost = await getModuleHost();
  assert.equal(dataRootCalls(), 1);
  assert.equal(await getModuleHost(), serviceHost, 'service should reuse one host');
  const catalog = serviceHost.catalog();
  const internal = catalog.modules.find(m => m.id === 'core.file-report');
  assert.ok(internal);
  assert.deepEqual(internal.contributions.map(c => [c.id, c.capability]), [
    ['inspect', 'core.file.inspect'], ['info', 'core.file.info'],
  ]);
  assert.deepEqual('workflowTargets' in catalog ? catalog.workflowTargets : undefined, [
    { moduleId: 'core.file-report', contributionId: 'inspect', capabilityId: 'core.file.inspect' },
    { moduleId: 'core.file-report', contributionId: 'info', capabilityId: 'core.file.info' },
  ]);
  const answer = await workflow(serviceHost, input('core.file-report', 'info', 'service-query'));
  assert.equal(answer.type, 'result');
});
console.log(`${passed} module catalog/workflow checks passed; ${failed} failed`);
if (failed) process.exitCode = 1;
