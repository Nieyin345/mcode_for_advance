import { z } from "zod";
import type { ModuleCapabilityDescriptor, ModuleWorkflowGrantCandidate, ModuleWorkflowGrantStatus, ModuleWorkflowTarget } from "./moduleCapability.js";

/** v1 is a declarative, read-only extension surface, NOT a JavaScript sandbox.
 * Both bundled and imported manifests use this contract and the same host. */
const Id = z.string().min(3).max(100).regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/);
const LocalId = z.string().min(1).max(60).regex(/^[a-z][a-z0-9-]*$/);
export const LocalizedTextSchema = z.object({ zh: z.string().min(1).max(120), en: z.string().min(1).max(120) }).strict();
export const ResourceSchema = z.object({ projectPath: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }).strict();
export type ModuleResource = z.infer<typeof ResourceSchema>;
export const ResultSchema = z.record(z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= 32, "Too many result fields");
export type ModuleResult = z.infer<typeof ResultSchema>;
/** 【MC-035】扩展包里的**执行程序声明** —— 模块从「纯 JSON 清单」升级为「可带代码的扩展包」,
 *  但代码**绝不是**清单里的自由脚本:
 *
 *  - `source` 必须是一个**函数工厂**源码:按 `{ [能力短名]: async (resource) => ModuleResult }`
 *    求值。宿主只调用清单 `contributions[].capability` 指向的那一个短名 —— 清单不能点名
 *    宿主自己的 `core.*` 能力实现,能力身份由**宿主按模块 id + 短名分配**(见
 *    `moduleCapabilityId`)。这就是台账说的「禁止单靠 manifest 自带 source 获得执行权」:
 *    装上什么由用户点头,注册成什么 id 由宿主决定,调用哪一个是清单引用,三者分离。
 *  - `contributions[].capability` 为 `module.<短名>` 时,安装期必须同时声明 `program`;
 *    不带 `program` 的 `module.*` 引用在 `validate` 阶段就被拒(不会先装下再失败)。
 *  - 执行在**独立子进程**里,由 Node/Electron 的 `--permission` 权限模型限制文件系统
 *    (读/写按每次调用的具体资源放行)、禁止 `child_process` / `worker_threads`。
 *    网络**不受**该模型限制(如实注明,不冒充沙箱)。见 `modules/permissionedProcessRunner.ts`。
 *
 *  ⚠️ 这不是"签名验证"—— v1 的信任模型是**用户逐次同意**(UI 勾选 + Agent 走 danger 审批),
 *  不是密码学签名。台账要求的"签名/元数据不符必须拒绝"在 v1 由**形状与来源核验**承担
 *  (id 前缀、能力引用、程序形状、安装期试求值);真正的签名属于下一版扩展包格式。
 */
export const ModuleProgramSchema = z.object({
  /** 工厂源码:求值结果必须是对象,键为能力短名(小写字母开头),值为 async 函数。 */
  source: z.string().min(1).max(64 * 1024),
  /** 单次调用的墙钟上限(毫秒)。缺省 15 秒;硬上限 60 秒(套件按它钉住)。 */
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
}).strict();
export type ModuleProgram = z.infer<typeof ModuleProgramSchema>;

/** 【MC-035】宿主给扩展能力分配的 id 前缀 —— `module.<模块内短名>` 的**宿主侧产物**。
 * 清单只写短名;完整 id 由宿主拼装,故清单无法伪造另一模块的 `module.*` 能力。 */
export const MODULE_CAPABILITY_PREFIX = "module." as const;

/** 一个贡献引用的能力是**扩展程序能力**吗(`module.<短名>`)? */
export function isExtensionCapabilityId(capabilityId: string): boolean {
  return capabilityId.startsWith(MODULE_CAPABILITY_PREFIX) && capabilityId.length > MODULE_CAPABILITY_PREFIX.length;
}

/** 从清单引用(`module.<短名>`)取短名;不是扩展能力引用时返回 `undefined`。
 *
 * 【MC-035】短名**恰好一段**(`module.convert`),不允许 `module.demo.convert` —— 完整的
 * 宿主分配 id 是 `module.<模块 slug>.<短名>`,若清单一侧也能写多段,重装/重启时就会被
 * 二次分配(`module.demo.demo.convert`),两种形状混在同一个命名空间里。 */
