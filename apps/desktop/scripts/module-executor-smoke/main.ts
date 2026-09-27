/**
 * UI-MODULES-P2 / 任务 03 的定向回归：**模块能力工作流执行器**。
 *
 * 两层证据，缺一不可：
 *  - 替身宿主：精确摆出取消竞态、任务丢失、量纲换算、超时这些**难以在真实宿主上稳定复现**的时序；
 *  - 真实宿主：真 `ModuleHost` + 真 `fileCapabilities` + 临时目录里的真文件，
 *    证明 query/task 两条路真的跑通，而不是靠预制结果。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MODULE_CAPABILITY_NODE_TYPE_ID,
  MODULE_CAPABILITY_RUNNER_KIND,
  type ModuleWorkflowExecutionInput,
} from "@contracts/moduleCapability";
import {
  ResourceSchema,
  ResultSchema,
  type ModuleContribution,
  type ModuleInvoke,
  type ModuleReply,
  type ModuleResult,
  type ModuleTask,
  type ModuleTaskRef,
} from "@contracts/modules";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { NodeRunInput } from "@contracts/runtime";
import type { WorkflowNode } from "@contracts/workflow";
import { fileCapabilities, resolveModuleResource } from "../../src/main/modules/fileCapabilities.js";
import { ModuleHost } from "../../src/main/modules/ModuleHost.js";
import type { ExecutionContext, ExecutionProgress } from "../../src/main/orchestration/executionContext.js";
import {
  ModuleCapabilityExecutor,
  type WorkflowModuleHostPort,
} from "../../src/main/orchestration/moduleCapabilityExecutor.js";

let passed = 0;
const test = async (name: string, fn: () => unknown): Promise<void> => {
  await fn();
  passed++;
  console.log("PASS " + name);
};

const MODULE_ID = "core.file-report";
const view: ModuleContribution["view"] = {
  title: { zh: "结果", en: "Result" },
  fields: [{ key: "bytes", title: { zh: "大小", en: "Bytes" } }],
};
const infoView: ModuleContribution["view"] = {
  title: { zh: "文件信息", en: "File information" },
  fields: [
    { key: "bytes", title: { zh: "字节数", en: "Bytes" } },
    { key: "modifiedAt", title: { zh: "修改时间", en: "Modified at" } },
  ],
};

/* ── 夹具 ── */

let nodeSeq = 0;
const contextOf = (options: {
  cwd: string;
  moduleCall?: ModuleWorkflowExecutionInput;
  signal?: AbortSignal;
  emitProgress?: (progress: ExecutionProgress) => void;
  nodeId?: string;
}): ExecutionContext => {
  const nodeId = options.nodeId ?? `node-${++nodeSeq}`;
  const input: NodeRunInput & { signal: AbortSignal } = {
    prompt: "",
    data: { userInput: "", upstreamText: "", upstreamOutputs: {}, upstreamArtifacts: [] },
    skills: [],
    mcpServerNames: [],
    pluginNames: [],
    returnMode: "result",
    signal: options.signal ?? new AbortController().signal,
    ...(options.moduleCall === undefined ? {} : { moduleCall: options.moduleCall }),
  };
  return {
    node: { id: nodeId, type: MODULE_CAPABILITY_NODE_TYPE_ID } as unknown as WorkflowNode,
    manifest: { runner: { kind: MODULE_CAPABILITY_RUNNER_KIND } } as unknown as NodeTypeManifest,
    input,
    cwd: options.cwd,
    metadata: { sessionId: "s1", runId: "r1", nodeId },
    ...(options.emitProgress === undefined ? {} : { emitProgress: options.emitProgress }),
  };
};

const callOf = (over: Partial<ModuleWorkflowExecutionInput> = {}): ModuleWorkflowExecutionInput => ({
  moduleId: MODULE_ID,
  contributionId: "inspect",
  path: "a.txt",
  requestId: "wf:attempt-1",
  ...over,
});

