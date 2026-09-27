import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  ModuleManifestSchema, ModuleInvokeSchema, ModuleTaskRefSchema, ResourceSchema,
  type ModuleManifest, type ModuleInvoke, type ModuleResource, type ModuleResult, type ModuleTask,
  type ModuleReply, type ModuleCatalog, type ModuleTaskRef,
} from "@contracts/modules";
import {
  ModuleCapabilityDescriptorSchema,
  type ModuleCapabilityDescriptor, type ModuleWorkflowTarget,
} from "@contracts/moduleCapability";

export interface CapabilityContext { signal: AbortSignal; progress(value: number): void; }
export interface Capability<I> {
  id: string;
  kind: "query" | "action" | "task";
  metadata?: ModuleCapabilityDescriptor["metadata"];
  input: z.ZodType<I>;
  output: z.ZodType<ModuleResult>;
  run(input: I, context: CapabilityContext): Promise<ModuleResult>;
}
type ErasedCapability = Omit<Capability<unknown>, "input">;
type LiveTask = { snapshot: ModuleTask; controller: AbortController; requestKey: string; fingerprint: string; timer: ReturnType<typeof setTimeout> };

/** Transport-independent host. It never imports Electron, DB or a UI store.
 * Imported modules are data only; only host-registered capabilities can execute. */