export function extensionCapabilityShortName(capabilityId: string): string | undefined {
  if (!isExtensionCapabilityId(capabilityId)) return undefined;
  const short = capabilityId.slice(MODULE_CAPABILITY_PREFIX.length);
  return MODULE_CAPABILITY_SHORT_NAME.test(short) && !short.includes(".") ? short : undefined;
}

/** 短名形状:小写字母开头,小写字母/数字/连字符(单段)。 */
export const MODULE_CAPABILITY_SHORT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 【MC-035】**宿主分配**的能力 id —— 模块只能声明短名,完整身份由模块 id 派生:
 *  `user.acme.tools` + `convert` → `module.acme.tools.convert`。两个模块可以各有一个
 *  `convert`,互不覆盖;清单也无法指向别的模块的 `module.*`(它自己的分配集合里没有)。 */
export function extensionCapabilityAssignment(moduleId: string, shortName: string): string {
  const slug = moduleId.startsWith("user.") ? moduleId.slice("user.".length) : moduleId;
  return MODULE_CAPABILITY_PREFIX + slug + "." + shortName;
}

export const ModuleManifestSchema = z.object({
  apiVersion: z.literal(1),
  id: Id,
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
  title: LocalizedTextSchema,
  /** 【MC-060】模块声明它要的权限。`resource.read` 是默认档;**`resource.write`** 是
   *  「这个模块贡献的 action 能力要真改东西」的显式声明 —— 没有它,ModuleHost 拒绝把
   *  该模块的 action 能力接进来(v1 的安全默认:纯 JSON 清单**不直接**成为执行权限)。
   *  写上它只是「请求」;真正的执行仍要经宿主授权(见 ModuleHost 的 register/validate
   *  与 hostHookGrants 同款默认拒绝取向)。 */
  permissions: z.array(z.enum(["resource.read", "resource.write"])).min(1).max(2)
    .refine((p) => new Set(p).size === p.length, "Duplicate permission"),
  contributions: z.array(z.object({
    id: LocalId,
    slot: z.literal("files.context"),
    title: LocalizedTextSchema,
    extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/).max(20)).max(20).optional(),
    capability: Id,
    view: z.object({
      title: LocalizedTextSchema,
      fields: z.array(z.object({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(60), title: LocalizedTextSchema }).strict()).min(1).max(20),
    }).strict(),
  }).strict()).min(1).max(12),
  /** 【MC-035】可执行扩展包的程序声明(见 {@link ModuleProgramSchema})。**可选**:纯声明式
   *  模块(只引用宿主内置能力)继续原样工作,不因新增字段而被拒(old-manifest compatible)。 */
  program: ModuleProgramSchema.optional(),
}).strict().refine(v => new Set(v.contributions.map(c => c.id)).size === v.contributions.length, "Duplicate contribution ID")
  // 【MC-035】引用 `module.*` 能力的清单**必须**带 `program` —— 在形状层就拒,而不是装到
  // 一半才发现没有实现。反向不要求:`program` 里可以定义多个短名,清单只用其中一部分
  // (工厂一次求值,宿主只注册被引用的;未引用的短名不产生能力、也不可被其他模块调用)。
  .refine(
    v => v.program !== undefined || !v.contributions.some(c => isExtensionCapabilityId(c.capability)),
    "Module capabilities require a program declaration",
  )
  // 反过来:带了 `program` 的清单,至少要引用一个 `module.*` 能力 —— 否则装下一段永不执行、
  // 却占着 64 KiB 的代码,是"装了什么"和"能跑什么"对不上。
  .refine(
    v => v.program === undefined || v.contributions.some(c => isExtensionCapabilityId(c.capability)),
    "A program declaration requires at least one module capability contribution",
  )
  // 【MC-035】`module.` 前缀的引用必须恰好是**一段**短名。`module.demo.convert` 这种多段
  // 写法在宿主分配(`module.<slug>.<短名>`)之后会再被分配一次,形状混进同一个命名空间;
  // 在 schema 层拒,让 UI 的 `ModuleManifestSchema.parse` 与宿主给出同一句判据。
  .refine(
    v => v.contributions.every(c => !c.capability.startsWith(MODULE_CAPABILITY_PREFIX)
      || extensionCapabilityShortName(c.capability) !== undefined),
    "Module capability short names must be a single segment after module.",
  );
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;
export type ModuleContribution = ModuleManifest["contributions"][number];

