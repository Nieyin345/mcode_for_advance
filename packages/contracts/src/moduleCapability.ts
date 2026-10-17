import { z } from "zod";
import { LocalizedTextSchema, ModuleInvokeSchema, ModuleManifestSchema } from "./modules.js";

/** Discovery only: this bounded subset is NOT a runtime JSON Schema engine.
 * Runtime input/output Zod checks and host authorization remain authoritative. */
export const MODULE_SCHEMA_MAX_BYTES = 32 * 1024;
export const MODULE_SCHEMA_MAX_DEPTH = 12;
export const MODULE_SCHEMA_MAX_NODES = 2048;
export const MODULE_SCHEMA_MAX_ENTRIES = 128;
export const MODULE_CAPABILITY_RUNNER_KIND = "module-capability" as const;
export const MODULE_CAPABILITY_NODE_TYPE_ID = "mcode.module-capability" as const;

export type ModuleJsonValue = null | boolean | number | string | ModuleJsonValue[] | { [key: string]: ModuleJsonValue };
export type JsonSchemaDocument = { [keyword: string]: ModuleJsonValue };
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const own = (object: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** Clone only plain JSON data. Inspect property descriptors instead of reading
 * accessors; don't stringify an object with user-defined toJSON behavior. */
function copySchemaData(input: unknown): ModuleJsonValue {
  let nodes = 0, chars = 0;
  const ancestors = new Set<object>();
  const charge = (length: number): void => {
    chars += length;
    if (chars > MODULE_SCHEMA_MAX_BYTES) throw new Error("JSON schema character budget exceeded");
  };
  const visit = (value: unknown, depth: number): ModuleJsonValue => {
    if (depth > MODULE_SCHEMA_MAX_DEPTH) throw new Error("JSON schema depth limit exceeded");
    if (++nodes > MODULE_SCHEMA_MAX_NODES) throw new Error("JSON schema node budget exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { charge(value.length); return value; }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new Error("JSON schema contains a non-JSON value");
    if (ancestors.has(value)) throw new Error("JSON schema contains a cycle");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("JSON schema requires plain objects and arrays");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) throw new Error("JSON schema contains symbol keys");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    try {
      if (array) {
        if (value.length > MODULE_SCHEMA_MAX_ENTRIES || keys.length !== value.length + 1) throw new Error("JSON schema array limit or sparse/extra entries");
        const result: ModuleJsonValue[] = [];
        for (let i = 0; i < value.length; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("JSON schema arrays require data entries");
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      if (keys.length > MODULE_SCHEMA_MAX_ENTRIES) throw new Error("JSON schema object entry limit exceeded");
      const result: JsonSchemaDocument = Object.create(null) as JsonSchemaDocument;
      for (const key of keys as string[]) {
        if (forbiddenKeys.has(key)) throw new Error("JSON schema contains an unsafe property name");
        charge(key.length);
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("JSON schema requires enumerable data properties");
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  const result = visit(input, 0);
  // Count encoded bytes, not UTF-16 code units; no Node-only Buffer in contracts.
  let bytes = 0;
  for (const char of JSON.stringify(result)) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MODULE_SCHEMA_MAX_BYTES) throw new Error("JSON schema UTF-8 byte limit exceeded");
  }
  return result;
}

const schemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const stringKeywords = new Set(["title", "description", "format", "pattern"]);
const numberKeywords = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const integerKeywords = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
const booleanKeywords = new Set(["uniqueItems", "readOnly", "writeOnly", "deprecated"]);
const mapKeywords = new Set(["properties", "patternProperties", "definitions", "$defs"]);
const childKeywords = new Set(["additionalProperties", "additionalItems", "propertyNames", "contains", "not", "if", "then", "else"]);
const listKeywords = new Set(["allOf", "anyOf", "oneOf"]);
const objectValue = (value: ModuleJsonValue): value is JsonSchemaDocument => value !== null && typeof value === "object" && !Array.isArray(value);

function validateSchemaDocument(input: unknown): JsonSchemaDocument {
  const document = copySchemaData(input);
  if (!objectValue(document)) throw new Error("JSON schema document must be an object");
  const schemaNodes = new Set<string>();
  const references: string[] = [];
  const fail = (keyword: string): never => { throw new Error("Unsupported JSON schema keyword or value: " + keyword); };
  const walk = (value: ModuleJsonValue, path: string[] = []): void => {
    if (typeof value === "boolean") { schemaNodes.add(JSON.stringify(path)); return; }
    if (!objectValue(value)) return fail("schema");
    schemaNodes.add(JSON.stringify(path));
    for (const [key, item] of Object.entries(value)) {
      if (key === "$schema") {
        if (item !== "http://json-schema.org/draft-07/schema#" && item !== "https://json-schema.org/draft-07/schema#") fail(key);
      } else if (key === "$ref") {
        // Only JSON Pointers into this exact document; no remote loading,
        // URI-escaped fragments, named anchors, $id or dynamic references.
        if (typeof item !== "string" || item.length > 512 || !/^#(?:\/(?:[^~%#]|~[01])*)*$/.test(item)) fail(key);
        references.push(item as string);
      } else if (key === "type") {
        const values = Array.isArray(item) ? item : [item];
        if (!values.length || values.some(type => typeof type !== "string" || !schemaTypes.has(type)) || new Set(values).size !== values.length) fail(key);
      } else if (stringKeywords.has(key)) {
        if (typeof item !== "string") fail(key);
      } else if (numberKeywords.has(key)) {
        if (typeof item !== "number") fail(key);
      } else if (integerKeywords.has(key)) {
        if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) fail(key);
      } else if (key === "multipleOf") {
        if (typeof item !== "number" || item <= 0) fail(key);
      } else if (booleanKeywords.has(key)) {
        if (typeof item !== "boolean") fail(key);
      } else if (key === "required") {
        if (!Array.isArray(item) || item.some(name => typeof name !== "string" || forbiddenKeys.has(name)) || new Set(item).size !== item.length) fail(key);
      } else if (mapKeywords.has(key)) {
        if (!objectValue(item)) fail(key);
        for (const [name, child] of Object.entries(item as JsonSchemaDocument)) walk(child, [...path, key, name]);
      } else if (childKeywords.has(key)) {
        walk(item, [...path, key]);
      } else if (key === "items") {
        if (Array.isArray(item)) item.forEach((child, index) => walk(child, [...path, key, String(index)])); else walk(item, [...path, key]);
      } else if (listKeywords.has(key)) {
        if (!Array.isArray(item) || item.length === 0) fail(key);
        (item as ModuleJsonValue[]).forEach((child, index) => walk(child, [...path, key, String(index)]));
      } else if (key === "enum" || key === "examples") {
        if (!Array.isArray(item) || (key === "enum" && item.length === 0)) fail(key);
      } else if (key !== "default" && key !== "const") {
        fail(key);
      }
    }
  };
  walk(document);
  for (const reference of references) {
    let value: ModuleJsonValue = document;
    const tokens = (reference === "#" ? [] : reference.slice(2).split("/")).map(token => token.replace(/~1/g, "/").replace(/~0/g, "~"));
    for (const key of tokens) {
      if (value === null || typeof value !== "object" || !own(value, key)) throw new Error("Unresolved local JSON schema reference");
      value = (value as JsonSchemaDocument)[key]!;
    }
    if (!schemaNodes.has(JSON.stringify(tokens))) throw new Error("JSON schema reference must address a schema node");
  }
  return document;
}

export const JsonSchemaDocumentSchema = z.unknown().transform<JsonSchemaDocument>((input, context) => {
  try { return validateSchemaDocument(input); }
  catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Invalid JSON schema document" });
    return z.NEVER;
  }
});

const Id = ModuleInvokeSchema.shape.moduleId;
const ContributionId = ModuleInvokeSchema.shape.contributionId;
const DescriptionSchema = z.object({ zh: z.string().min(1).max(2000), en: z.string().min(1).max(2000) }).strict();
export const ModuleCapabilityMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
  title: LocalizedTextSchema,
  description: DescriptionSchema,
  permissions: z.array(z.enum(["resource.read", "resource.write"])).min(1).max(2)
    .refine((p) => new Set(p).size === p.length, "Duplicate permission"),
  inputSchema: JsonSchemaDocumentSchema,
  outputSchema: JsonSchemaDocumentSchema,
  supportsCancellation: z.boolean(),
  limits: z.object({
    maxFileBytes: z.number().int().nonnegative().safe().optional(),
    taskTimeoutMs: z.number().int().positive().safe().optional(),
  }).strict().optional(),
}).strict();
export type ModuleCapabilityMetadata = z.infer<typeof ModuleCapabilityMetadataSchema>;

export const ModuleCapabilityDescriptorSchema = z.object({
  id: Id,
  kind: z.enum(["query", "action", "task"]),
  // No defaults: missing metadata means unknown, not a permission grant.
  metadata: ModuleCapabilityMetadataSchema.optional(),
}).strict();
export type ModuleCapabilityDescriptor = z.infer<typeof ModuleCapabilityDescriptorSchema>;

export const ModuleWorkflowTargetSchema = z.object({ moduleId: Id, contributionId: ContributionId, capabilityId: Id }).strict();
export type ModuleWorkflowTarget = z.infer<typeof ModuleWorkflowTargetSchema>;

/**
 * 【MC-036】用户模块的**工作流运行授权** —— 一条记录 = 用户本人对「这个用户模块的
 * 这个只读贡献、在这个工作区里」的显式放行。**默认没有记录 = 不可自动运行**。
 *
 * 记录绑定四样东西，任何一样变了旧授权都不再覆盖：
 *   - `moduleId` + `moduleVersion` —— 换版本必须重新授权（不能借旧授权跑新代码的清单）；
 *   - `contributionId` + `capabilityId` —— 贡献指向的能力被换成另一个（哪怕名字还在），
 *     授权作废；
 *   - `projectPath` —— 资源范围是**一个已登记工作区根**。授权只覆盖工作流在同一个
 *     工作区里的运行；换项目要再授一次。
 *
 * 只覆盖 `user.*`：内置模块由宿主自己的 `addBuiltin` 登记表判定，不需要也不接受
 * 这条记录（伪造一个 `core.*` 记录不会产生任何效果）。
 */
export const ModuleWorkflowGrantSchema = z.object({
  moduleId: Id.refine(value => value.startsWith("user."), "Workflow grants cover user modules only"),
  moduleVersion: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
  contributionId: ContributionId,
  capabilityId: Id,
  projectPath: z.string().min(1).max(4096),
  grantedAt: z.number().int().nonnegative(),
}).strict();
export type ModuleWorkflowGrant = z.infer<typeof ModuleWorkflowGrantSchema>;

/**
 * 【MC-036】授权表的**落点**：`<数据根>/ui-modules/workflow-grants.json`，独立文件，
 * 不参与「导入/导出设置」。
 *
 * 为什么不是设置行（台账允许「设置行，随本仓既有惯例选」，本仓的惯例恰恰相反）：
 * `settings/settingsTransfer.ts` 把 `SettingRepo` 整表拿去做导入导出，而两条既有的
 * 安全授信（`grantStoreFile.ts` 的计划授权、`hostHookGrantFile.ts` 的插件 hook 授权）
 * 都因为同一条理由**故意**落在独立文件里 —— 授权是**本机本用户**点头的事实，一份别人的
 * 设置备份不能把授权搬进来。更要紧的是写通道：通用 `setting.set` 是 Agent 经
 * `app_api_call` 可达的 write 档，把自动运行权放进设置行等于给 Agent 留了「自己给自己
 * 授权」的口子。独立文件只经宿主 `issueWorkflowGrant` / `revokeWorkflowGrant` 写（IPC
 * 侧在 `appControl/policy.ts` 钉 blocked，与 `hooks.issueHostHookGrant` 同一条纪律），
 * 落盘复用模块清单同一套 tmp+rename 原子写。
 *
 * 值的形状是**文件信封** `{"version":1,"grants":[…]}`（与 `hooks.json` 同款）：将来
 * 结构变化时靠 `version` 认出旧文件，而不是把旧数据硬读成新结构。
 */
export const MODULE_WORKFLOW_GRANT_FILE_VERSION = 1;

/**
 * 【MC-036】授权存档的三态判定 —— 与 MC-051/MC-053 同一条协议：**坏存档不当空表**。
 *
 *  - `absent`  从来没授过权（或用户清空）—— 默认关闭，不是错误；
 *  - `valid`   整表与每一条都通过 schema；
 *  - `corrupt` 读得到但读不懂 —— 调用方必须**整表不信任**（不是跳过坏条目），
 *    也不得拿"空表"当基准回写（那会把用户手写的原字节覆盖掉），并显式报告原因。
 *
 * 为什么逐条坏也算整表 `corrupt`（而不是像 hostHookGrant 那样隔离单条）：读方向
 * 两者都是收紧（丢一条 = 少一份授权），但**写方向**不同 —— 逐条隔离后拿"过滤过的
 * 空表"回写会静默毁掉原值；整表拒读拒写，把修复交给用户（删掉/改好那一行），
 * 与 `hooks/store.ts` 的 `classifyHooksFile` 对 corrupt 的分岔一致。
 *
 * 纯函数、无 Node/Electron 依赖：宿主（判定）、渲染端（授权面板的写保护）与无头
 * 套件共用这**一份**判据。
 */
export type ModuleWorkflowGrantArchive =
  | { state: "absent" }
  | { state: "valid"; grants: ModuleWorkflowGrant[] }
  | { state: "corrupt"; reason: string };

export function classifyModuleWorkflowGrants(raw: string | null): ModuleWorkflowGrantArchive {
  if (raw === null || raw.trim() === "") return { state: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "corrupt", reason: "授权表不是合法 JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "corrupt", reason: "授权表不是对象" };
  }
  const envelope = parsed as { version?: unknown; grants?: unknown };
  if (envelope.version !== MODULE_WORKFLOW_GRANT_FILE_VERSION) return { state: "corrupt", reason: "授权表版本不符" };
  if (!Array.isArray(envelope.grants)) return { state: "corrupt", reason: "授权表的 grants 不是数组" };
  const grants: ModuleWorkflowGrant[] = [];
  for (let index = 0; index < envelope.grants.length; index++) {
    const result = ModuleWorkflowGrantSchema.safeParse(envelope.grants[index]);
    if (!result.success) return { state: "corrupt", reason: `第 ${index + 1} 条授权记录形状不合法` };
    grants.push(result.data);
  }
  return { state: "valid", grants };
}

/** 序列化 —— 只有 `valid` / `absent` 的内容可以来这里；调用方负责先过分类器。 */
export function serializeModuleWorkflowGrants(grants: readonly ModuleWorkflowGrant[]): string {
  return JSON.stringify({ version: MODULE_WORKFLOW_GRANT_FILE_VERSION, grants }, null, 2) + "\n";
}

/** 一条授权的**幂等键** —— 同一 (模块, 版本, 贡献, 能力, 工作区) 只应存在一份记录：
 * 重复授权是幂等的（刷新 `grantedAt`），不会在表里攒出一串覆盖同一目标的重复行。 */
export function moduleWorkflowGrantKey(
  grant: Pick<ModuleWorkflowGrant, "moduleId" | "moduleVersion" | "contributionId" | "capabilityId" | "projectPath">,
): string {
  return JSON.stringify([grant.moduleId, grant.moduleVersion, grant.contributionId, grant.capabilityId, grant.projectPath]);
}

/** 一次授权变更的输入（不含 `grantedAt`，由签发时刻补）。 */
export type ModuleWorkflowGrantRequest = Omit<ModuleWorkflowGrant, "grantedAt">;

/**
 * 【MC-036】**授权表的唯一写入口**（纯函数，桌面 UI 与无头套件共用这一份）：
 * 在既有原文上签发 / 撤销一条授权，返回**要写回的新原文**。
 *
 *  - `absent`：从空表开始（首次授权）；
 *  - `valid`：合并 —— 签发按 {@link moduleWorkflowGrantKey} 幂等（刷新 `grantedAt`），
 *    撤销按同一键删除（找不到也返回成功，目标状态已达成）；
 *  - `corrupt`：**拒绝写入**并给出可诊断的原因（原值保持不变）。与 MC-051 的
 *    「坏文件拒绝保存」同一条纪律：绝不能拿空表把用户手写的原值静默覆盖掉。
 *
 * 调用方负责在写回前确认模块/贡献/能力确实来自宿主目录（UI 的候选项就是目录给的），
 * 宿主在**消费点**再按现场清单核验一遍 —— 表里出现一条无效记录也不会产生任何效果。
 */
export function applyModuleWorkflowGrantChange(
  raw: string | null,
  change: { kind: "issue"; grant: ModuleWorkflowGrantRequest; grantedAt: number } | { kind: "revoke"; grant: ModuleWorkflowGrantRequest },
): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  const archive = classifyModuleWorkflowGrants(raw);
  if (archive.state === "corrupt") {
    return {
      ok: false,
      error: `工作流授权表损坏（${archive.reason}），已拒绝写入以免覆盖原存档；修复请删除或改正文件「ui-modules/workflow-grants.json」后重启。`,
    };
  }
  const current = archive.state === "valid" ? archive.grants : [];
  const keyOf = (grant: ModuleWorkflowGrantRequest): string => moduleWorkflowGrantKey(grant);
  if (change.kind === "issue") {
    const key = keyOf(change.grant);
    const next = current.filter(existing => keyOf(existing) !== key);
    next.push({ ...change.grant, grantedAt: change.grantedAt });
    return { ok: true, text: serializeModuleWorkflowGrants(next), changed: true };
  }
  const key = keyOf(change.grant);
  const next = current.filter(existing => keyOf(existing) !== key);
  if (next.length === current.length) return { ok: true, text: serializeModuleWorkflowGrants(current), changed: false };
  return { ok: true, text: serializeModuleWorkflowGrants(next), changed: true };
}