const taskOf = (over: Partial<ModuleTask> = {}): ModuleTask => ({
  id: "task-1",
  moduleId: MODULE_ID,
  contributionId: "inspect",
  resource: { projectPath: "/w", path: "/w/a.txt" },
  view,
  status: "running",
  progress: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/** 只做时序，不做业务：所有授权判断留给真实宿主那一层测。 */
class FakeHost implements WorkflowModuleHostPort {
  readonly invocations: ModuleInvoke[] = [];
  readonly cancels: ModuleTaskRef[] = [];
  lost = false;
  private queue: ModuleTask[] = [];
  private last: ModuleTask | undefined;

  constructor(private readonly reply: (input: ModuleInvoke) => Promise<ModuleReply>) {}

  withPolls(tasks: ModuleTask[]): this {
    this.queue = [...tasks];
    return this;
  }

  async invokeForWorkflow(input: ModuleInvoke): Promise<ModuleReply> {
    this.invocations.push(input);
    const reply = await this.reply(input);
    // 句柄一发出就是"当前快照",否则第一次轮询会假装任务不存在。
    if (reply.type === "task") this.last = reply.task;
    return reply;
  }

  task(ref: ModuleTaskRef): ModuleTask {
    if (this.lost) throw Error("Task not found for this module");
    const next = this.queue.shift() ?? this.last;
    if (next === undefined) throw Error("Task not found for this module");
    this.last = next;
    if (next.moduleId !== ref.moduleId) throw Error("Task not found for this module");
    return { ...next };
  }

  cancel(ref: ModuleTaskRef): ModuleTask {
    this.cancels.push(ref);
    const current = this.last ?? taskOf();
    const stopped: ModuleTask = { ...current, status: "cancelled" };
    this.last = stopped;
    return stopped;
  }
}

const taskReply = (task: ModuleTask): ((input: ModuleInvoke) => Promise<ModuleReply>) =>
  async () => ({ type: "task", task });
const resultReply = (value: ModuleResult): ((input: ModuleInvoke) => Promise<ModuleReply>) =>
  async () => ({ type: "result", value, view });

const fast = (host: WorkflowModuleHostPort, maxWaitMs = 2_000): ModuleCapabilityExecutor =>
  new ModuleCapabilityExecutor({ host, pollIntervalMs: 2, maxPollIntervalMs: 8, maxWaitMs });

/* ── 1. 输入契约 ── */

await test("declares the frozen runner kind and its capabilities", () => {
  const executor = fast(new FakeHost(resultReply({ bytes: 1 })));
  assert.equal(executor.kind, "module-capability");
  assert.equal(executor.capabilities.supportsProgress, true);
  assert.equal(executor.capabilities.supportsCancellation, true);
  assert.equal(executor.capabilities.supportsArtifacts, false);
});

await test("missing moduleCall fails without touching the host", async () => {
  const host = new FakeHost(resultReply({ bytes: 1 }));
  const outcome = await fast(host).execute(contextOf({ cwd: "/w" }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /missing execution config/);
  assert.equal(host.invocations.length, 0);
});

await test("execution input missing host requestId is refused before any invoke", async () => {
  const host = new FakeHost(resultReply({ bytes: 1 }));
  const broken = { moduleId: MODULE_ID, contributionId: "inspect", path: "a.txt" } as unknown as ModuleWorkflowExecutionInput;
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: broken }));
  assert.equal(outcome.status, "failed");
  assert.equal(host.invocations.length, 0);
});

await test("caller-declared authorization fields are refused", async () => {
  const host = new FakeHost(resultReply({ bytes: 1 }));
  const forged = { ...callOf(), trusted: true, projectPath: "/elsewhere" } as unknown as ModuleWorkflowExecutionInput;
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: forged }));
  assert.equal(outcome.status, "failed");
  assert.equal(host.invocations.length, 0);
});

await test("workspace comes from the trusted cwd, never from parameters", async () => {
  const host = new FakeHost(resultReply({ bytes: 1 }));
  await fast(host).execute(contextOf({ cwd: "/trusted", moduleCall: callOf({ path: "docs/a.txt" }) }));
  const sent = host.invocations[0];
  assert.ok(sent);
  assert.equal(sent.resource.projectPath, "/trusted");
  assert.equal(sent.resource.path, resolve("/trusted", "docs/a.txt"));
  assert.equal(sent.requestId, "wf:attempt-1");
});