/**
 * 【MC-060】模块能力权限的**单一判定** —— 一份权限声明要为「这个种类的能力」放行,还缺哪条。
 *
 *  - 任何能力都先要 `resource.read`(能力的**自身元数据**声明与模块的**清单**声明都是);
 *  - `action` 是唯一会**真改东西**的种类,必须由显式声明的 `resource.write` 背书 ——
 *    没有它,一份纯 JSON 清单就能靠挂一个 action 能力越过只读边界。
 *
 *  `ModuleHost.register`(能力自身元数据)与 `ModuleHost.validate`(模块清单)共用这**一份**
 *  判定:从前两边各写一遍 `kind === "action"` 的前缀判断,迟早漂移成「能力元数据说只读、
 *  清单却已放行」那种两个真相。返回缺的权限名;`undefined` = 这份声明足以接纳该能力。
 *  各调用点据返回值给**各自的**文案(注册失败与安装失败的话术本就不同),判定却只有一个。
 */
export function missingCapabilityPermission(
  kind: ModuleCapabilityDescriptor["kind"],
  permissions: readonly string[],
): "resource.read" | "resource.write" | undefined {
  if (!permissions.includes("resource.read")) return "resource.read";
  if (kind === "action" && !permissions.includes("resource.write")) return "resource.write";
  return undefined;
}

/** 【MC-060】**执行**一个能力前的放行判定 —— 与 `missingCapabilityPermission`(准入)分开的
 *  那一层。准入问的是「这份清单/元数据能不能**挂**这个能力」;本函数问的是「**这一次执行**
 *  放不放行」。两份判定各管一段,不合成一个真相。
 *
 *  - 非 `action` 能力:只需过 `authorize(resource)` 的资源作用域(`undefined` = 放行)。
 *  - `action` 能力:是唯一会**真改东西**的种类,故**必须有显式作用域背书 + 审批通道**——
 *    ① 模块清单持有 `resource.write`(越权则拒);
 *    ② 宿主注入了审批端口(`approvalChannelAvailable`)—— 没有审批通道的环境**一律拒**,
 *       与 `gateAppAction` 同款 fail-closed:不能因为"没界面问用户"就默认放行写动作。
 *
 *  返回拒绝原因(中文,直接给调用端);`undefined` = 这一层放行(实际执行仍需已通过的资源
 *  授权与逐次审批结果)。**判定只有这一份**:ModuleHost 在 `invoke` 的执行点上调用它,不在
 *  别处再写一遍 `kind === "action"`。
 */
export function actionInvocationDenied(
  kind: ModuleCapabilityDescriptor["kind"],
  permissions: readonly string[],
  approvalChannelAvailable: boolean,
): string | undefined {
  return actionInvocationRefusal(kind, permissions, approvalChannelAvailable)?.reason;
}

/**
 * 【MC-060】**一次能力调用的拒绝** —— 命令**根本没执行**(无副作用),与 `OperationResult`
 * 的 `REJECTED` 同义。调用端据 `code` 把「没执行」和「执行途中出错、可能已部分落定」
 * (→ UNCERTAIN,绝不默认可安全重试)分开;从前宿主只抛裸 `Error`,审批被拒会被上层按
 * 权限档一律报成 UNCERTAIN,把一次**安全可重来**的拒绝说成「先查真实状态、别重试」。
 *
 *  - `scope_denied`          模块清单没显式声明 `resource.write`(越权),无条件拒;
 *  - `approval_unavailable`  这个环境没有审批通道(fail-closed:没界面问就不放行写动作);
 *  - `approval_denied`       审批通道存在,但用户/批准方**拒绝**了这一次。
 */
export const MODULE_REFUSAL_CODES = ["scope_denied", "approval_unavailable", "approval_denied"] as const;
export type ModuleRefusalCode = (typeof MODULE_REFUSAL_CODES)[number];
export interface ModuleRefusal { code: ModuleRefusalCode; reason: string }

/** 【MC-060】用**结构标记**而不是 `instanceof`:调用方(如 `appControl` 的结果分类器)读这个
 *  标记时不必 import 宿主,也就不会把整个 host + zod schema 图拉进它自己的打包。 */
export const MODULE_REFUSAL_MARKER = "mcodeModuleRefusal" as const;

/** 构造一个带拒绝标记的 `Error` —— 原因原样进 `message`(卡片与日志都读它)。 */
export function moduleRefusalError(code: ModuleRefusalCode, reason: string): Error {
  const error = new Error(reason);
  (error as unknown as Record<string, unknown>)[MODULE_REFUSAL_MARKER] = { code, reason } satisfies ModuleRefusal;
  return error;
}