/**
 * 【MC-036】catalog 里给授权面板看的**候选人**：一个用户模块的只读贡献，连同它
 * 当前已获得的全部授权（按工作区）。`grants` 为空 = 菜单可用、工作流不可用。
 *
 * 候选人是**宿主核验过的形状**（模块存在、贡献指向已注册的 query/task 能力），
 * 但它**不是授权**：UI 据此画「授权」按钮，签发仍走设置行的真人点击。
 */
export const ModuleWorkflowGrantCandidateSchema = z.object({
  moduleId: Id,
  moduleVersion: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
  contributionId: ContributionId,
  capabilityId: Id,
  grants: z.array(z.object({
    projectPath: z.string().min(1).max(4096),
    grantedAt: z.number().int().nonnegative(),
  }).strict()).max(64),
}).strict();
export type ModuleWorkflowGrantCandidate = z.infer<typeof ModuleWorkflowGrantCandidateSchema>;

/** 【MC-036】catalog 顶层的授权存档健康度（UI 据此显示"整表已拒绝"的显式诊断）。 */
export const ModuleWorkflowGrantStatusSchema = z.object({
  archive: z.enum(["absent", "valid", "corrupt"]),
  reason: z.string().max(500).optional(),
}).strict();
export type ModuleWorkflowGrantStatus = z.infer<typeof ModuleWorkflowGrantStatusSchema>;