/* ── 2. 结果映射 ── */

await test("query result maps to success with the complete result", async () => {
  const host = new FakeHost(resultReply({ bytes: 12, sha256: "abc", ok: true, note: null }));
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(outcome.status, "success");
  assert.deepEqual(outcome.outputs, { bytes: 12, sha256: "abc", ok: true, note: null });
  assert.equal(outcome.summary, JSON.stringify({ bytes: 12, sha256: "abc", ok: true, note: null }));
  assert.equal(outcome.artifacts, undefined);
  assert.equal(outcome.execution, undefined);
});

await test("completed task maps to success and never re-invokes", async () => {
  const host = new FakeHost(taskReply(taskOf())).withPolls([
    taskOf({ status: "completed", progress: 1, result: { bytes: 7 } }),
  ]);
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(outcome.status, "success");
  assert.deepEqual(outcome.outputs, { bytes: 7 });
  assert.equal(host.invocations.length, 1);
});

await test("host progress 0..1 is converted to percent 0..100", async () => {
  const seen: number[] = [];
  const host = new FakeHost(taskReply(taskOf({ progress: 0 }))).withPolls([
    taskOf({ progress: 0.5 }),
    taskOf({ status: "completed", progress: 1, result: { bytes: 7 } }),
  ]);
  const outcome = await fast(host).execute(
    contextOf({
      cwd: "/w",
      moduleCall: callOf(),
      emitProgress: (progress) => {
        if (progress.percent !== undefined) seen.push(progress.percent);
      },
    }),
  );
  assert.equal(outcome.status, "success");
  assert.deepEqual(seen, [0, 50, 100]);
  assert.ok(seen.every((value) => Number.isFinite(value)));
});

await test("non-finite host progress is dropped instead of emitted", async () => {
  const seen: number[] = [];
  const host = new FakeHost(taskReply(taskOf({ progress: Number.NaN }))).withPolls([
    taskOf({ status: "completed", progress: 1, result: { bytes: 1 } }),
  ]);
  await fast(host).execute(
    contextOf({
      cwd: "/w",
      moduleCall: callOf(),
      emitProgress: (progress) => {
        if (progress.percent !== undefined) seen.push(progress.percent);
      },
    }),
  );
  assert.deepEqual(seen, [100]);
});

await test("failed task stays failed and keeps the host reason", async () => {
  const host = new FakeHost(taskReply(taskOf())).withPolls([
    taskOf({ status: "failed", error: "Task timed out" }),
  ]);
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "Task timed out");
  assert.equal(outcome.summary, "");
  assert.equal(outcome.outputs, undefined);
});

await test("cancelled task maps to cancelled, not failed", async () => {
  const host = new FakeHost(taskReply(taskOf())).withPolls([taskOf({ status: "cancelled" })]);
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.outputs, undefined);
});

await test("completed without a result is a failure, not an empty success", async () => {
  const host = new FakeHost(taskReply(taskOf())).withPolls([taskOf({ status: "completed", progress: 1 })]);
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /without a result/);
});

await test("host rejection surfaces as the node failure reason", async () => {
  const host = new FakeHost(async () => {
    throw Error("Workflow requires an available registered builtin read-only contribution");
  });
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /registered builtin read-only/);
});

/* ── 3. 生命周期与取消 ── */

await test("already-cancelled node performs zero host calls", async () => {
  const controller = new AbortController();
  controller.abort();
  const host = new FakeHost(resultReply({ bytes: 1 }));
  const outcome = await fast(host).execute(
    contextOf({ cwd: "/w", moduleCall: callOf(), signal: controller.signal }),
  );
  assert.equal(outcome.status, "cancelled");
  assert.equal(host.invocations.length, 0);
  assert.equal(host.cancels.length, 0);
});

