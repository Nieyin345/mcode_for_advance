import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  ModuleManifestSchema, ModuleInvokeSchema, ModuleTaskRefSchema, ResourceSchema, ResultSchema, moduleContributionView, missingCapabilityPermission, actionInvocationRefusal, declaresNetwork, moduleRefusal, moduleRefusalError,
  extensionCapabilityShortName, extensionCapabilityAssignment, MODULE_CAPABILITY_PREFIX,
  type ModuleManifest, type ModuleInvoke, type ModuleResource, type ModuleResult, type ModuleTask,
  type ModuleReply, type ModuleCatalog, type ModuleTaskRef, type ModuleChangeResult,
} from "@contracts/modules";
import {
  ModuleCapabilityDescriptorSchema, ModuleWorkflowGrantSchema, classifyModuleWorkflowGrants,
  moduleWorkflowGrantKey, sameWorkflowGrantPath, serializeModuleWorkflowGrants,
  type ModuleCapabilityDescriptor, type ModuleWorkflowTarget,
  type ModuleWorkflowGrant, type ModuleWorkflowGrantArchive, type ModuleWorkflowGrantCandidate,
  type ModuleWorkflowGrantRequest,
} from "@contracts/moduleCapability";
import { createIsolatedActionRun } from "./isolatedActionRunner.js";
import { ModulePermissionArchiveSchema, assertModuleGrants, type ModulePermissionArchive, type ModulePermissionRecord } from "@contracts/modulePermissions";
import { assertAppMethodPermission, type ModulePermission } from "@contracts/appPermission";
import { runPermissionedProcess, verifyPermissionedProgram, requireNetworkExtensionSupport } from "./permissionedProcessRunner.js";

/** Windows/macOS 的文件系统大小写不敏感 —— 授权路径比对与幂等键据此折叠大小写
 *  (与 `lib/pathGuard.samePath` 同一平台判据;[MC-036])。 */
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

export interface CapabilityContext { signal: AbortSignal; progress(value: number): void; }
export interface Capability<I> {
  id: string;
  kind: "query" | "action" | "task";
  metadata?: ModuleCapabilityDescriptor["metadata"];
  input: z.ZodType<I>;
  output: z.ZodType<ModuleResult>;
  /** 【MC-060 残余】普通实现:运行在**宿主进程内**。与 `isolatedSource` 二选一(见 register)。 */
  run?(input: I, context: CapabilityContext): Promise<ModuleResult>;
  /** 【MC-060 残余】**隔离实现** —— 一段 `async (input) => ModuleResult` 的源码,由宿主派发到
   *  一个 `node:worker_threads` 的 worker 线程里执行(见 `isolatedActionRunner.ts`)。只有 `action`
   *  能力可以走它(把会改东西的第三方代码挪出宿主线程)。见该模块顶注:**挡全局污染 / 崩线程 /
   *  挂死,但挡不住内存共享与系统调用** —— 这不是沙箱。 */
  isolatedSource?: string;
  /** 隔离执行的超时(毫秒)。缺省走 runner 的 30 秒。 */
  isolatedTimeoutMs?: number;
}
type ErasedCapability = Omit<Capability<unknown>, "input" | "run" | "isolatedSource" | "isolatedTimeoutMs">
  & { run(input: unknown, context: CapabilityContext): Promise<ModuleResult> };
/** 【MC-060】一次 `action` 能力执行前的审批请求。**作用域**随请求一起交给审批端口 ——
 * 批准方按 `moduleId:contributionId` + 具体 `resource`(已过 `authorize` 的工作区范围)
 * 决定放不放行;审批端口由宿主注入(与 `authorize`/`persist` 同款),故 host 仍不 import
 * Electron/DB/UI。 */
export interface ActionApprovalRequest {
  moduleId: string;
  contributionId: string;
  capabilityId: string;
  resource: ModuleResource;
  /** 【MC-035】这次审批要放行的是什么。缺省 `"write"`(向后兼容既有审批端口)。
   *  `"network"` = 这个模块声明了网络权限,本次执行会出网 —— 用户看到的是
   *  "要不要让这个扩展联网",而不是"要不要让它改文件"。 */
  scope?: "write" | "network";
}

/** 【ARC-006 Gate E】**一次模块变更（安装/升级/卸载）的副作用诊断**。
 *
 *  升级换了执行体 / 卸载时，旧版本**正在运行**的任务必须被取消 —— 否则它们跑完后
 *  会把结果写回一个已经不存在的模块版本（"取消后又被算成功"的反面：没人取消，
 *  一个本应作废的执行体继续影响世界）。取消是**协作式**的：走任务自己的
 *  `AbortController`（扩展代码拿到的是 `signal`），不杀进程。
 *
 *  `cancelledTasks` 是这次真正被取消的任务数；`cancelFailures` 是取消时抛错的任务
 *  与原因（如实上报，不静默吞）。两者都随 `install`/`remove` 的结果一起交给调用方，
 *  IPC 层可经 `onChanged` 端口把它写进诊断日志。 */
export interface ModuleChangeOutcome {
  moduleId: string;
  /** 这次变更取消掉的运行中任务数。 */
  cancelledTasks: number;
  /** 取消失败的任务（理论上 `cancel` 是同步内存操作，不会失败；保留出口是为了
   *  将来若引入异步收尾，失败也必须可见）。 */
  cancelFailures: Array<{ taskId: string; reason: string }>;
}
type LiveTask = { snapshot: ModuleTask; controller: AbortController; requestKey: string; fingerprint: string; timer: ReturnType<typeof setTimeout>; workflowGrantKey?: string };

/** 【MC-036】签发 / 撤销授权的入参形状 —— 与记录同形但**不带** `grantedAt`(签发时补,
 * 撤销时按同一幂等键不参与匹配)。宿主自带的校验只认这几个字段,不在 IPC 层另写一份。 */