/** Catalog validation checks referential consistency, NOT origin/authentication.
 * Only the host can know whether a core-prefixed module was really registered
 * as builtin, and only the host can verify a user module's workflow grant.
 * This schema must never be used instead of those host checks — `user.*`
 * targets are shape-legal here precisely because the host (ModuleHost) is the
 * one that decides whether to publish them. */
export const ModuleCatalogSchema = z.object({
  modules: z.array(ModuleManifestSchema).max(32),
  capabilities: z.array(ModuleCapabilityDescriptorSchema).max(128),
  workflowTargets: z.array(ModuleWorkflowTargetSchema).max(384).optional(),
  workflowGrantCandidates: z.array(ModuleWorkflowGrantCandidateSchema).max(384).optional(),
  workflowGrantStatus: ModuleWorkflowGrantStatusSchema.optional(),
}).strict().superRefine((catalog, context) => {
  const issue = (message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(catalog.modules.map(module => module.id)).size !== catalog.modules.length) issue("Duplicate module ID");
  if (new Set(catalog.capabilities.map(capability => capability.id)).size !== catalog.capabilities.length) issue("Duplicate capability ID");
  const seen = new Set<string>();
  for (const target of catalog.workflowTargets ?? []) {
    const key = JSON.stringify([target.moduleId, target.contributionId]);
    if (seen.has(key)) issue("Duplicate workflow target");
    seen.add(key);
    const module = catalog.modules.find(item => item.id === target.moduleId);
    const contribution = module?.contributions.find(item => item.id === target.contributionId);
    const capability = catalog.capabilities.find(item => item.id === target.capabilityId);
    // 【MC-036】`user.*` 目标在这里是**合法形状**：宿主只为「有有效工作流授权」的用户
    // 模块发布目标，是否为真的授权由 ModuleHost 判定（本 schema 只查引用一致性，
    // 见上方注释）。内置目标仍必须是 `core.*` —— 伪造的 `core.` 前缀在宿主那侧过不了
    // `addBuiltin` 登记表，这里再保一道形状约束。读写类别对谁都不许是 action。
    const knownPrefix = module !== undefined && (module.id.startsWith("core.") || module.id.startsWith("user."));
    if (!knownPrefix || contribution?.capability !== target.capabilityId || !capability || capability.kind === "action") {
      issue("Workflow target must reference a listed read-only contribution (core builtin or host-granted user module)");
    }
  }
});

/** Stored/resolved workflow parameters. Passing this validation is NOT
 * authorization; user.* is syntactically valid but workflow execution is
 * still denied by the host. Expressions in path are data for the host resolver. */
export const ModuleWorkflowCallSchema = z.object({
  moduleId: Id,
  contributionId: ContributionId,
  path: z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !value.includes("\0"), "Invalid workflow file path"),
}).strict();
export type ModuleWorkflowCall = z.infer<typeof ModuleWorkflowCallSchema>;

/** HOST-created input only. requestId identifies one dispatch attempt; never
 * accept it from WorkflowNode.params or regenerate it during task polling. */
export const ModuleWorkflowExecutionInputSchema = ModuleWorkflowCallSchema.extend({
  requestId: ModuleInvokeSchema.shape.requestId.refine(value => value.trim().length > 0 && !value.includes("\0"), "Invalid workflow request identity"),
}).strict();
export type ModuleWorkflowExecutionInput = z.infer<typeof ModuleWorkflowExecutionInputSchema>;
export const ModuleCapabilityRunnerSchema = z.object({ kind: z.literal(MODULE_CAPABILITY_RUNNER_KIND) }).strict();