await test("cancelling while polling cancels only this task", async () => {
  const controller = new AbortController();
  const host = new FakeHost(taskReply(taskOf()));
  const running = fast(host).execute(
    contextOf({ cwd: "/w", moduleCall: callOf(), signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 20);
  const outcome = await running;
  assert.equal(outcome.status, "cancelled");
  assert.equal(host.cancels.length, 1);
  assert.deepEqual(host.cancels[0], { moduleId: MODULE_ID, taskId: "task-1" });
});

await test("late handle after cancellation is cleaned up, leaving no orphan task", async () => {
  const controller = new AbortController();
  const seen: number[] = [];
  const host = new FakeHost(async () => {
    await new Promise((done) => setTimeout(done, 30));
    return { type: "task", task: taskOf({ id: "late-task" }) };
  });
  const running = fast(host).execute(
    contextOf({
      cwd: "/w",
      moduleCall: callOf(),
      signal: controller.signal,
      emitProgress: (progress) => {
        if (progress.percent !== undefined) seen.push(progress.percent);
      },
    }),
  );
  setTimeout(() => controller.abort(), 5);
  const outcome = await running;
  assert.equal(outcome.status, "cancelled");
  assert.equal(host.invocations.length, 1);
  assert.deepEqual(host.cancels, [{ moduleId: MODULE_ID, taskId: "late-task" }]);
  // 守卫要在**进入等待之前**收手：一个已取消的节点不该再报一次进度。
  assert.deepEqual(seen, [], "a cancelled node must not report progress for a late handle");
});

await test("cancellation observed after a query succeeded does not publish outputs", async () => {
  const controller = new AbortController();
  const host = new FakeHost(async () => {
    controller.abort();
    return { type: "result", value: { bytes: 1 }, view };
  });
  const outcome = await fast(host).execute(
    contextOf({ cwd: "/w", moduleCall: callOf(), signal: controller.signal }),
  );
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.outputs, undefined);
});

await test("lost task fails explicitly and is never silently re-run", async () => {
  const host = new FakeHost(taskReply(taskOf()));
  host.lost = true;
  const outcome = await fast(host).execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /no longer available/);
  assert.equal(host.invocations.length, 1);
});

await test("executor deadline fails the node and releases the host task", async () => {
  const host = new FakeHost(taskReply(taskOf()));
  const outcome = await fast(host, 40).execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /did not settle/);
  assert.equal(host.cancels.length, 1);
});

await test("explicit cancel hook only touches this executor's live handle", async () => {
  const host = new FakeHost(taskReply(taskOf()));
  const executor = fast(host);
  const context = contextOf({ cwd: "/w", moduleCall: callOf(), nodeId: "n-cancel" });
  executor.cancel(context);
  assert.equal(host.cancels.length, 0, "no live handle yet");
  const running = executor.execute(context);
  setTimeout(() => executor.cancel(context), 20);
  await running;
  assert.equal(host.cancels.length, 1);
  executor.cancel(context);
  assert.equal(host.cancels.length, 1, "handle is released once the node settles");
});

await test("host factory stays lazy until a node actually runs", async () => {
  let built = 0;
  const host = new FakeHost(resultReply({ bytes: 1 }));
  const executor = new ModuleCapabilityExecutor({
    host: () => {
      built++;
      return host;
    },
    pollIntervalMs: 2,
  });
  assert.equal(built, 0);
  await executor.execute(contextOf({ cwd: "/w", moduleCall: callOf() }));
  assert.equal(built, 1);
});

/* ── 4. 真实宿主 ── */