export class ModuleHost {
  private readonly capabilities = new Map<string, ErasedCapability>();
  private readonly modules = new Map<string, ModuleManifest>();
  private readonly builtinIds = new Set<string>();
  private readonly jobs = new Map<string, LiveTask>();
  private readonly requests = new Map<string, string>();
  private mutation: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    authorize(resource: ModuleResource): Promise<void>;
    persist(manifests: ModuleManifest[]): Promise<void>;
  }) {}

  register<I>(definition: Capability<I>): void {
    if (this.capabilities.has(definition.id)) throw Error("Duplicate capability");
    // Validate discovery data once at registration, and never retain a caller-
    // owned metadata object. The display schema is not an execution validator.
    const descriptor = structuredClone(ModuleCapabilityDescriptorSchema.parse({
      id: definition.id, kind: definition.kind,
      ...(definition.metadata === undefined ? {} : {metadata: definition.metadata}),
    }));
    // Every invocation requires the manifest's resource.read permission and
    // runs authorize(resource). Optional discovery data must not claim less.
    const metadata = descriptor.metadata;
    if (metadata && !metadata.permissions.includes("resource.read")) {
      throw Error("Capability metadata must declare resource.read permission");
    }
    // Queries have no job handle, timeout or exposed cancellation in this host.
    if (descriptor.kind === "query" && metadata?.supportsCancellation) {
      throw Error("Query capabilities cannot advertise cancellation");
    }
    if (descriptor.kind === "query" && metadata?.limits?.taskTimeoutMs !== undefined) {
      throw Error("Query capabilities cannot advertise a task timeout");
    }
    // A later mutation of the caller's definition must not swap out the
    // implementation or input validator after a capability was registered.
    const inputSchema = definition.input;
    const run = definition.run.bind(definition);
    this.capabilities.set(descriptor.id, {
      ...descriptor, output: definition.output,
      run: (input, context) => run(inputSchema.parse(input), context),
    });
  }
  private validate(raw: unknown): ModuleManifest {
    const manifest = ModuleManifestSchema.parse(raw);
    if (!manifest.permissions.includes("resource.read")) throw Error("resource.read permission required");
    for (const c of manifest.contributions) {
      const capability = this.capabilities.get(c.capability);
      if (!capability) throw Error("Unknown capability: " + c.capability);
      // v1 does not grant write/command execution through an imported menu.
      if (capability.kind === "action") throw Error("Actions require a future write-permission contract");
    }
    return manifest;
  }
  addBuiltin(raw: unknown): void {
    const manifest = this.validate(raw);
    if (!manifest.id.startsWith("core.") || this.modules.has(manifest.id)) throw Error("Invalid builtin module ID");
    this.modules.set(manifest.id, manifest); this.builtinIds.add(manifest.id);
  }
  /** Restoration only after the host has validated its own persisted store. */
  restore(raw: unknown): void {
    const manifest = this.validate(raw);
    if (!manifest.id.startsWith("user.") || this.modules.has(manifest.id)) throw Error("Invalid persisted module ID");
    this.modules.set(manifest.id, manifest);
  }
  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(fn);
    this.mutation = next.then(() => {}, () => {});
    return next;
  }
  install(raw: unknown): Promise<ModuleCatalog> {
    return this.serializeMutation(async () => {
      const manifest = this.validate(raw);
      if (!manifest.id.startsWith("user.")) throw Error("External IDs must start with user.");
      if (!this.modules.has(manifest.id) && this.modules.size >= 32) throw Error("Module limit reached");
      const next = new Map(this.modules); next.set(manifest.id, manifest);
      await this.options.persist([...next.values()].filter(m => !this.builtinIds.has(m.id)));
      this.modules.set(manifest.id, manifest);
      return this.catalog();
    });
  }
  remove(id: string): Promise<ModuleCatalog> {
    return this.serializeMutation(async () => {
      if (this.builtinIds.has(id)) throw Error("Builtin module cannot be removed");
      if (!this.modules.has(id)) throw Error("Unknown module");
      await this.options.persist([...this.modules.values()].filter(m => m.id !== id && !this.builtinIds.has(m.id)));
      this.modules.delete(id);
      for (const j of this.jobs.values()) if (j.snapshot.moduleId === id && j.snapshot.status === "running") this.cancel({moduleId: id, taskId: j.snapshot.id});
      return this.catalog();
    });
  }
  /** A core-looking ID is not proof of trust. Only the host's actual builtin
   * registration, an existing contribution and a live read-only capability
   * may produce a workflow target (and pass the workflow invocation gate). */
  private readonlyWorkflowTarget(moduleId: string, contributionId: string): ModuleWorkflowTarget | undefined {
    if (!this.builtinIds.has(moduleId)) return undefined;
    const module = this.modules.get(moduleId);
    const contribution = module?.contributions.find(c => c.id === contributionId);
    const capability = contribution && this.capabilities.get(contribution.capability);
    if (!capability || (capability.kind !== "query" && capability.kind !== "task")) return undefined;
    return {moduleId, contributionId, capabilityId: capability.id};
  }
  catalog(): ModuleCatalog {
    const workflowTargets: ModuleWorkflowTarget[] = [];
    for (const id of this.builtinIds) {
      const module = this.modules.get(id);
      if (!module) continue;
      for (const contribution of module.contributions) {
        const target = this.readonlyWorkflowTarget(id, contribution.id);
        if (target) workflowTargets.push(target);
      }
    }
    const capabilities: ModuleCapabilityDescriptor[] = [...this.capabilities.values()].map(({id,kind,metadata}) => ({
      id, kind, ...(metadata === undefined ? {} : {metadata}),
    }));
    return structuredClone({ modules: [...this.modules.values()], capabilities, workflowTargets });
  }
  /** Host-internal workflow entry. Never expose this through IPC/preload: a
   * renderer is not permitted to self-declare automated-run authorization. */
  async invokeForWorkflow(input: ModuleInvoke): Promise<ModuleReply> {
    const parsed = ModuleInvokeSchema.parse(input);
    await this.mutation;
    if (!this.readonlyWorkflowTarget(parsed.moduleId, parsed.contributionId)) {
      throw Error("Workflow requires an available registered builtin read-only contribution");
    }
    // Reuse the menu's envelope, contribution, extension, realpath/known-root
    // authorization, task limits, cancellation and request-id deduplication.
    return this.invoke(parsed);
  }
  private finish(job: LiveTask, status: ModuleTask["status"], result?: ModuleResult, error?: string): void {
    if (job.snapshot.status !== "running") return;
    clearTimeout(job.timer);
    Object.assign(job.snapshot, { status, updatedAt: Date.now(), ...(result ? {result,progress:1} : {}), ...(error ? {error:error.slice(0,2000)} : {}) });
  }
  async invoke(raw: unknown): Promise<ModuleReply> {
    const input = ModuleInvokeSchema.parse(raw);
    await this.mutation;
    const module = this.modules.get(input.moduleId);
    const contribution = module?.contributions.find(c => c.id === input.contributionId);
    if (!module || !contribution) throw Error("Module/contribution unavailable");
    const definition = this.capabilities.get(contribution.capability);
    if (!definition) throw Error("Capability unavailable");
    const resource = ResourceSchema.parse(input.resource);
    if (contribution.extensions && !contribution.extensions.some(ext => resource.path.toLowerCase().endsWith(ext))) throw Error("Unsupported file type");
    await this.options.authorize(resource);
    // Authorization may await disk IO while a module is replaced/removed.
    if (this.modules.get(input.moduleId) !== module) throw Error("Module changed; retry with its current definition");
    if (definition.kind !== "task") {
      const value = definition.output.parse(await definition.run(resource, {signal:new AbortController().signal,progress:()=>{}}));
      return {type:"result",value:structuredClone(value),view:structuredClone(contribution.view)};
    }
    const requestKey = input.moduleId + ":" + input.requestId;
    const fingerprint = createHash("sha256").update(JSON.stringify([module, input.contributionId, resource.projectPath, resource.path])).digest("hex");
    const priorId = this.requests.get(requestKey);
    if (priorId) {
      const prior = this.jobs.get(priorId);
      if (!prior || prior.fingerprint !== fingerprint) throw Error("Request ID reused with different input");
      return {type:"task",task:structuredClone(prior.snapshot)};
    }
    if ([...this.jobs.values()].filter(j => j.snapshot.status === "running").length >= 4) throw Error("Too many active tasks");
    while (this.jobs.size >= 64) {
      const evict = [...this.jobs.values()].find(j => j.snapshot.status !== "running");
      if (!evict) throw Error("Task limit reached");
      this.jobs.delete(evict.snapshot.id); this.requests.delete(evict.requestKey);
    }
    const id = randomUUID(), controller = new AbortController();
    const job: LiveTask = {
      snapshot: {id,moduleId:module.id,contributionId:contribution.id,resource,view:structuredClone(contribution.view),status:"running",progress:0,createdAt:Date.now(),updatedAt:Date.now()},
      controller, requestKey, fingerprint,
      timer: setTimeout(() => { this.finish(job,"failed",undefined,"Task timed out"); controller.abort(); }, 30_000),
    };
    job.timer.unref(); this.jobs.set(id,job); this.requests.set(requestKey,id);
    void Promise.resolve().then(() => definition.run(resource, {
      signal:controller.signal,
      progress:(value) => { if (job.snapshot.status === "running" && Number.isFinite(value)) {job.snapshot.progress=Math.max(job.snapshot.progress,Math.min(1,Math.max(0,value)));job.snapshot.updatedAt=Date.now();} },
    })).then(value => this.finish(job,"completed",definition.output.parse(value)), error => this.finish(job,"failed",undefined,error instanceof Error?error.message:String(error)))
      .catch(error => this.finish(job,"failed",undefined,error instanceof Error?error.message:String(error)));
    return {type:"task",task:structuredClone(job.snapshot)};
  }
  task(raw: ModuleTaskRef): ModuleTask {
    const input = ModuleTaskRefSchema.parse(raw), job = this.jobs.get(input.taskId);
    if (!job || job.snapshot.moduleId !== input.moduleId) throw Error("Task not found for this module");
    return structuredClone(job.snapshot);
  }
  cancel(raw: ModuleTaskRef): ModuleTask {
    const current = this.task(raw), job = this.jobs.get(current.id)!;
    this.finish(job,"cancelled"); job.controller.abort();
    return structuredClone(job.snapshot);
  }
  tasks({projectPath}: {projectPath:string}): ModuleTask[] {
    return structuredClone([...this.jobs.values()].map(j=>j.snapshot).filter(t=>t.resource.projectPath===projectPath).reverse());
  }
}