const parseGrantInput = (raw: unknown): ModuleWorkflowGrantRequest => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("工作流授权入参必须是对象");
  const value = raw as Record<string, unknown>;
  const allowed = new Set(["moduleId", "moduleVersion", "contributionId", "capabilityId", "projectPath"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw Error("工作流授权入参包含未知字段:" + key);
  // 复用契约 schema 的形状校验:搭一条 grantedAt 占位记录过同一个 schema,再拆掉占位。
  const parsed = ModuleWorkflowGrantSchema.parse({ ...value, grantedAt: 0 });
  return {
    moduleId: parsed.moduleId, moduleVersion: parsed.moduleVersion,
    contributionId: parsed.contributionId, capabilityId: parsed.capabilityId, projectPath: parsed.projectPath,
  };
};

/** Transport-independent host. It never imports Electron, DB or a UI store.
 * Imported modules are data only; only host-registered capabilities can execute. */
export class ModuleHost {
  private readonly capabilities = new Map<string, ErasedCapability>();
  /** 【MC-035】**宿主分配**的扩展能力 → 所属模块。与 `capabilities` 同一张注册表:
   *  `catalog` / `validate` / `invoke` 只看 `capabilities`,这张表只回答"卸载/替换时
   *  该撤哪几个"以及"这个 id 是不是某模块的执行能力"(撤销即删,故不存在撤销后残留)。 */
  private readonly extensionCapabilities = new Map<string, string>();
  private readonly modules = new Map<string, ModuleManifest>();
  private readonly builtinIds = new Set<string>();
  private readonly jobs = new Map<string, LiveTask>();
  /** 已派发但未结束的非 task 能力调用；卸载/换执行体时同步撤销其信号。 */
  private readonly activeInvocations = new Map<string, Set<AbortController>>();
  /** 仅跟踪真正走 invokeForWorkflow 的 query/action，不误取消同模块的菜单调用。 */
  private readonly activeWorkflowInvocations = new Map<string, Set<AbortController>>();
  private readonly requests = new Map<string, string>();
  private mutation: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    authorize(resource: ModuleResource): Promise<void>;
    persist(manifests: ModuleManifest[]): Promise<void>;
    /** 【MC-060】`action` 能力**每次执行**前的审批端口 —— 与 `authorize`/`persist` 同款由宿主
     * 注入,故 host 仍不 import Electron/DB/UI。**resolve = 批准**(放行执行),**reject = 拒绝**
     * (原样把原因抛给调用端)。缺省(未注入)= 没有审批通道,`action` 执行一律被拒(fail-closed),
     * 与 `gateAppAction` 在无审批环境下的取向一致。写档动作绝不能被"没界面问"默认放行。 */
    requestApproval?(request: ActionApprovalRequest): Promise<void>;
    /** 【MC-036】用户模块的**工作流运行授权**存档(读侧)：返回存档原文(`null` = 文件还不存在)。
     * 缺省 = 没有授权来源 → 所有 `user.*` 工作流目标一律不可用(与从前取向一致)。
     * 原文由 `classifyModuleWorkflowGrants` 判三态;坏存档**整表不信任**(fail-closed)。 */
    readWorkflowGrants?(): string | null;
    /** 【MC-036】授权存档的**写侧**：把新原文交回宿主注入的持久化(tmp+rename 原子写)。
     * 缺省 = 没有持久化通道 → 签发被拒(fail-closed:授权必须跨重启有效,不能只活在内存里)。 */
    persistWorkflowGrants?(text: string): Promise<void>;
    /** Independent user-consent ledger. Read on each authorization decision; absent is NOT consent. */
    readModulePermissions?(): string | null;
    persistModulePermissions?(text: string): Promise<void>;
    /** Trusted host adapter into invokeAppTool. Never supplied by extension source/IPC. */
    invokeAppCall?(moduleId: string, method: string, input: unknown, signal: AbortSignal): Promise<unknown>;
    /** 【MC-035】资源 → **真实路径**的解析(生产注入 `resolveModuleResource`)。扩展进程的
     *  `--allow-fs-read` 必须按真实路径放行,否则符号链接/junction 会让"允许读 A"实际
     *  读到 B。缺省退回字面路径(仅测试/无文件系统宿主使用)。 */
    resolveResource?(resource: ModuleResource): Promise<string>;
    /** 【MC-035】安装期**程序核验**(生产注入受控进程求值,见 `verifyPermissionedProgram`)。
     * 缺省 = **拒绝**带 program 的安装(fail-closed:没有核验通道就不装可执行代码)。
     * 这与 `requestApproval` 的取向一致 —— 没有安全通道时不执行,而不是默认放行。 */
    verifyProgram?(source: string, capabilities: readonly string[], timeoutMs: number | undefined):
      Promise<{ ok: true } | { ok: false; reason: string }>;
    /** 【ARC-006 Gate E】模块变更的**副作用诊断端口**（可选）。`install`/`remove` 在
     *  事务内取消掉运行中任务之后回调一次；生产装配把它写进日志/诊断，无头套件可
     *  直接收集。缺省 = 不报告（诊断不改变事务结果）。 */
    onChanged?(outcome: ModuleChangeOutcome): void;
  }) {}

  /** 【MC-035】构造一条能力注册记录 —— **只校验、只构造,不碰任何注册表**。
   *  `register` 与 `prepareProgramBindings` 共用这一份;后者靠它实现「全部准备好
   *  才允许持久的/破坏性的动作发生」(见那里的注释)。 */
  private prepareCapability<I>(definition: Capability<I>): { id: string; record: ErasedCapability } {
    // Validate discovery data once at registration, and never retain a caller-
    // owned metadata object. The display schema is not an execution validator.
    const descriptor = structuredClone(ModuleCapabilityDescriptorSchema.parse({
      id: definition.id, kind: definition.kind,
      ...(definition.metadata === undefined ? {} : {metadata: definition.metadata}),
    }));
    // Every invocation requires the manifest's resource.read permission and
    // runs authorize(resource). Optional discovery data must not claim less:
    // an action capability's own metadata must declare resource.write too, or
    // the catalog would advertise a write capability as read-only. This is the
    // SAME single decision the manifest gate in validate() uses — never a
    // second truth for "is this kind permitted by these permissions".
    const metadata = descriptor.metadata;
    if (metadata) {
      const missing = missingCapabilityPermission(descriptor.kind, metadata.permissions);
      if (missing === "resource.read") throw Error("Capability metadata must declare resource.read permission");
      if (missing === "resource.write") throw Error("Action capability metadata must declare the resource.write permission");
    }
    // Queries have no job handle, timeout or exposed cancellation in this host.
    if (descriptor.kind === "query" && metadata?.supportsCancellation) {
      throw Error("Query capabilities cannot advertise cancellation");
    }
    if (descriptor.kind === "query" && metadata?.limits?.taskTimeoutMs !== undefined) {
      throw Error("Query capabilities cannot advertise a task timeout");
    }
    // 【MC-060 残余】执行体必须**恰好**给一种:宿主内 `run`,或隔离 `isolatedSource`。
    // 隔离只对 `action` 开(会改东西的第三方代码才需要挪出宿主线程;query/task 走宿主)。
    if ((definition.run === undefined) === (definition.isolatedSource === undefined)) {
      throw Error("Capability must provide exactly one of run or isolatedSource");
    }
    if (definition.isolatedSource !== undefined && descriptor.kind !== "action") {
      throw Error("Only action capabilities may run in an isolated worker");
    }
    // A later mutation of the caller's definition must not swap out the
    // implementation or input validator after a capability was registered.
    const inputSchema = definition.input;
    const isolatedRun = definition.isolatedSource === undefined
      ? null
      : createIsolatedActionRun({ source: definition.isolatedSource },
          definition.isolatedTimeoutMs === undefined ? {} : { timeoutMs: definition.isolatedTimeoutMs });
    const run = definition.run === undefined ? null : definition.run.bind(definition);
    return {
      id: descriptor.id,
      record: {
        ...descriptor, output: definition.output,
        run: (input, context) => isolatedRun
          ? isolatedRun(inputSchema.parse(input), context)
          : run!(inputSchema.parse(input), context),
      },
    };
  }
  register<I>(definition: Capability<I>): void {
    if (this.capabilities.has(definition.id)) throw Error("Duplicate capability");
    const prepared = this.prepareCapability(definition);
    this.capabilities.set(prepared.id, prepared.record);
  }
  private validate(raw: unknown): ModuleManifest {
    const manifest = ModuleManifestSchema.parse(raw);
    if (!manifest.permissions.includes("resource.read") && !manifest.permissions.includes("files.read")) throw Error("resource.read or files.read permission required");
    for (const c of manifest.contributions) {
      // 【MC-035】`module.<短名>` 是**扩展程序能力**:它的实现不在注册表里等着被引用,
      // 而是由本模块的 `program` 在安装期派生(见 prepareProgramBindings)。这里只挡形状 —— 短名
      // 必须是单段、清单引用的每个短名必须由 program 覆盖(由 ModuleManifestSchema 的
      // refine 与安装期核验共同保证)。指向**别的模块**的 `module.*` 不可能命中:
      // 分配后的 id 带模块 slug,validate 阶段看到的 `module.x` 不是宿主分配形状。
      const short = extensionCapabilityShortName(c.capability);
      if (short !== undefined) {
        if (manifest.program === undefined) throw Error("Module capability requires a program declaration");
        // 扩展能力默认按只读对待;`resource.write` 只影响执行期权限,不改变准入 ——
        // 程序是否真被放行写,由 invoke 的 action 判定 + OS 权限参数共同决定。
        if (!manifest.permissions.includes("resource.read") && !manifest.permissions.includes("files.read")) throw Error("resource.read or files.read permission required");
        continue;
      }
      // `module.` 前缀但不是合法单段短名(如 `module.a.b`):**明确拒绝**,不落进
      // "Unknown capability" —— 那条文案会让作者以为"能力忘了注册",而真相是短名形状不对。
      if (c.capability.startsWith(MODULE_CAPABILITY_PREFIX)) {
        throw Error("扩展能力短名必须是一段:module." + c.capability.slice(MODULE_CAPABILITY_PREFIX.length));
      }
      const capability = this.capabilities.get(c.capability);
      if (!capability) throw Error("Unknown capability: " + c.capability);
      // 【MC-060】v1 的安全默认仍在:**纯 JSON 清单不直接成为执行权限**。但一个**显式
      // 声明了 `resource.write`** 的模块,其 action 能力可以接进来 —— 这是台账要求的
      // 「先定义 action contract(资源作用域、sideEffect、审批),再实现受控 host」的第一步:
      // 「写权限」由 manifest **显式请求**,不再是无条件拒绝。真正的执行仍在 capability.run
      // (实现由宿主注册,不是清单里的一段脚本),且运行前 authorize(resource) 照走。
      // 没声明 resource.write 却想挂 action 能力的模块,照旧拒(不许靠一个 action 能力
      // 偷偷越过只读边界)。
      //
      // **判定只有一份**:`missingCapabilityPermission` 就是 register() 里那条对能力自身
      // 元数据用的**同一个**函数。两边各写一遍 `kind === "action"` 迟早漂移成两个真相
      // (「能力元数据自称只读、清单却已放行」),所以这里只消费那一份结果、只负责文案。
      const missing = missingCapabilityPermission(capability.kind, manifest.permissions);
      if (missing === "resource.write") {
        throw Error("Action capability requires the module to declare the resource.write permission");
      }
    }
    return manifest;
  }
  addBuiltin(raw: unknown): void {
    const manifest = this.validate(raw);
    if (!manifest.id.startsWith("core.") || this.modules.has(manifest.id)) throw Error("Invalid builtin module ID");
    // 【MC-035】内置模块不跑用户代码:带 program 的清单在这里就拒,不给"内置外壳
    // 包一段扩展代码"留下混合形态。
    if (manifest.program !== undefined) throw Error("Builtin modules cannot declare a program");
    this.modules.set(manifest.id, manifest); this.builtinIds.add(manifest.id);
  }
  /** 【MC-035】**把模块清单里的 `program` 派生成宿主能力** —— 安装、恢复共用这**一份**
   *  绑定逻辑(撤销由 {@link unbindProgram} 单点负责)。
   *
   *  分配规则:短名 `convert` → `module.<模块 slug>.convert`(见 `extensionCapabilityAssignment`)。
   *  每个被清单引用的短名注册成一个能力;引用它的是 action 类(`resource.write`)时按
   *  `action` 注册(执行前必审批),否则是 `query`。执行体一律 **受控子进程**
   *  (`runPermissionedProcess`)—— `run` 只做参数搬运,不在这里 eval 任何源码。
   *
   *  ⚠️ 同一模块的旧能力必须先撤(install 覆盖同 id 模块时),否则会撞上旧条目 ——
   *  调用方保证顺序(见 install/restore)。
   *
   *  【MC-035 更新切片】**只构造、不落表**:所有能力先经 `prepareCapability` 校验并
   *  造好记录(这一步会在分配 id 超长 / 与其它模块撞 id 时抛),再由调用方在
   *  **落盘之后、撤旧能力之前**用 `commitProgramBindings` 原子换入。这样「替换执行体」
   *  具备了台账要求的回滚保障:新版本只要有任何一条能力准备不了,旧执行体、磁盘清单、
   *  注册表都保持原样 —— 不会出现"旧能力已撤、盘上是新清单、新能力只绑了一半"。
   */
  private prepareProgramBindings(manifest: ModuleManifest): Array<{ id: string; record: ErasedCapability }> {
    if (manifest.program === undefined) return [];
    const isAction = manifest.permissions.includes("resource.write") || manifest.permissions.includes("files.write");
    const prepared: Array<{ id: string; record: ErasedCapability }> = [];
    const bound = new Set<string>();
    for (const contribution of manifest.contributions) {
      const short = extensionCapabilityShortName(contribution.capability);
      if (short === undefined) continue;
      const id = extensionCapabilityAssignment(manifest.id, short);
      // 同一个短名可能被多个贡献引用(不同视图/标题)—— 只注册一次。
      // ⚠️ 不用 `capabilities.has(id)` 判重:覆盖安装(同 id 模块、新版本/新源码)时
      // 旧能力还在注册表里,靠它跳过就会**沿用旧执行体**(台账:换版本不得继承旧实现)。
      // 调用方(install/restore)保证提交前该模块的旧能力已被 unbindProgram 撤掉。
      if (bound.has(id)) continue;
      bound.add(id);
      // 本模块覆盖安装/重启恢复时,旧能力还在注册表里(提交前才撤),允许被新一份替换;
      // 其它任何已存在的同名能力(宿主注册的实现、或不属于本模块的扩展能力)一律拒绝 ——
      // 否则覆盖安装会静默抢走别的能力的 id。
      const owner = this.extensionCapabilities.get(id);
      if (owner !== undefined && owner !== manifest.id) {
        throw Error(`能力 id ${id} 已被模块 ${owner} 占用,新模块未安装(旧模块保持原样)`);
      }
      if (owner === undefined && this.capabilities.has(id)) throw Error("Duplicate capability");
      const source = manifest.program.source;
      const timeoutMs = manifest.program.timeoutMs ?? 15_000;
      prepared.push(this.prepareCapability({
        id, kind: isAction ? "action" : "query",
        input: ResourceSchema, output: ResultSchema,
        run: async (resource, context) => {
          // 资源在 invoke 里已过 authorize;这里再解析出**真实路径**交给权限参数
          // (authorize 只判不返回)。逐次审批也已在 invoke 里完成 —— 不做第二套判定。
          if (declaresNetwork(manifest.permissions)) requireNetworkExtensionSupport();
          const realPath = await this.resolveResourcePath(resource);
          return runPermissionedProcess({
            source, capability: short,
            resource: { projectPath: resource.projectPath, path: realPath },
            allowWrite: isAction,
            // 【MC-035】网络是**显式**权限:清单声明 `network` 才放行。未声明时
            // 引导脚本会在扩展代码求值前把 http/net/dns/fetch 换成抛错函数 ——
            // 默认拒绝,而不是"Node 权限模型不管网络"的静默放行。
            // 【ARC-006 Gate E】与可执行体清单共用同一份判据（declaresNetwork），
            // 不在两处各写一遍 includes("network")。
            allowNetwork: declaresNetwork(manifest.permissions),
            timeoutMs,
            signal: context.signal,
            onAppCall: (method, input) => this.callAppFromExtension(manifest, method, input, context.signal),
          });
        },
      }));
    }
    return prepared;
  }
  /** 【MC-035】把 `prepareProgramBindings` 造好的记录一次性换入注册表。**只做内存操作、
   *  不会抛**(校验已在准备阶段完成);调用方须已 `unbindProgram` 清掉同模块旧能力。 */
  private commitProgramBindings(manifestId: string, prepared: ReadonlyArray<{ id: string; record: ErasedCapability }>): void {
    for (const entry of prepared) {
      this.capabilities.set(entry.id, entry.record);
      this.extensionCapabilities.set(entry.id, manifestId);
    }
  }
  /** 【MC-035】资源解析的**可选注入**:返回真实路径的解析器(通常是 `resolveModuleResource`)。
   *  未注入时退回字面 `resource.path` —— 授权判定仍由 `authorize` 完成,但扩展进程的
   *  `--allow-fs-read` 会按字面路径给,故生产装配**必须**注入。 */
  private async resolveResourcePath(resource: ModuleResource): Promise<string> {
    if (!this.options.resolveResource) return resource.path;
    return this.options.resolveResource(resource);
  }
  /** 【MC-035】撤掉某模块派生的全部扩展能力(卸载 / 重装前调用)。**幂等**。 */
  private unbindProgram(moduleId: string): void {
    for (const [id, owner] of [...this.extensionCapabilities]) {
      if (owner !== moduleId) continue;
      this.capabilities.delete(id);
      this.extensionCapabilities.delete(id);
    }
  }
  /** Restoration only after the host has validated its own persisted store.
   *
   *  【MC-035 更新切片】**先准备、后换入**:任一能力准备不了(分配 id 超长、与其它
   *  模块撞 id)时抛错,而注册表**一个条目都没有被改过** —— 调用方(生产 `service.ts`)
   *  显式记录并跳过这一条,其余模块照常恢复。旧实现边绑边注册,中途失败会留下半绑定
   *  的能力(一条不可见的 `module.*` 残留在目录里)。 */
  restore(raw: unknown): void {
    const manifest = this.validate(raw);
    if (!manifest.id.startsWith("user.") || this.modules.has(manifest.id)) throw Error("Invalid persisted module ID");
    const prepared = this.prepareProgramBindings(manifest);
    this.commitProgramBindings(manifest.id, prepared);
    this.modules.set(manifest.id, manifest);
  }
  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(fn);
    this.mutation = next.then(() => {}, () => {});
    return next;
  }
  /** Freshly read, shape-checked. A damaged ledger is never silently replaced. */
  private modulePermissionArchive(): ModulePermissionArchive {
    const raw = this.options.readModulePermissions?.() ?? null;
    if (raw === null) return {version:1, modules:{}};
    try { return ModulePermissionArchiveSchema.parse(JSON.parse(raw)); }
    catch (error) { throw Error("扩展权限授权表损坏，已拒绝执行或修改：" + (error instanceof Error ? error.message : String(error))); }
  }
  private manifestFingerprint(manifest: ModuleManifest): string {
    return createHash("sha256").update(JSON.stringify([
      manifest.id, manifest.version, [...manifest.permissions].sort(), manifest.program ?? null, manifest.contributions,
    ])).digest("hex");
  }
  private effectiveGrants(module: ModuleManifest): ModulePermissionRecord | null {
    const record = this.modulePermissionArchive().modules[module.id];
    return record && record.manifestVersion === module.version && record.fingerprint === this.manifestFingerprint(module)
      ? record : null;
  }
  private async writeModulePermissions(archive: ModulePermissionArchive): Promise<void> {
    if (!this.options.persistModulePermissions) throw Error("扩展权限必须持久化，当前宿主没有授权写入通道");
    await this.options.persistModulePermissions(JSON.stringify(ModulePermissionArchiveSchema.parse(archive), null, 2));
  }
  /** Pure host-side RPC authorization for trusted extension dispatchers only.
   *  The caller identity must be bound by the host (never from iframe/agent parameters).
   *  A blocked method is NEVER delegable, regardless of claimed grants. */
  authorizeAppMethod(moduleId: string, method: string): void {
    const manifest = this.modules.get(moduleId);
    if (!manifest || !moduleId.startsWith("user.")) throw moduleRefusalError("scope_denied", "找不到已安装的用户扩展");
    const grant = this.effectiveGrants(manifest);
    if (!grant) throw moduleRefusalError("scope_denied", "这个扩展没有有效的安装权限授权");
    try { assertAppMethodPermission(method,grant.granted); }
    catch (error) { throw moduleRefusalError("scope_denied",error instanceof Error ? error.message : String(error)); }
  }
  /** The child may ask for RPCs, but only this trusted host knows the installed identity.
   * Revalidate per call, including after revocation or replacement during a long RPC. */
  private async callAppFromExtension(manifest: ModuleManifest, method: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted || this.modules.get(manifest.id) !== manifest) throw Error("扩展执行已取消或替换");
    if (!this.capabilities.has("core.app.call")) throw Error("core.app.call 宿主能力未注册");
    if (!this.options.invokeAppCall) throw Error("core.app.call 宿主 RPC 通道不可用");
    this.authorizeAppMethod(manifest.id, method);
    if (signal.aborted) throw Error("扩展执行已取消");
    const value = await this.options.invokeAppCall(manifest.id, method, input, signal);
    if (signal.aborted || this.modules.get(manifest.id) !== manifest) throw Error("扩展执行已取消或替换");
    this.authorizeAppMethod(manifest.id, method);
    return value;
  }
  /** Host-validated grant update; never accepts permissions absent from the installed manifest. */
  setPermissions(raw: unknown): Promise<ModuleCatalog> {
    return this.serializeMutation(async () => {
      const input = raw as { moduleId?: string; grantedPermissions?: ModulePermission[] };
      const module = typeof input?.moduleId === "string" ? this.modules.get(input.moduleId) : undefined;
      if (!module || !module.id.startsWith("user.")) throw Error("只能修改已安装用户扩展的权限");
      const granted = input.grantedPermissions;
      if (!Array.isArray(granted)) throw Error("缺少 grantedPermissions");
      assertModuleGrants(module, granted);
      const archive = this.modulePermissionArchive();
      const before = archive.modules[module.id]?.granted ?? [];
      archive.modules[module.id] = {granted:[...granted],grantedAt:new Date().toISOString(),manifestVersion:module.version,fingerprint:this.manifestFingerprint(module)};
      await this.writeModulePermissions(archive);
      if (before.some(permission => !granted.includes(permission))) this.cancelRunningTasksOf(module.id);
      return this.catalog();
    });
  }
  install(raw: unknown, grantedPermissions?: readonly ModulePermission[]): Promise<ModuleChangeResult> {
    return this.serializeMutation(async () => {
      const manifest = this.validate(raw);
      if (grantedPermissions !== undefined) assertModuleGrants(manifest, grantedPermissions);
      if (grantedPermissions === undefined && manifest.permissions.some(p => p !== "resource.read" && p !== "resource.write" && p !== "network")) {
        throw Error("新权限模型的扩展必须在安装时逐项确认授权");
      }
      if (!manifest.id.startsWith("user.")) throw Error("External IDs must start with user.");
      if (!this.modules.has(manifest.id) && this.modules.size >= 32) throw Error("Module limit reached");
      // Windows 不能安全提供声明 network 的扩展执行环境；安装阶段就给出明确指引。
      // 重启恢复的旧清单也由 prepareProgramBindings 的执行口再次防守。
      if (manifest.program !== undefined && declaresNetwork(manifest.permissions)) requireNetworkExtensionSupport();
      // 【MC-035】带执行程序的扩展:**落盘之前**先在受控进程里核验(求值工厂、确认每个
      // 被引用的短名都是函数)。核验不过 → 安装失败,清单不写、能力不注册、磁盘不变
      // (台账验收:"失败安装不污染注册表或磁盘")。
      if (manifest.program !== undefined) {
        if (!this.options.verifyProgram) {
          throw Error("当前环境没有可用的扩展程序核验通道,已拒绝安装可执行扩展(fail-closed)");
        }
        const referenced = [...new Set(manifest.contributions
          .map(c => extensionCapabilityShortName(c.capability))
          .filter((v): v is string => v !== undefined))];
        const verdict = await this.options.verifyProgram(manifest.program.source, referenced, manifest.program.timeoutMs);
        if (!verdict.ok) throw Error("扩展程序核验失败,未安装:" + verdict.reason);
      }
      const next = new Map(this.modules); next.set(manifest.id, manifest);
      // 【MC-035 更新切片】**先把新执行体全部准备（校验+构造）好，再动磁盘和注册表**。
      // 旧实现是「落盘 → 撤旧能力 → 边绑边校验」：新清单的任何一条能力在绑定时失败
      // （分配 id 超过 `Id` 上限被 `ModuleCapabilityDescriptorSchema` 拒、或与其它模块
      // 撞分配 id），都会留下「旧执行体已撤、盘上却是新清单、新能力只注册了一半」的
      // 坏状态 —— 覆盖安装失败后既不能回滚也不能用。现在：准备阶段任何一步抛错，
      // 磁盘清单与旧执行体都**保持原样**（台账：安装失败必须保留上一版）。
      const prepared = this.prepareProgramBindings(manifest);
      // 【ARC-006 Gate E】升级（同 id 重装）时**旧授权必须失效** —— 台账 MERGE-4：
      // 「升级/卸载/撤权不留下可执行体」。执行体换了，旧的工作流运行授权不该自动
      // 适用于新代码：用户批准的是**那一版**的只读行为。判据不是「版本号变了」一条
      // —— 同版本重装换源码（重打包、改了程序）同样换执行体；版本号或执行体任一
      // 变化都撤。纯声明式模块（没有 program）没有可执行体，版本变化仍按发布单位撤
      // （新版本的能力面可能变）。清单完全相同（no-op 重装）不撤 —— 没换执行体。
      const previous = this.modules.get(manifest.id);
      // 【MC-036】同版本、同源码不等于同执行权限。若清单新增 network、
      // 改动允许的文件扩展名/贡献引用，旧工作流授权不能自动授权新的行为。
      // 标题等纯展示元信息可正常更新，不无故撤销已获批准的只读任务。
      const executionChanged = previous !== undefined && (
        previous.version !== manifest.version
        || JSON.stringify(previous.program ?? null) !== JSON.stringify(manifest.program ?? null)
        || JSON.stringify([...previous.permissions].sort()) !== JSON.stringify([...manifest.permissions].sort())
        || JSON.stringify(previous.contributions) !== JSON.stringify(manifest.contributions)
      );
      // **事务顺序（失败方向即判据）**：先撤授权（收紧方向）、再写清单；清单写失败
      // 就把授权**回滚**回原样，于是「升级中途失败 → 旧版仍可执行、新版不落盘、
      // 授权不变」三条同时成立。反向顺序（先写清单后撤授权）一旦撤授权失败，就会
      // 留下「新代码带着旧授权」的放宽 —— 那正是要堵的洞。
      // 崩溃窗口（撤了授权、清单还没写就断电）最坏是旧版少一条授权：收紧、可重新
      // 授权，不是放宽。
      // Validate stale consent BEFORE any write or workflow grant purge; failure must not
      // invalidate a still-installed version's authorization.
      const priorConsent = this.modulePermissionArchive().modules[manifest.id];
      if (executionChanged && grantedPermissions === undefined && priorConsent?.granted.length) {
        throw Error("扩展的权限或执行内容已变化，请重新逐项同意授权");
      }
      const purged = executionChanged ? await this.purgeWorkflowGrantsFor(manifest.id) : null;
      // Consent is bound to a version and an execution fingerprint, not a module ID alone.
      const permissionArchive = this.modulePermissionArchive();
      const oldPermissionArchive = structuredClone(permissionArchive);
      const previousRecord = permissionArchive.modules[manifest.id];
      if (grantedPermissions !== undefined) {
        permissionArchive.modules[manifest.id] = {
          granted:[...grantedPermissions], grantedAt:new Date().toISOString(),
          manifestVersion:manifest.version, fingerprint:this.manifestFingerprint(manifest),
        };
      } else if (executionChanged && previousRecord) {
        delete permissionArchive.modules[manifest.id];
        if (previousRecord.granted.length) throw Error("扩展的权限或执行内容已变化，请重新逐项同意授权");
      }
      const permissionsChanged = JSON.stringify(permissionArchive) !== JSON.stringify(oldPermissionArchive);
      try {
        if (permissionsChanged) await this.writeModulePermissions(permissionArchive);
        await this.options.persist([...next.values()].filter(m => !this.builtinIds.has(m.id)));
      } catch (error) {
        if (permissionsChanged) {
          try { await this.writeModulePermissions(oldPermissionArchive); }
          catch (rollbackError) { throw Error("安装失败且权限回滚失败，已拒绝后续调用：" + String(rollbackError)); }
        }
        if (purged !== null) {
          try {
            await this.writeGrantsOrRefuse(purged.restore);
          } catch (rollbackError) {
            throw Error(
              "升级写盘失败,且旧授权回滚也失败(旧版本仍在,工作流授权可能已丢失,请重新授权):"
              + (error instanceof Error ? error.message : String(error))
              + " / 回滚:" + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
            );
          }
        }
        throw error;
      }
      // 【ARC-006 Gate E】换了执行体就把旧版本**正在运行**的任务取消掉 —— 否则它们
      // 跑完后会把结果写回一个已不存在的版本（旧执行体继续影响世界）。放在清单
      // 落盘之后、换执行体之前：清单写失败时不误杀旧任务（失败升级 = 什么都没发生）。
      // 取消是协作式的（任务的 AbortController），不杀进程；`finish` 是幂等的，
      // 取消后迟到的结果不会把状态改回 completed（见 `finish` 的状态守卫）。
      const change = executionChanged
        ? this.cancelRunningTasksOf(manifest.id)
        : { moduleId: manifest.id, cancelledTasks: 0, cancelFailures: [] };
      // 覆盖同 id 模块时先撤旧能力再换入新能力 —— 否则会沿用旧执行体
      // （台账：换版本不得继承旧实现）。commit 只做内存 put，不会失败。
      this.unbindProgram(manifest.id);
      this.commitProgramBindings(manifest.id, prepared);
      this.modules.set(manifest.id, manifest);
      this.reportChange(change);
      return { catalog: this.catalog(), cancelledTasks: change.cancelledTasks, cancelFailures: change.cancelFailures };
    });
  }
  /** 【ARC-006 Gate E】**撤掉某模块的全部工作流运行授权**（升级换执行体时调用）。
   *
   *  返回被撤掉的完整存档（调用方在后续步骤失败时据此**回滚**，让「升级中途失败 →
   *  授权不变」成立）；本来没有该模块的授权时返回 `null`。
   *
   *  判据（全部 fail-closed，撤不干净就不升级）：
   *   - 坏授权表 → **拒绝**（不能拿空表覆盖读不懂的账）；
   *   - 没有持久化端口 → 拒绝（与签发同一条：授权必须跨重启有效，不能只活在内存里）。
   */
  private async purgeWorkflowGrantsFor(
    moduleId: string,
  ): Promise<{ restore: readonly ModuleWorkflowGrant[] } | null> {
    const archive = this.workflowGrants();
    if (archive.state === "corrupt") {
      throw Error(`工作流授权表损坏(${archive.reason}),已拒绝升级(无法确认旧授权已撤销;先修复或删除「ui-modules/workflow-grants.json」)`);
    }
    if (archive.state !== "valid") return null;
    const remaining = archive.grants.filter((grant) => grant.moduleId !== moduleId);
    if (remaining.length === archive.grants.length) return null;
    await this.writeGrantsOrRefuse(remaining);
    return { restore: archive.grants };
  }
  /** 【ARC-006 Gate E】**取消某模块全部正在运行的任务**（升级换执行体 / 卸载时）。
   *
   *  ## 语义
   *
   *  - **协作式**：走任务自己的 `AbortController`（扩展代码拿到的是 `signal`），
   *    不 kill 进程、不强制中断；
   *  - **先结算再通知**：`finish(job, "cancelled")` 有状态守卫（只从 `running`
   *    迁移一次），之后扩展代码即使无视 signal、迟到了结果，`finish` 也不会把它
   *    改回 `completed` —— 取消后旧结果**不写回**；
   *  - **如实上报**：返回被取消的任务数与取消时抛错的任务（`cancel` 是同步内存
   *    操作，理论上不抛；出口留着是为了将来异步收尾失败也可见，不静默）。
   *
   * 与 `remove` 里原来那段内联循环是同一条判据；两处共用一个函数，避免漂移。 */
  private cancelRunningTasksOf(moduleId: string): ModuleChangeOutcome {
    const outcome: ModuleChangeOutcome = { moduleId, cancelledTasks: 0, cancelFailures: [] };
    // Query / action 虽然不签发持久 job handle，仍可能在 await 的受控子进程中运行。
    // 原先卸载仅取消 task，旧 query 会在模块删除后继续返回成功；这里同步请求取消。
    for (const controller of this.activeInvocations.get(moduleId) ?? []) controller.abort();
    for (const job of [...this.jobs.values()]) {
      if (job.snapshot.moduleId !== moduleId || job.snapshot.status !== "running") continue;
      try {
        this.cancel({ moduleId, taskId: job.snapshot.id });
        outcome.cancelledTasks += 1;
      } catch (error) {
        outcome.cancelFailures.push({
          taskId: job.snapshot.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  }
  /** 变更诊断只回调、不改变事务结果（没有端口 = 不报告，不是失败）。 */
  private reportChange(outcome: ModuleChangeOutcome): void {
    try {
      this.options.onChanged?.(outcome);
    } catch {
      /* 诊断端点的异常不翻案一次已经落定的变更 */
    }
  }
  remove(id: string): Promise<ModuleChangeResult> {
    return this.serializeMutation(async () => {
      if (this.builtinIds.has(id)) throw Error("Builtin module cannot be removed");
      if (!this.modules.has(id)) throw Error("Unknown module");
      // 【MC-036】卸载首先撤销旧授权，再持久化删清单。原实现先删除模块
      // 再尝试撤授权、却吞掉撤销写盘错误：未来装回同名同版本会复活旧授权。
      // 授权表坏掉/撤销失败时不能声称卸载成功；清单写盘失败需回滚已撤授权，
      // 保持与升级 install 一致的 fail-closed 事务顺序。
      const purged = await this.purgeWorkflowGrantsFor(id);
      const permissionArchive = this.modulePermissionArchive();
      const oldPermissionArchive = structuredClone(permissionArchive);
      delete permissionArchive.modules[id];
      const permissionsChanged = JSON.stringify(permissionArchive) !== JSON.stringify(oldPermissionArchive);
      try {
        if (permissionsChanged) await this.writeModulePermissions(permissionArchive);
        await this.options.persist([...this.modules.values()].filter(m => m.id !== id && !this.builtinIds.has(m.id)));
      } catch (error) {
        if (permissionsChanged) {
          try { await this.writeModulePermissions(oldPermissionArchive); }
          catch (rollbackError) { throw Error("卸载失败且权限回滚失败，已拒绝后续调用：" + String(rollbackError)); }
        }
        if (purged !== null) {
          try {
            await this.writeGrantsOrRefuse(purged.restore);
          } catch (rollbackError) {
            throw Error(
              "卸载写盘失败，且旧授权回滚也失败（模块仍在，授权需重新核对）："
              + (error instanceof Error ? error.message : String(error))
              + " / 回滚:" + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
            );
          }
        }
        throw error;
      }
      this.modules.delete(id);
      // 【MC-035】撤销该模块派生的扩展能力 —— 能力注册表与模块清单同生共死:
      // 卸载后再调它的 `module.*` 能力只会在 invoke 的"能力不可用"处失败。
      this.unbindProgram(id);
      // 【ARC-006 Gate E】取消该模块所有运行中任务（协作式，走任务自己的 AbortSignal）。
      // 与 install 共用同一个 `cancelRunningTasksOf` —— 两处各写一份循环迟早漂移。
      const change = this.cancelRunningTasksOf(id);
      this.reportChange(change);
      return { catalog: this.catalog(), cancelledTasks: change.cancelledTasks, cancelFailures: change.cancelFailures };
    });
  }
  /** 【MC-035】贡献引用的**实际注册 id**:内置能力就是清单里写的 id;扩展程序能力则是
   *  宿主分配后的 `module.<slug>.<短名>`。目录/执行/workflow 目标**只**经这一个函数把
   *  清单引用翻成注册表键,不在各处各写一遍拼接。 */
  private capabilityIdOf(module: ModuleManifest, capabilityRef: string): string {
    const short = extensionCapabilityShortName(capabilityRef);
    return short === undefined ? capabilityRef : extensionCapabilityAssignment(module.id, short);
  }
  /** A core-looking ID is not proof of trust. Only the host's actual builtin
   * registration, an existing contribution and a live read-only capability
   * may produce a workflow target (and pass the workflow invocation gate).
   *
   * 【MC-036】`user.*` 模块的第二个来源:一条**宿主核验过**的工作流运行授权
   * (`readWorkflowGrants` 的存档,绑定模块身份/版本/能力/工作区)。这里只做
   * 「目标形状 + 只读类别」判定;**授权本身**在 `authorizedWorkflowTarget` 里按
   * 具体运行的工作区再核一次 —— 目录只发布"有授权可依"的目标,执行口用同一份
   * 授权结果判放行。两条路都不碰 `builtinIds` 之外的隐式信任:没有 grant 的
   * 用户模块在两边都不可用。 */
  private readonlyWorkflowTarget(moduleId: string, contributionId: string): ModuleWorkflowTarget | undefined {
    if (!this.builtinIds.has(moduleId) && !moduleId.startsWith("user.")) return undefined;
    const module = this.modules.get(moduleId);
    const contribution = module?.contributions.find(c => c.id === contributionId);
    const capabilityId = module !== undefined && contribution !== undefined ? this.capabilityIdOf(module, contribution.capability) : undefined;
    const capability = capabilityId !== undefined ? this.capabilities.get(capabilityId) : undefined;
    if (!capability || (capability.kind !== "query" && capability.kind !== "task")) return undefined;
    return {moduleId, contributionId, capabilityId: capability.id};
  }
  /** 【MC-036】授权存档的**唯一读取点**。每次调用现读注入源(文件 / 桩),于是
   * 撤销在下一次判定立刻生效,不需要重启。坏存档整表不信任(fail-closed),并
   * 把原因随目录带给 UI 做显式诊断。 */
  private workflowGrants(): ModuleWorkflowGrantArchive {
    let raw: string | null = null;
    try {
      raw = this.options.readWorkflowGrants?.() ?? null;
    } catch (error) {
      // 读不动(文件权限 / 桩抛错)与"读不懂"同一档:没有可核验的授权 → 不可用。
      return { state: "corrupt", reason: `授权表读取失败:${error instanceof Error ? error.message : String(error)}` };
    }
    return classifyModuleWorkflowGrants(raw);
  }
  /** 【MC-036】**工作流运行权的唯一判据** —— `catalog.workflowTargets`、
   * `invokeForWorkflow` 与执行器共用这一份结果。
   *
   *  - 内置模块:宿主真实 `addBuiltin` 登记 + 只读贡献(与从前一致,判据未放宽);
   *  - 用户模块:同一条只读贡献判定 **且** 存在一条绑定 (模块 id、模块版本、
   *    贡献、能力、**本次运行的工作区根**) 的授权记录。版本/能力/贡献/工作区
   *    任一变化,旧记录不再命中 —— grant 失效。
   *
   * `projectPath` 为 `undefined` 时(目录枚举)只要求"至少有任一工作区的有效授权";
   * 执行时永远给具体工作区,所以"换个项目跑"不会被旧授权覆盖。 */
  private authorizedWorkflowTarget(moduleId: string, contributionId: string, archive: ModuleWorkflowGrantArchive, projectPath?: string): ModuleWorkflowTarget | undefined {
    const target = this.readonlyWorkflowTarget(moduleId, contributionId);
    if (!target) return undefined;
    if (this.builtinIds.has(moduleId)) return target;
    const module = this.modules.get(moduleId);
    if (!module) return undefined;
    if (archive.state !== "valid") return undefined;
    const hit = archive.grants.some(grant =>
      grant.moduleId === module.id
      && grant.moduleVersion === module.version
      && grant.contributionId === contributionId
      && grant.capabilityId === target.capabilityId
      // 【MC-036】工作区按归一后的字面位置比对(契约包 `sameWorkflowGrantPath`):
      // 授权时的写法与本次运行的 `context.cwd` 不保证逐字节相同,裸 `===` 会让合法
      // 授权假失配(fail-closed 但不可用)。大小写折叠按平台给(Windows/macOS)。
      && (projectPath === undefined || sameWorkflowGrantPath(grant.projectPath, projectPath, CASE_INSENSITIVE_PATHS)));
    return hit ? target : undefined;
  }
  /** 【MC-036】目录里给授权面板的候选人:用户模块的只读贡献 + 已有授权的工作区。
   * 只发布**形状合法且指向已注册只读能力**的贡献;未授权也列出(那正是可授权的对象)。 */
  private grantCandidates(archive: ModuleWorkflowGrantArchive): ModuleWorkflowGrantCandidate[] {
    const grants = archive.state === "valid" ? archive.grants : [];
    const candidates: ModuleWorkflowGrantCandidate[] = [];
    for (const module of this.modules.values()) {
      if (!module.id.startsWith("user.")) continue;
      for (const contribution of module.contributions) {
        const target = this.readonlyWorkflowTarget(module.id, contribution.id);
        if (!target) continue;
        const mine = grants
          .filter(grant => grant.moduleId === module.id && grant.moduleVersion === module.version
            && grant.contributionId === contribution.id && grant.capabilityId === target.capabilityId)
          .map(grant => ({ projectPath: grant.projectPath, grantedAt: grant.grantedAt }));
        candidates.push({ moduleId: module.id, moduleVersion: module.version, contributionId: contribution.id, capabilityId: target.capabilityId, grants: mine });
      }
    }
    return candidates;
  }
  /** 【MC-036】**工作流运行权的唯一判据**(单次判定用:现读一份授权存档) —— 与
   * `catalog` 内循环调的是同一个 `authorizedWorkflowTarget`;这里只负责"取当前存档"。 */
  private authorizedWorkflowTargetNow(moduleId: string, contributionId: string, projectPath?: string): ModuleWorkflowTarget | undefined {
    return this.authorizedWorkflowTarget(moduleId, contributionId, this.workflowGrants(), projectPath);
  }
  /** 【MC-036】当前授权存档的健康度(目录里带给 UI;corrupt 时附原因,显式诊断)。 */
  workflowGrantStatus(): { archive: "absent" | "valid" | "corrupt"; reason?: string } {
    const archive = this.workflowGrants();
    if (archive.state === "corrupt") return { archive: "corrupt", reason: archive.reason };
    return { archive: archive.state };
  }
  catalog(): ModuleCatalog {
    // 授权存档一次读出,供目标发布 / 候选人 / 健康度三处共用 —— 目录读取只碰一次持久层。
    const archive = this.workflowGrants();
    const workflowTargets: ModuleWorkflowTarget[] = [];
    const publishable = [...this.builtinIds, ...[...this.modules.keys()].filter(id => id.startsWith("user."))];
    for (const id of publishable) {
      const module = this.modules.get(id);
      if (!module) continue;
      for (const contribution of module.contributions) {
        const target = this.authorizedWorkflowTarget(id, contribution.id, archive);
        if (target) workflowTargets.push(target);
      }
    }
    const capabilities: ModuleCapabilityDescriptor[] = [...this.capabilities.values()].map(({id,kind,metadata}) => ({
      id, kind, ...(metadata === undefined ? {} : {metadata}),
    }));
    // Only display grants that still match the installed code and manifest.
    const modulePermissions: Record<string, { granted: ModulePermission[]; grantedAt: string } | null> = {};
    for (const module of this.modules.values()) {
      if (module.id.startsWith("user.")) {
        const record = this.effectiveGrants(module);
        modulePermissions[module.id] = record ? {granted:[...record.granted],grantedAt:record.grantedAt} : null;
      }
    }
    return structuredClone({
      modules: [...this.modules.values()], capabilities, workflowTargets, modulePermissions,
      workflowGrantCandidates: this.grantCandidates(archive),
      workflowGrantStatus: archive.state === "corrupt" ? { archive: "corrupt", reason: archive.reason } : { archive: archive.state },
    });
  }
  /** Host-internal workflow entry. Never expose this through IPC/preload: a
   * renderer is not permitted to self-declare automated-run authorization. */
  async invokeForWorkflow(input: ModuleInvoke): Promise<ModuleReply> {
    const parsed = ModuleInvokeSchema.parse(input);
    await this.mutation;
    // 【MC-036】按**本次运行的工作区**核授权:菜单可调用(user.* 有 resource.read)不等于
    // 可自动运行;没有覆盖该工作区的 grant 时与从前一样拒绝,但文案说清楚缺什么。
    if (parsed.moduleId.startsWith("user.")) {
      if (!this.authorizedWorkflowTargetNow(parsed.moduleId, parsed.contributionId, parsed.resource.projectPath)) {
        throw Error("用户模块在工作流中运行需要宿主核验的工作流授权(模块/版本/能力/工作区),请在模块设置里授权");
      }
    } else if (!this.authorizedWorkflowTargetNow(parsed.moduleId, parsed.contributionId)) {
      throw Error("工作流需要一个已注册的内置只读贡献");
    }
    // Reuse the menu's envelope, contribution, extension, realpath/known-root
    // authorization, task limits, cancellation and request-id deduplication.
    return this.invoke(parsed, { requireWorkflowGrant: true });
  }
  /** 【MC-036】**签发**一条工作流运行授权。只有真人经桌面 IPC 调到这里 —— 本方法
   * 不暴露给工作流/Agent(IPC 侧在 `appControl/policy.ts` 钉 blocked)。宿主核验:
   * 模块存在且是 `user.*`、版本与当前清单一致、贡献存在且指向已注册的只读 query/task 能力。
   * 重复签发是幂等的(同一 (模块,版本,贡献,能力,工作区) 只保留一条,刷新 `grantedAt`)。 */
  issueWorkflowGrant(raw: unknown): Promise<ModuleWorkflowGrant> {
    return this.serializeMutation(async () => {
      const input = parseGrantInput(raw);
      const module = this.modules.get(input.moduleId);
      if (!module || !module.id.startsWith("user.")) throw Error("只能给已安装的用户模块签发工作流授权");
      if (module.version !== input.moduleVersion) throw Error("模块版本已变化,请按当前版本重新授权");
      const target = this.readonlyWorkflowTarget(module.id, input.contributionId);
      if (!target || target.capabilityId !== input.capabilityId) throw Error("该贡献不是可授权的只读能力(已变化或不存在)");
      const archive = this.workflowGrants();
      if (archive.state === "corrupt") {
        throw Error(`工作流授权表损坏(${archive.reason}),已拒绝签发以免覆盖原存档;修复请删除或改正文件「ui-modules/workflow-grants.json」后重启。`);
      }
      const grant: ModuleWorkflowGrant = {
        moduleId: module.id, moduleVersion: module.version,
        contributionId: input.contributionId, capabilityId: target.capabilityId,
        projectPath: input.projectPath, grantedAt: Date.now(),
      };
      // 【MC-036】幂等键的**工作区**那一段也归一:同一目录换个写法
      // (`D:\proj` / `d:\proj\` / `D:\proj\.`)是**一条**授权(刷新),不是三条。
      const key = moduleWorkflowGrantKey(input, CASE_INSENSITIVE_PATHS);
      const next = (archive.state === "valid" ? archive.grants : []).filter(existing => moduleWorkflowGrantKey(existing, CASE_INSENSITIVE_PATHS) !== key);
      next.push(grant);
      await this.writeGrantsOrRefuse(next);
      return grant;
    });
  }
  /** 【MC-036】**撤销**一条工作流运行授权(按同一幂等键)。幂等:目标状态达成即可。 */
  revokeWorkflowGrant(raw: unknown): Promise<{ revoked: boolean }> {
    return this.serializeMutation(async () => {
      const input = parseGrantInput(raw);
      const archive = this.workflowGrants();
      if (archive.state === "corrupt") {
        throw Error(`工作流授权表损坏(${archive.reason}),无法安全撤销;修复请删除或改正文件「ui-modules/workflow-grants.json」后重启。`);
      }
      if (archive.state === "absent") return { revoked: false };
      const key = moduleWorkflowGrantKey(input, CASE_INSENSITIVE_PATHS);
      const next = archive.grants.filter(existing => moduleWorkflowGrantKey(existing, CASE_INSENSITIVE_PATHS) !== key);
      if (next.length === archive.grants.length) return { revoked: false };
      await this.writeGrantsOrRefuse(next);
      // 存档已确认落盘之后，撤销才真正生效。正在运行的工作流也必须
      // 收到取消通知（菜单 query 与其它工作区 grant 不应受影响）。
      for (const controller of this.activeWorkflowInvocations.get(key) ?? []) controller.abort();
      for (const job of [...this.jobs.values()]) {
        if (job.workflowGrantKey === key && job.snapshot.status === "running") {
          this.cancel({ moduleId: job.snapshot.moduleId, taskId: job.snapshot.id });
        }
      }
      return { revoked: true };
    });
  }
  /** 写授权的唯一出口:没有持久化端口 → **拒绝签发**(fail-closed,不能"只存在内存里
   * 假装授过权");落盘成功才发布(与 `commitHooks` 同一条:先持久、后宣告)。 */
  private async writeGrantsOrRefuse(grants: readonly ModuleWorkflowGrant[]): Promise<void> {
    if (!this.options.persistWorkflowGrants) throw Error("当前环境没有工作流授权的持久化通道,已拒绝签发(授权必须跨重启有效)");
    await this.options.persistWorkflowGrants(serializeModuleWorkflowGrants(grants));
  }
  private finish(job: LiveTask, status: ModuleTask["status"], result?: ModuleResult, error?: string): void {
    if (job.snapshot.status !== "running") return;
    clearTimeout(job.timer);
    Object.assign(job.snapshot, { status, updatedAt: Date.now(), ...(result ? {result,progress:1} : {}), ...(error ? {error:error.slice(0,2000)} : {}) });
  }
  async invoke(raw: unknown, internal: { requireWorkflowGrant?: boolean } = {}): Promise<ModuleReply> {
    const input = ModuleInvokeSchema.parse(raw);
    await this.mutation;
    const module = this.modules.get(input.moduleId);
    const contribution = module?.contributions.find(c => c.id === input.contributionId);
    if (!module || !contribution) throw Error("模块或贡献不可用");
    const definition = this.capabilities.get(this.capabilityIdOf(module, contribution.capability));
    if (!definition) throw Error("能力不可用");
    const resource = ResourceSchema.parse(input.resource);
    if (contribution.slot === "files.context" && contribution.extensions && !contribution.extensions.some(ext => resource.path.toLowerCase().endsWith(ext))) throw Error("不支持的文件类型");
    await this.options.authorize(resource);
    // Authorization may await disk IO while a module is replaced/removed.
    if (this.modules.get(input.moduleId) !== module) throw Error("模块已变化,请按其当前定义重试");
    // 【MC-060】`action` 能力的**受控执行宿主**:准入(能否挂这个能力)在 register/validate 已判;
    // 这里有**第二层** —— 每一次 `action` 执行前,必须①模块清单显式持有 `resource.write`(作用域),
    // ②存在审批通道,再③经该通道拿到批准。三条任一不满足即拒,且绝不落到执行。判定复用
    // `@contracts/modules` 的 `actionInvocationRefusal`(只有这一份),host 只负责问审批端口、
    // 拒绝时抛**带 code 的拒绝**(命令没执行 → 上层按 REJECTED 归类,绝不误报成 UNCERTAIN)。
    // 资源作用域已由上面的 `authorize(resource)` 建立,审批请求把同一资源一并交上去,
    // 让批准方看到"批的是哪个模块贡献、动哪个文件"。action 之外(query/task)不受影响。
    const record = this.modulePermissionArchive().modules[module.id];
    const grant = this.effectiveGrants(module);
    if (record !== undefined && grant === null) throw moduleRefusalError("scope_denied", "扩展权限或版本已变化，必须重新授权");
    // Legacy installs (without a user-consent record) retain the old per-invocation approval
    // until migrated. Installs with a record NEVER fall back to prompt-based approval.
    const explicit = grant !== null;
    const requireGrant = (permission: ModulePermission): void => {
      if (explicit && !grant.granted.includes(permission)) {
        throw moduleRefusalError("scope_denied", `这个扩展没有 ${permission} 权限`);
      }
    };
    requireGrant(module.permissions.includes("files.read") ? "files.read" : "resource.read");
    if (definition.kind === "action") requireGrant(module.permissions.includes("files.write") ? "files.write" : "resource.write");
    if (module.program && module.permissions.includes("code.execute")) requireGrant("code.execute");
    if (declaresNetwork(module.permissions)) requireGrant("network");
    const refusal = actionInvocationRefusal(definition.kind, module.permissions, explicit || this.options.requestApproval !== undefined);
    if (refusal) throw moduleRefusalError(refusal.code, refusal.reason);
    // 【MC-035】联网与写入是不同的真人授权：写权限审批不会说明「还将联网」。
    // 因此 query/task 在需要时审批 network；同时声明 write+network 的 action
    // 也必须先独立获准 network，再由下方既有 write 审批授权本次写入。
    if (declaresNetwork(module.permissions) && !explicit) {
      if (this.options.requestApproval === undefined) {
        throw moduleRefusalError("approval_unavailable", "这个扩展声明了网络权限,但当前没有审批通道 —— 不会在未经用户同意的情况下联网。");
      }
      try {
        await this.options.requestApproval({
          moduleId: module.id, contributionId: contribution.id, capabilityId: definition.id,
          resource: structuredClone(resource), scope: "network",
        });
      } catch (error) {
        const already = moduleRefusal(error);
        throw already ? error : moduleRefusalError("approval_denied", error instanceof Error ? error.message : String(error));
      }
      if (this.modules.get(input.moduleId) !== module) throw Error("模块已变化,请按其当前定义重试");
    }
    if (definition.kind === "action" && !explicit) {
      // 无审批通道已在上一步被拒,故这里 `requestApproval` 必存在;resolve 放行,reject 原样抛。
      try {
        await this.options.requestApproval!({
          moduleId: module.id, contributionId: contribution.id, capabilityId: definition.id,
          resource: structuredClone(resource), scope: "write",
        });
      } catch (error) {
        // 审批端口拒绝(resolve=批准,reject=拒绝)。已经带拒绝标记的原样抛(不重复包);
        // 否则包成 `approval_denied` —— 用户/批准方拒绝 = 命令没执行,上层应按 REJECTED 归类。
        const already = moduleRefusal(error);
        throw already ? error : moduleRefusalError("approval_denied", error instanceof Error ? error.message : String(error));
      }
      // 审批可能挂起等待用户;期间模块若被换/撤,按变化重来(与 authorize 后的同一取向)。
      if (this.modules.get(input.moduleId) !== module) throw Error("模块已变化,请按其当前定义重试");
    }
    // Revoking or changing a grant while the old approval UI is suspended must not
    // allow dispatch under stale consent.
    if (explicit) {
      const now = this.effectiveGrants(module);
      if (!now || JSON.stringify(now.granted.slice().sort()) !== JSON.stringify(grant.granted.slice().sort())) {
        throw moduleRefusalError("scope_denied", "扩展授权已变更，拒绝执行");
      }
    }
    // 【MC-036】工作流授权在进入函数时读一次远远不够：authorize/真人审批
    // 可能挂起，期间另一个调用撤销了授权。真正派发前必须以本次工作区重新核验。
    // 普通用户菜单调用不带这个内部收紧标志，其本来就不需要工作流 grant。
    if (internal.requireWorkflowGrant &&
      !this.authorizedWorkflowTargetNow(module.id, contribution.id, resource.projectPath)) {
      throw Error("工作流授权已撤销或变更，拒绝继续执行，请重新授权");
    }
    const workflowGrantKey = internal.requireWorkflowGrant && module.id.startsWith("user.")
      ? moduleWorkflowGrantKey({
          moduleId: module.id, moduleVersion: module.version,
          contributionId: contribution.id, capabilityId: definition.id,
          projectPath: resource.projectPath,
        }, CASE_INSENSITIVE_PATHS)
      : undefined;
    if (definition.kind !== "task") {
      const controller = new AbortController();
      let running = this.activeInvocations.get(module.id);
      if (!running) {
        running = new Set<AbortController>();
        this.activeInvocations.set(module.id, running);
      }
      running.add(controller);
      let workflowRunning: Set<AbortController> | undefined;
      if (workflowGrantKey !== undefined) {
        workflowRunning = this.activeWorkflowInvocations.get(workflowGrantKey);
        if (!workflowRunning) {
          workflowRunning = new Set<AbortController>();
          this.activeWorkflowInvocations.set(workflowGrantKey, workflowRunning);
        }
        workflowRunning.add(controller);
      }
      try {
        const value = definition.output.parse(await definition.run(resource, {
          signal: controller.signal, progress: () => {},
        }));
        // 执行体即使不理会 AbortSignal，卸载或替换之后的迟到成功也不能发布。
        if (controller.signal.aborted || this.modules.get(input.moduleId) !== module) {
          throw Error("模块已经卸载、替换或执行已取消，旧执行结果已丢弃");
        }
        // 其他进程/窗口可能直接改掉磁盘授权，当前宿主收不到 revoke 事件。
        // 即使没有 AbortSignal，也必须在发布结果前重新确认授权仍然有效。
        if (explicit && (!this.effectiveGrants(module) ||
          JSON.stringify(this.effectiveGrants(module)?.granted.slice().sort()) !== JSON.stringify(grant.granted.slice().sort()))) {
          throw Error("扩展授权已在执行期间撤销，拒绝发布旧授权结果");
        }
        if (workflowGrantKey !== undefined &&
          !this.authorizedWorkflowTargetNow(module.id, contribution.id, resource.projectPath)) {
          throw Error("工作流授权已在执行期间撤销，拒绝发布旧授权下的结果");
        }
        return {type:"result",value:structuredClone(value),view:structuredClone(moduleContributionView(contribution))};
      } finally {
        running.delete(controller);
        if (running.size === 0) this.activeInvocations.delete(module.id);
        if (workflowRunning && workflowGrantKey !== undefined) {
          workflowRunning.delete(controller);
          if (workflowRunning.size === 0) this.activeWorkflowInvocations.delete(workflowGrantKey);
        }
      }
    }
    const requestKey = input.moduleId + ":" + input.requestId;
    const fingerprint = createHash("sha256").update(JSON.stringify([module, input.contributionId, resource.projectPath, resource.path])).digest("hex");
    const priorId = this.requests.get(requestKey);
    if (priorId) {
      const prior = this.jobs.get(priorId);
      if (!prior || prior.fingerprint !== fingerprint) throw Error("请求 ID 被复用于不同的输入");
      return {type:"task",task:structuredClone(prior.snapshot)};
    }
    if ([...this.jobs.values()].filter(j => j.snapshot.status === "running").length >= 4) throw Error("同时运行的任务过多");
    while (this.jobs.size >= 64) {
      const evict = [...this.jobs.values()].find(j => j.snapshot.status !== "running");
      if (!evict) throw Error("任务数已达上限");
      this.jobs.delete(evict.snapshot.id); this.requests.delete(evict.requestKey);
    }
    const id = randomUUID(), controller = new AbortController();
    const job: LiveTask = {
      snapshot: {id,moduleId:module.id,contributionId:contribution.id,resource,view:structuredClone(moduleContributionView(contribution)),status:"running",progress:0,createdAt:Date.now(),updatedAt:Date.now()},
      controller, requestKey, fingerprint,
      ...(workflowGrantKey === undefined ? {} : { workflowGrantKey }),
      // 这句 `error` 经 `moduleCapabilityExecutor` 的 `failedOutcome(snapshot.error)`
      // 直接**画在失败节点卡片上**,与执行器里其它失败原因(「模块能力执行入参不合法」
      // 「模块能力任务已经不可用」「模块能力任务失败」)同一口径,一律中文。
      timer: setTimeout(() => { this.finish(job,"failed",undefined,"模块能力任务超时(30 秒)"); controller.abort(); }, 30_000),
    };
    job.timer.unref(); this.jobs.set(id,job); this.requests.set(requestKey,id);
    void Promise.resolve().then(() => definition.run(resource, {
      signal:controller.signal,
      progress:(value) => { if (job.snapshot.status === "running" && Number.isFinite(value)) {job.snapshot.progress=Math.max(job.snapshot.progress,Math.min(1,Math.max(0,value)));job.snapshot.updatedAt=Date.now();} },
    })).then(value => {
      if (job.snapshot.status !== "running") return;
      // 其它进程撤销工作流授权时，这个宿主没有即时取消事件；
      // 绝不能将工作流产生的迟到结果当成已授权完成写回。
      if (explicit && (!this.effectiveGrants(module) ||
        JSON.stringify(this.effectiveGrants(module)?.granted.slice().sort()) !== JSON.stringify(grant.granted.slice().sort()))) {
        this.finish(job, "cancelled", undefined, "扩展授权已撤销，结果已拒绝发布");
        job.controller.abort();
        return;
      }
      if (job.workflowGrantKey !== undefined &&
        !this.authorizedWorkflowTargetNow(module.id, contribution.id, resource.projectPath)) {
        this.finish(job,"cancelled",undefined,"工作流授权已撤销，结果已拒绝发布");
        job.controller.abort();
        return;
      }
      this.finish(job,"completed",definition.output.parse(value));
    }, error => this.finish(job,"failed",undefined,error instanceof Error?error.message:String(error)))
      .catch(error => this.finish(job,"failed",undefined,error instanceof Error?error.message:String(error)));
    return {type:"task",task:structuredClone(job.snapshot)};
  }
  task(raw: ModuleTaskRef): ModuleTask {
    const input = ModuleTaskRefSchema.parse(raw), job = this.jobs.get(input.taskId);
    if (!job || job.snapshot.moduleId !== input.moduleId) throw Error("找不到该模块的这个任务");
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