const temp = await mkdtemp(join(tmpdir(), "mcode-module-executor-"));
try {
  const root = join(temp, "workspace");
  const outside = join(temp, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  const body = "module executor\n";
  await writeFile(join(root, "a.txt"), body);
  await writeFile(join(outside, "secret.txt"), "secret");

  const knownRoot = (path: string): boolean => path === root;
  const realHost = new ModuleHost({
    authorize: async (resource) => {
      await resolveModuleResource(resource, knownRoot);
    },
    persist: async () => {},
  });
  for (const capability of fileCapabilities(knownRoot)) realHost.register(capability);

  let counted = 0;
  realHost.register({
    id: "core.test.counted",
    kind: "task",
    input: ResourceSchema,
    output: ResultSchema,
    run: async () => {
      counted++;
      return { runs: counted };
    },
  });

  realHost.addBuiltin({
    apiVersion: 1,
    id: MODULE_ID,
    version: "1.0.0",
    title: { zh: "内置文件检查", en: "Built-in file inspection" },
    permissions: ["resource.read"],
    contributions: [
      { id: "inspect", slot: "files.context", title: { zh: "检查", en: "Inspect" }, capability: "core.file.inspect", view },
      { id: "info", slot: "files.context", title: { zh: "信息", en: "Info" }, capability: "core.file.info", view: infoView },
      { id: "counted", slot: "files.context", title: { zh: "计数", en: "Counted" }, capability: "core.test.counted", view },
    ],
  });
  await realHost.install({
    apiVersion: 1,
    id: "user.demo",
    version: "1.0.0",
    title: { zh: "用户模块", en: "User module" },
    permissions: ["resource.read"],
    contributions: [
      { id: "inspect", slot: "files.context", title: { zh: "检查", en: "Inspect" }, capability: "core.file.inspect", view },
    ],
  });

  const realExecutor = new ModuleCapabilityExecutor({ host: realHost, pollIntervalMs: 5, maxWaitMs: 10_000 });
  const runReal = (call: ModuleWorkflowExecutionInput) =>
    realExecutor.execute(contextOf({ cwd: root, moduleCall: call }));

  await test("real host: query capability returns a real file result", async () => {
    const outcome = await runReal(callOf({ contributionId: "info", requestId: "wf:real-info" }));
    assert.equal(outcome.status, "success");
    assert.equal(outcome.outputs?.bytes, body.length);
    assert.ok(outcome.outputs?.modifiedAt !== undefined);
  });

  await test("real host: task capability settles with the real sha256", async () => {
    const outcome = await runReal(callOf({ contributionId: "inspect", requestId: "wf:real-inspect" }));
    assert.equal(outcome.status, "success");
    assert.equal(outcome.outputs?.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(outcome.outputs?.bytes, body.length);
  });

  await test("real host: the same attempt never starts a second task", async () => {
    const before = counted;
    const call = callOf({ contributionId: "counted", requestId: "wf:attempt-A" });
    const first = await runReal(call);
    const second = await runReal(call);
    assert.equal(first.status, "success");
    assert.equal(second.status, "success");
    assert.equal(counted, before + 1, "one dispatch identity must map to one host task");
    assert.deepEqual(first.outputs, second.outputs);
  });

  await test("real host: a new dispatch identity really re-runs the capability", async () => {
    const before = counted;
    const outcome = await runReal(callOf({ contributionId: "counted", requestId: "wf:attempt-B" }));
    assert.equal(outcome.status, "success");
    assert.equal(counted, before + 1);
    assert.equal(outcome.outputs?.runs, before + 1);
  });

  await test("real host: user.* modules are denied through the workflow entry", async () => {
    const outcome = await realExecutor.execute(
      contextOf({ cwd: root, moduleCall: callOf({ moduleId: "user.demo", requestId: "wf:user" }) }),
    );
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /builtin read-only/);
  });

  await test("real host: a forged core id without builtin registration is denied", async () => {
    const outcome = await realExecutor.execute(
      contextOf({ cwd: root, moduleCall: callOf({ moduleId: "core.not-registered", requestId: "wf:forged" }) }),
    );
    assert.equal(outcome.status, "failed");
  });

  await test("real host: unknown contribution is denied", async () => {
    const outcome = await runReal(callOf({ contributionId: "nope", requestId: "wf:unknown-contrib" }));
    assert.equal(outcome.status, "failed");
  });

  await test("real host: path traversal outside the workspace is denied", async () => {
    const outcome = await runReal(
      callOf({ contributionId: "info", path: join("..", "outside", "secret.txt"), requestId: "wf:traversal" }),
    );
    assert.equal(outcome.status, "failed");
  });

  await test("real host: a cwd that is not a known root is denied", async () => {
    const outcome = await realExecutor.execute(
      contextOf({ cwd: outside, moduleCall: callOf({ contributionId: "info", requestId: "wf:unknown-root" }) }),
    );
    assert.equal(outcome.status, "failed");
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log(`module-executor-smoke: ${passed} checks passed`);