/** 【MC-060】读回一个 `Error` 上的拒绝标记(没有 / 形状不对 → `null`,绝不猜)。 */
export function moduleRefusal(error: unknown): ModuleRefusal | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[MODULE_REFUSAL_MARKER];
  if (!value || typeof value !== "object") return null;
  const { code, reason } = value as { code?: unknown; reason?: unknown };
  if (typeof code !== "string" || typeof reason !== "string") return null;
  if (!(MODULE_REFUSAL_CODES as readonly string[]).includes(code)) return null;
  return { code: code as ModuleRefusalCode, reason };
}

/** 【MC-060】执行点拒绝的**唯一判定**(带 code) —— `actionInvocationDenied` 只取它的 `reason`,
 *  保持既有调用端/断言不变;需要区分拒绝种类的调用端读 `code`。一份判定,两个投影。 */
export function actionInvocationRefusal(
  kind: ModuleCapabilityDescriptor["kind"],
  permissions: readonly string[],
  approvalChannelAvailable: boolean,
): ModuleRefusal | undefined {
  if (kind !== "action") return undefined;
  if (!permissions.includes("resource.write")) return { code: "scope_denied", reason: "action 能力执行需要模块声明 resource.write 权限" };
  if (!approvalChannelAvailable) return { code: "approval_unavailable", reason: "action 能力执行需要审批通道,当前环境没有可用的审批通道,为安全起见未执行。" };
  return undefined;
}
export const ModuleInvokeSchema = z.object({ moduleId: Id, contributionId: LocalId, resource: ResourceSchema, requestId: z.string().min(1).max(100) }).strict();
export type ModuleInvoke = z.infer<typeof ModuleInvokeSchema>;
export const ModuleTaskRefSchema = z.object({ moduleId: Id, taskId: z.string().min(1).max(100) }).strict();
export type ModuleTaskRef = z.infer<typeof ModuleTaskRefSchema>;
export const ModuleWorkspaceSchema = z.object({ projectPath: z.string().min(1).max(4096) }).strict();
export const ModuleRemoveSchema = z.object({ moduleId: Id }).strict();
export interface ModuleTask {
  id: string;
  moduleId: string;
  contributionId: string;
  resource: ModuleResource;
  view: ModuleContribution["view"];
  status: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  createdAt: number;
  updatedAt: number;
  result?: ModuleResult;
  error?: string;
}
export type ModuleReply = { type: "result"; value: ModuleResult; view: ModuleContribution["view"] } | { type: "task"; task: ModuleTask };
export interface ModuleCatalog {
  modules: ModuleManifest[];
  capabilities: ModuleCapabilityDescriptor[];
  /** Host-derived read-only targets. Missing means unavailable, not all modules.
   *  【MC-036】内置目标 + **有宿主核验工作流授权**的用户模块目标。 */
  workflowTargets?: ModuleWorkflowTarget[];
  /** 【MC-036】用户模块里可被授权的只读贡献（含它已有的授权工作区）—— UI 授权面板的
   *  候选来源。与 `workflowTargets` 同一份宿主判定，缺省 = 此版本没有该分面。 */
  workflowGrantCandidates?: ModuleWorkflowGrantCandidate[];
  /** 【MC-036】授权表健康度。`corrupt` = 整表不信任（所有用户模块工作流目标不可用），
   *  带原因供 UI 显式诊断。缺省 = 旧宿主，按"没有分面"处理。 */
  workflowGrantStatus?: ModuleWorkflowGrantStatus;
}

/** This example is used by the import editor, docs and tests; no executable code. */
export const EXAMPLE_MODULE: ModuleManifest = {
  apiVersion: 1, id: "user.file-report", version: "1.0.0",
  title: { zh: "我的文件报告", en: "My file report" }, permissions: ["resource.read"],
  contributions: [{ id: "inspect", slot: "files.context", title: { zh: "生成我的文件报告", en: "Create my file report" }, capability: "core.file.inspect",
    view: { title: { zh: "文件报告", en: "File report" }, fields: [
      { key: "bytes", title: { zh: "字节数", en: "Bytes" } },
      { key: "sha256", title: { zh: "SHA-256", en: "SHA-256" } },
    ] } }],
};
