/**
 * **SceneCommands —— 把 ScenePlan 翻成对现有服务的命令**(ARC-002 / MC-058 的第四片)。
 *
 * ## 它在链上的位置
 *
 * ```text
 * SceneSpec(声明) → compileScenePlan() → ScenePlan(有序变更列表)
 *                                          → compileSceneCommands() → SceneCommands(命令描述符)
 *                                          → 执行端(后续切片)按 kind 派发到**唯一一个既有服务**
 * ```
 *
 * `ScenePlan` 说「按什么顺序建什么」,但它的一步里**只有** `actionId`/`kind`/`order`/`dependsOn`
 * —— **没有资源的声明正文**(那是 spec 的事)。执行端要真去建一个工作流,需要那份 `spec` 载荷
 * 交给 `workflow.save`;要装一个插件,需要交给 `plugins.install*`。本文件补的就是这一层:
 * 逐条命令**声明**「交给哪个既有服务入口、带什么载荷」。
 *
 * ## 三条硬边界(写在文件头,免得被当成疏漏)
 *
 *  1. **纯函数、不执行任何东西**。这里**不**调 `workflow.save`、**不**碰磁盘、**不**申请授权。
 *     它产出的是**可序列化的命令描述符**,执行端(未来的切片)拿它去派发。契约层被渲染端直接
 *     打包(见 `sceneSpec.ts` 文件头),所以这里**绝不** import 任何主进程服务 / `node:crypto` /
 *     `fs`。
 *  2. **不另造 runtime**。每种资源 kind 都映射到**一个已存在的**服务入口(见
 *     {@link SCENE_KIND_SERVICE_MAP});不在本契约里长第二套执行引擎。
 *  3. **映射是「声明」,不是「调用」**。`service` 字段里的 `serviceLabel` 只是一个**字符串标签**
 *     (如 `workflow.save`)—— 让执行端 / 审计 / UI 能读到「这一步归哪个服务管」,它不是函数引用。
 *     凡是**无法稳妥给出唯一入口点**的 kind(入口取决于资源自身声明、或入口吃的是整份配置而非
 *     逐条),`needsResolution` 显式置真并给出 `resolutionHint`,**绝不猜一个**。
 *
 * ## 判据窄且诚实
 *
 *  - **顺序来自计划**,不从 spec 重排一遍(硬规矩 2:排序逻辑只有 `compileScenePlan` 一份)。
 *  - **载荷逐字**(`payload` 就是 spec 里那条资源的 `spec`,不增删字段)。
 *  - **稳定**:同一 plan + 同一 spec 重复编译 → 逐字节相同的 `commandId` 与 `digest`(重复部署
 *    幂等 / 部署把步骤绑回命令都靠它)。
 *  - **不静默丢**:计划里每一步都产出一条命令(哪怕 `needsResolution`);kind 不在枚举里(调用方
 *    绕开了校验)也一样产出一条带 `needsResolution` 的命令并计入 `unresolved`,**不**把它扔掉。
 */
import type { SceneSpec, SceneResourceKind } from "./sceneSpec.js";
import { sceneSpecDigest, type ScenePlan } from "./scenePlan.js";
import type { ZodTypeAny } from "zod";
// 各 kind 的**真实** RPC 入参 schema —— 适配器用它校验投影后的入参(硬规矩 2:只有一份形状,
// 绝不在这里另抄一份字段清单)。逐个按域 import,不走 `@contracts/ipc` 大 barrel(免得把整面
// IPC契约拉进渲染端 bundle)。
import { WorkflowSaveSchema, HooksSaveSchema } from "./ipc/workflow.js";
import { SkillsSaveSchema } from "./ipc/skills.js";
import { McpSaveSchema } from "./ipc/mcp.js";
import { ModuleInstallSchema } from "./ipc/modules.js";

/**
 * 一种资源 kind 到**既有服务入口点**的声明。
 *
 * `serviceLabel` 是给人/审计读的**标签**（如 `workflow.save`），不是可调用的东西。
 * `needsResolution` 为真时，部署器必须先按 `resolutionHint` 进一步决议才能选定真正入口——
 * 这是「不知道就别猜」的落点，不是错误。
 */
export interface SceneKindServiceEntry {
  /** 该 kind 对应的资源种类（回指，便于消费方不依赖 map 的键）。 */
  kind: SceneResourceKind;
  /**
   * 既有服务入口点标签（如 `workflow.save`）。`null` = 无法稳妥给出唯一入口点
   * （此时 `needsResolution` 必为真）。
   */
  serviceLabel: string | null;
  /**
   * **独立回读**入口描述（如 `workflow.get` / `skills.list`）—— 部署器/验收据此**独立查询宿主
   * 真实资源**是否可见，而不是只信部署记录里「这一步跑到了 done」。`null` = 本 kind 没有单条
   * 确定回读入口（如 `panel` 落在整块 UI 配置里、`scaffold` 交整份模板）。
   */
  readback: SceneKindReadback | null;
  /** **补偿（逆操作）**描述 —— 某步失败后撤销本 kind 已建成资源用。见 {@link SceneKindCompensation}。 */
  compensation: SceneKindCompensation;
  /**
   * 一条资源在**服务侧**的稳定身份,在资源声明正文(`spec`)里的**点分路径**(如 `id` /
   * `name` / `manifest.id`)。回读与补偿都用**这个值**去查 / 撤真实的服务资源 —— 见
   * {@link sceneResourceIdentity} 的说明:`null` = 该 kind 的声明里没有可从声明推出的稳定身份
   * (如 `plugin` 的插件名来自它自己的 manifest,声明时未知),调用端据此**如实记为未验证 /
   * 无稳妥逆操作**,绝不拿一个永远匹配不上的值假装回读过了。
   */
  identityPath: string | null;
  /** 需要部署器按资源声明 / 上下文进一步决议才能选定入口点。 */
  needsResolution: boolean;
  /** 决议所需依据（如 `spec.source` / `spec.entry`）；不需要决议时为 `null`。 */
  resolutionHint: string | null;
  /** 人读说明：为什么这么映射，或为什么需要决议。 */
  note: string;
}

/**
 * 一种 kind 的**独立回读**描述（MC-058 的真实资源回读）。部署器据此对宿主**重新查询**每条资源
 * 是否真的存在 —— 判据只有「查得到的算 present」，绝不从部署记录里推。
 */
export interface SceneKindReadback {
  /** 回读入口标签（如 `workflow.get`）。 */
  label: string;
  /** `byArg`：按资源 id 调 `{ [arg]: id }`；`byList`：列出全部再按 `matchField` 匹配。 */
  mode: "byArg" | "byList";
  /** `byArg` 的入参字段名（如 `id`）；`byList` 时为 `null`。 */
  arg: string | null;
  /** `byArg`：结果里承载该资源的字段（如 `workflow`）；`byList`：承载数组的字段（如 `skills`）。 */
  field: string;
  /** 判定资源存在时匹配的字段（如 `id` / `name`）。 */
  matchField: string;
}

/**
 * 一种 kind 的**补偿（逆操作）**描述（MC-058 的失败补偿）。某步失败后，部署器对之前已建成、
 * 且声明 `compensable` 的步**调这个逆操作入口**撤销其资源。`label`/`arg` 为 `null` = 本 kind
 * **无稳妥逆操作**（无删除入口，或删除入口还需资源 id 之外的参数）—— 此时补偿**如实记为未执行**，
 * 绝不猜一个入口去删（可能删错东西）。
 */
export interface SceneKindCompensation {
  /** 逆操作入口标签（如 `workflow.remove`）；`null` = 无稳妥逆操作。 */
  label: string | null;
  /** 逆操作入参里承载**资源身份**的字段名（如 `id` / `name` / `moduleId`）；`label` 非 null 时必有。 */
  arg: string | null;
  /** 人读说明：撤什么，或为什么撤不了。 */
  note: string;
}

/**
 * **kind → 既有服务入口点**的声明表——这一层唯一一份映射。
 *
 * 逐条来源（都核对过仓里的真实 RPC 渠道，不是猜的）：
 *
 *  - `workflow`   → `workflow.save`（`WorkflowSaveInput`）。
 *  - `automation` → `workflow.save`：**自动化就是带 `trigger` 的工作流**（见 `@contracts/workflow`
 *                   的文件头：`trigger` 字段「有它就是一条自动化」）——仓里**没有**独立的
 *                   `automation.save` 渠道，所以它和 workflow 走同一个既有入口，不另造一个。
 *  - `skill`      → `skills.save`（`SkillsSaveInput`）。
 *  - `plugin`     → **需决议**：安装入口取决于插件来源（`plugins.installLocal` /
 *                   `plugins.installGit` / `plugins.installMarketplace`），仓里没有单一的
 *                   `plugins.install`。
 *  - `mcp`        → `mcp.save`（`McpSaveInput`）。
 *  - `hook`       → `hooks.save`（`HooksSaveInput`）。
 *  - `module`     → `modules.install`（`ModuleInstallInput`）。
 *  - `panel`      → `setting.set`：面板落在自定义 UI 配置（`customUi.config.v1` 这一个整块
 *                   setting）里——**需决议**：单条面板要并进整份配置，不是逐面板一个入口。
 *  - `scaffold`   → `projectInit.apply`：**需决议**：`projectInit.apply` 吃的是**整份模板**
 *                   （且要先 preview 取 digest），单条脚手架资源（目录/文件/记忆/说明文件）
 *                   要先按 `spec.entry` 归到模板条目里再一起提交。
 */
export const SCENE_KIND_SERVICE_MAP: Record<SceneResourceKind, SceneKindServiceEntry> = {
  workflow: {
    kind: "workflow",
    serviceLabel: "workflow.save",
    readback: { label: "workflow.get", mode: "byArg", arg: "id", field: "workflow", matchField: "id" },
    compensation: { label: "workflow.remove", arg: "id", note: "workflow.remove 按 id 删掉刚建成的工作流。" },
    // 声明正文就是 WorkflowDoc；服务侧身份是 `WorkflowDoc.id`（`workflow.get` 收 `{id}`、`workflow.remove` 收 `{id}`）。
    identityPath: "id",
    needsResolution: false,
    resolutionHint: null,
    note: "工作流图交既有 workflow.save 建立（WorkflowSaveInput）。",
  },
  automation: {
    kind: "automation",
    serviceLabel: "workflow.save",
    readback: { label: "workflow.get", mode: "byArg", arg: "id", field: "workflow", matchField: "id" },
    compensation: { label: "workflow.remove", arg: "id", note: "自动化就是工作流，workflow.remove 按 id 删除。" },
    // 自动化就是带 trigger 的工作流，服务侧身份同为 `WorkflowDoc.id`。
    identityPath: "id",
    needsResolution: false,
    resolutionHint: null,
    note: "自动化就是带 trigger 的工作流（见 @contracts/workflow 文件头），无独立 automation.save，走同一个 workflow.save。",
  },
  skill: {
    kind: "skill",
    serviceLabel: "skills.save",
    readback: { label: "skills.list", mode: "byList", arg: null, field: "skills", matchField: "name" },
    compensation: { label: null, arg: null, note: "skills.delete 还要 source（global/project）才能定位删哪条目录，单靠资源 id 不足以稳妥撤销——本层不猜，如实记为未补偿。" },
    // `skills.list` 返回 `{skills:[SkillInfo]}`，SkillInfo 的稳定身份是 `name`（SkillsSaveInput.name 落成目录名）。
    identityPath: "name",
    needsResolution: false,
    resolutionHint: null,
    note: "技能声明交既有 skills.save 落成 SKILL.md（SkillsSaveInput）。",
  },
  plugin: {
    kind: "plugin",
    serviceLabel: null,
    readback: { label: "plugins.list", mode: "byList", arg: null, field: "plugins", matchField: "name" },
    compensation: { label: "plugins.remove", arg: "name", note: "plugins.remove 按插件名卸载——但插件名来自插件自己的 manifest（`PluginState.name`），安装前声明里没有它（见 identityPath 说明），故本 kind 的补偿无从取到入参，保持未执行。" },
    // ★ 无稳定身份：`plugins.list` 返回的 `PluginState.name` 是插件**自己的 manifest** 名，
    //   与声明正文（`spec.source` / `spec.source==="marketplace"` 时的 `spec.name` 是市场**条目名**、
    //   不等于 manifest 名）不是一回事 —— 声明里没有可从声明推出的插件名。
    //   绝不拿市场的条目名/来源当插件名去回读（那会永远匹配不上，是「假装回读过了」）。
    identityPath: null,
    needsResolution: true,
    resolutionHint: "spec.source(本地 / git / 市场)",
    note: "插件安装入口取决于来源：plugins.installLocal / plugins.installGit / plugins.installMarketplace——仓里无单一 plugins.install，交部署器按 spec.source 决议。安装后的插件名由插件 manifest 给出，声明时未知。",
  },
  mcp: {
    kind: "mcp",
    serviceLabel: "mcp.save",
    readback: { label: "mcp.list", mode: "byList", arg: null, field: "servers", matchField: "name" },
    compensation: { label: "mcp.remove", arg: "name", note: "mcp.remove 按服务器名删掉刚写入的 MCP 声明。" },
    // `mcp.list` 返回 `{servers:[McpServerEntry]}`，稳定身份是 `name`（McpSaveInput.name；同名 server 会被 mcp.save 拒）。
    identityPath: "name",
    needsResolution: false,
    resolutionHint: null,
    note: "MCP 声明交既有 mcp.save（McpSaveInput）。",
  },
  hook: {
    kind: "hook",
    serviceLabel: "hooks.save",
    readback: { label: "hooks.list", mode: "byList", arg: null, field: "hooks", matchField: "id" },
    compensation: { label: "hooks.remove", arg: "id", note: "hooks.remove 按钩子 id 删掉刚装上的钩子。" },
    // `hooks.list` 返回 `{hooks:[HookSpec]}`，稳定身份是 HookSpec.id（HooksSaveInput.hook.id）。
    identityPath: "id",
    needsResolution: false,
    resolutionHint: null,
    note: "钩子声明交既有 hooks.save（HooksSaveInput），与 HookRunner 同一份定义。",
  },
  module: {
    kind: "module",
    serviceLabel: "modules.install",
    readback: { label: "modules.catalog", mode: "byList", arg: null, field: "modules", matchField: "id" },
    compensation: { label: "modules.remove", arg: "moduleId", note: "modules.remove 按模块 id 卸载刚装上的模块。" },
    // `modules.catalog` 返回 `{modules:[ModuleManifest]}`，稳定身份是 `ModuleManifest.id`（声明正文里的 `spec.manifest.id`）。
    identityPath: "manifest.id",
    needsResolution: false,
    resolutionHint: null,
    note: "模块声明交既有 modules.install（ModuleInstallInput）。",
  },
  panel: {
    kind: "panel",
    serviceLabel: "setting.set",
    readback: null,
    compensation: { label: null, arg: null, note: "面板落在整块 customUi.config.v1 里，无单条删除入口（删一条要重写整块配置）；本层不猜，如实记为未补偿。" },
    // 面板落在整块 customUi.config.v1 里，无单条可回读的稳定身份。
    identityPath: null,
    needsResolution: true,
    resolutionHint: "customUi.config.v1",
    note: "面板落在自定义 UI 配置这一个整块 setting（CUSTOM_UI_SETTING_KEY）里——需决议：单条面板要并进整份配置，不是逐面板一个入口。",
  },
  scaffold: {
    kind: "scaffold",
    serviceLabel: "projectInit.apply",
    readback: null,
    compensation: { label: null, arg: null, note: "脚手架条目由整份模板 projectInit.apply 落盘，无单条撤销入口；本层不猜，如实记为未补偿。" },
    // 脚手架条目由整份模板落盘，无逐条可回读的稳定身份。
    identityPath: null,
    needsResolution: true,
    resolutionHint: "spec.entry(目录 / 文件 / 记忆 / 说明文件)",
    note: "脚手架交既有 projectInit.apply，但该入口吃整份模板且需先 preview 取 digest——需决议：单条条目要先按 spec.entry 归到模板里再一起提交。",
  },
};

/**
 * 一条**命令描述符**——对应计划里的一步；执行端拿它派发到对应服务。
 *
 * 它把「要建哪种资源、带什么载荷、交给哪个服务、依赖谁」压成一条**可序列化**的记录。
 * 执行端(未来的切片)按 `service.serviceLabel`(或先按 `resolutionHint` 决议)派发；本契约不执行。
 */
export interface SceneStepCommand {
  /** 稳定命令 id —— 由计划的 digest + 本步 actionId 决定；部署把步骤绑回命令靠它。 */
  commandId: string;
  sceneId: string;
  /** = 计划步骤的 actionId(资源 id)。 */
  actionId: string;
  resourceId: string;
  kind: SceneResourceKind;
  /** 执行顺序(0 起，来自计划，不重排)。 */
  order: number;
  /** 依赖的其它命令的 actionId(来自计划)。 */
  dependsOn: string[];
  /** 失败能不能安全补偿(来自计划)。 */
  compensable: boolean;
  /** 本命令要交给服务的**声明正文**——就是 spec 里那条资源的 `spec`，逐字(不增删字段)。 */
  payload: Record<string, unknown>;
  /**
   * **投影后的真实 RPC 入参**(见 {@link adaptScenePayload})—— 执行端**必须**派发这一份,不是
   * `payload`。`null` = 载荷投影失败(见 {@link payloadProblems}),此时**不可派发**。
   *
   * 为什么与 `payload` 分开:声明正文仍是**记账 / digest 的真相**(`payload` 逐字保留,报告与审计
   * 看的是用户声明了什么),而 `rpcInput` 是把它翻成下游 schema 能收的形状 —— 两者不是一回事,
   * 混成一个就会「改了下游契约 → 记录的声明也变了」。
   */
  rpcInput: Record<string, unknown> | null;
  /**
   * 载荷投影失败时的**明确问题**(空数组 = 投影成功)。**绝不静默** —— 投影不出来的原因(缺字段 /
   * 未知 kind / 需先决议)逐条列出,执行端据此把该步如实记为「未执行 / 无法派发」。
   */
  payloadProblems: ScenePayloadProblem[];
  /** 该 kind 的既有服务入口声明(见 {@link SCENE_KIND_SERVICE_MAP})。 */
  service: SceneKindServiceEntry;
}

/** 一次编译的产物——有序命令 + 需决议清单 + 稳定摘要。 */
export interface SceneCommandPlan {
  sceneId: string;
  /** 编译来源计划的 digest(命令绑定的确切计划版本)。 */
  planDigest: string;
  /** 有序列命令（与计划的步骤一一对应，顺序一致）。 */
  commands: SceneStepCommand[];
  /**
   * 需要部署器进一步决议的 commandId 清单（`service.needsResolution` 为真的那些）。
   * **命令本身仍在 `commands` 里，绝不因为需要决议就丢掉**——这里只是让消费方一眼看到
   * 哪些还要决议。
   */
  unresolved: string[];
  /** 整份命令集的稳定摘要(改任一条命令的载荷/顺序/映射即变)。 */
  digest: string;
}

/* ── 稳定序列化 + FNV-1a(与 `scenePlan.ts` / `durableEvent.ts` 同款;契约不能引 node:crypto) ── */

function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v === undefined ? null : v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = walk(obj[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h ^= code & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (code >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** kind 不在枚举里时(调用方绕开了 `validateSceneSpec`)的显式「无法映射」——不静默丢。 */
function unknownKindEntry(kind: string): SceneKindServiceEntry {
  return {
    kind: kind as SceneResourceKind,
    serviceLabel: null,
    readback: null,
    compensation: { label: null, arg: null, note: `未知 kind「${kind}」无逆操作。` },
    identityPath: null,
    needsResolution: true,
    resolutionHint: null,
    note: `未知的资源 kind「${kind}」——不在 SceneResourceKind 枚举里，无既有服务可映射（应先经 validateSceneSpec）。`,
  };
}

/**
 * **从资源声明正文里取它在服务侧的稳定身份** —— 按 {@link SceneKindServiceEntry.identityPath}
 * 的点分路径在 `spec` 里取值(如 `id` / `name` / `manifest.id`),取到**非空字符串**才算数,
 * 否则返回 `null`。
 *
 * 回读与补偿都用**这个值**去查/撤真实的服务资源 —— 它不是场景内的资源 id(`SceneResourceRef.id`,
 * 那只在场景内唯一),而是该资源在**它自己的服务**里的身份(id / 插件名 / 服务器名…)。判据只有
 * 「声明里点分路径上是一个非空字符串」:路径不存在、值是 `undefined` / 非字符串 / 空串 → `null`
 * (**绝不**退化成用场景 id 冒充服务身份 —— 那样会拿一个对不上服务的值去回读,是「假装回读过了」)。
 *
 * `null` 有两种来源,含义不同,调用端都要**如实**区分:
 *  - `identityPath === null`(该 kind 声明里本就没有可从声明推出的稳定身份,如 `plugin` /
 *    `panel` / `scaffold`)—— 回读/补偿**天生无可依据**;
 *  - `identityPath` 非 null 但声明里**缺**那个字段(声明填不全)—— 这一条资源**这一次**取不到身份。
 *
 * @param kind 资源种类。
 * @param spec 该资源的声明正文(逐字来自 `SceneResourceRef.spec`)。
 */
export function sceneResourceIdentity(kind: SceneResourceKind, spec: Record<string, unknown>): string | null {
  const path = serviceForKind(kind).identityPath;
  if (path === null) return null;
  let cur: unknown = spec;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === "string" && cur.length > 0 ? cur : null;
}

/**
 * 取一个 kind 的服务映射。枚举内的 kind 直接查 {@link SCENE_KIND_SERVICE_MAP}；
 * 枚举外的(绕过校验)返回一条**显式**「无法映射」而不是 `undefined`(硬规矩 3)。
 */
export function serviceForKind(kind: string): SceneKindServiceEntry {
  return (SCENE_KIND_SERVICE_MAP as Record<string, SceneKindServiceEntry | undefined>)[kind]
    ?? unknownKindEntry(kind);
}

/* ── 载荷适配(MC-058 点名的缺字段缺陷:命令载荷缺真实 RPC 必需字段) ── */

/**
 * 一条载荷适配问题。`path` 指向**投影后** RPC 入参里的位置(如 `workflow` / `source`),
 * 便于执行端 / 报告 / 模型定位;`message` 给一句人读说明(取自真实 schema 的 zod 报错)。
 */
export interface ScenePayloadProblem {
  path: string;
  message: string;
}

/**
 * 载荷适配结果:要么是**能通过真实 schema 的 RPC 入参**,要么是**明确的投影问题**。
 * 二选一,不并存 —— 绝不产出一个「半成品入参」交给执行端(那会在 Zod 校验处才失败)。
 */
export type ScenePayloadAdaptResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; problems: ScenePayloadProblem[] };

/**
 * 用真实 schema 校验一个候选入参,把 zod 报错翻成 {@link ScenePayloadProblem}。
 * `ok` 时返回 **schema 解析后**的 data(passthrough / strip 已按该 schema 的取向规整)。
 */
function adaptViaSchema(schema: ZodTypeAny, candidate: Record<string, unknown>): ScenePayloadAdaptResult {
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    problems: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}

/**
 * **把一条资源的声明正文投影成它要交给的那个既有服务的真实 RPC 入参**(MC-058)。
 *
 * ## 它补的洞
 *
 * `SceneResourceRef.spec` 是**声明形态**,而每个 kind 映射到的既有 RPC 要的是**另一种入参形状**
 * —— `workflow.save` 要 `{ workflow: WorkflowDoc, expectedRevision? }`、`hooks.save` 要 `{ hook }`、
 * `skills.save` 要 `{ source, name, content }`、`mcp.save` 要 `{ name, config }`、`modules.install`
 * 要 `{ manifest, confirmReadAccess }`。直接把 `spec` 逐字当入参派发,会在**真实 handler 的
 * Schema.parse 处**被拒(实测:五类合法 SceneSpec 编出的请求五类全被拒)。
 *
 * ## 判据
 *
 *  - **只用真实 schema 校验**(硬规矩 2:形状只有一份,绝不在这里另抄字段清单)—— 各 kind 各自
 *    用 `WorkflowSaveSchema` / `HooksSaveSchema` / `SkillsSaveSchema` / `McpSaveSchema` /
 *    `ModuleInstallSchema` 解析投影后的候选;解析不过 → 返回**明确问题**,不产出半成品。
 *  - **不猜、不替用户确认**:`modules.install` 的 `confirmReadAccess` **必须由声明显式给出**
 *    (台账 ARC-002 明确:不能因为场景被批准了就把它自动置真);缺它 → 报问题。
 *  - **无法稳妥投影的 kind**(plugin/panel/scaffold 需先决议、枚举外的 kind)→ 返回**明确问题**
 *    (与 `SCENE_KIND_SERVICE_MAP` 的 `needsResolution` 同一取向:不猜一个入口 / 一份入参)。
 *
 * ## 各 kind 的投影规则(声明正文 `spec` 是什么)
 *
 *  - `workflow` / `automation`:`spec` **就是** `WorkflowDoc`;可选 `spec.expectedRevision`(乐观
 *    并发修订号,需先读一次才有 —— 不给则 schema 视为 null,即新建)。自动化即带 `trigger` 的
 *    工作流,同一入口同一形状。
 *  - `hook`:`spec` **就是** `HookSpec`;包一层 `{ hook }`。
 *  - `skill`:`spec` **就是** `{ source, name, content, projectPath?, newName? }`。
 *  - `mcp`:`spec` **就是** `{ name, config, replace? }`。
 *  - `module`:`spec` 给 `{ manifest, confirmReadAccess }`(strict,两字段都要)。
 *
 * @param kind 资源种类。
 * @param spec 该资源的声明正文(逐字来自 `SceneResourceRef.spec`)。
 */
export function adaptScenePayload(kind: SceneResourceKind, spec: Record<string, unknown>): ScenePayloadAdaptResult {
  switch (kind) {
    case "workflow":
    case "automation": {
      // 声明正文 **就是** WorkflowDoc;`expectedRevision` 从它里面**提出来**单独放(否则会被
      // WorkflowDocSchema strip 掉或当成多余键)。
      const { expectedRevision, ...workflow } = spec;
      const candidate: Record<string, unknown> = { workflow };
      if (expectedRevision !== undefined) candidate.expectedRevision = expectedRevision;
      return adaptViaSchema(WorkflowSaveSchema, candidate);
    }
    case "hook":
      // 声明正文 **就是** HookSpec;hooks.save 要 `{ hook }` 包一层。
      return adaptViaSchema(HooksSaveSchema, { hook: spec });
    case "skill":
      // 声明正文 **就是** SkillsSave 入参(projectPath 缺省 = 全局库)。
      return adaptViaSchema(SkillsSaveSchema, spec);
    case "mcp":
      // 声明正文 **就是** McpSave 入参。
      return adaptViaSchema(McpSaveSchema, spec);
    case "module":
      // modules.install 是 strict:`{ manifest, confirmReadAccess: true }`。
      // ⚠️ `confirmReadAccess` **必须由声明显式给出**(值是字面量 true)—— 绝不因为「场景被批准」
      //    就自动置真(那是把「场景级授权」冒充「用户已批准模块读取权限」)。
      return adaptViaSchema(ModuleInstallSchema, {
        manifest: spec.manifest,
        confirmReadAccess: spec.confirmReadAccess,
      });
    case "plugin":
      return {
        ok: false,
        problems: [{
          path: "",
          message: "plugin 无单一安装入口(installLocal / installGit / installMarketplace),需先按 spec.source 决议才能选定入参 —— 本层不猜,不投影",
        }],
      };
    case "panel":
      return {
        ok: false,
        problems: [{
          path: "",
          message: "panel 落在整块 customUi.config.v1(一个整块 setting)里,无单条入参 —— 需先决议,本层不投影",
        }],
      };
    case "scaffold":
      return {
        ok: false,
        problems: [{
          path: "",
          message: "scaffold 交整份模板 projectInit.apply(且需先 preview 取 digest),无单条入参 —— 需先决议,本层不投影",
        }],
      };
    default:
      // 枚举外(调用方绕开了 validateSceneSpec)→ 显式「无法映射」,不抛、不静默产出一个必然失败的入参。
      return {
        ok: false,
        problems: [{ path: "", message: `未知的资源 kind「${kind}」不在 SceneResourceKind 枚举里,无既有服务入口,无法投影 RPC 入参` }],
      };
  }
}

/**
 * 一条命令的**稳定 id** —— 由计划 digest + 本步 actionId + kind + order + 载荷共同决定
 * （键序无关）。部署把步骤绑回命令靠它；同一计划 + 同一载荷重复编译得到同一个 id。
 */
export function sceneCommandId(input: {
  planDigest: string;
  actionId: string;
  kind: SceneResourceKind;
  order: number;
  payload: Record<string, unknown>;
}): string {
  return `scenecmd:fnv1a:${fnv1aHex(canonicalize(input))}`;
}

/**
 * **把一份计划翻成命令描述符** —— 纯函数，**不执行任何东西**。
 *
 * 顺序**取自计划**（`plan.steps` 已是拓扑序），不在这里重排一遍（硬规矩 2：排序逻辑只有
 * `compileScenePlan` 一份）。每一步的去处：先按 `resourceId` 从 `spec.resources` 里取出那条
 * 资源的 `spec` 当载荷（逐字），再把该 kind 的服务映射挂上。
 *
 * 一致性守卫（绕开校验 / 传错对象时**显式报错**，不产出一份缺斤少两的命令集）：
 *  - `plan.specDigest !== sceneSpecDigest(spec)` → 抛错（计划和 spec 不是同一版）；
 *  - 某一步的 `resourceId` 在 `spec.resources` 里找不到 → 抛错（计划不是基于这份 spec 编译的）。
 *
 * @param plan 由 `compileScenePlan` 产出的计划（提供顺序与依赖）。
 * @param spec 该计划所基于的场景声明（提供每条资源的载荷正文）。
 */
export function compileSceneCommands(plan: ScenePlan, spec: SceneSpec): SceneCommandPlan {
  if (plan.specDigest !== sceneSpecDigest(spec)) {
    throw new Error("compileSceneCommands:计划与声明的 specDigest 不一致(计划不是基于这份 spec 编译的)");
  }
  const resourceById = new Map(spec.resources.map((r) => [r.id, r] as const));
  const commands: SceneStepCommand[] = plan.steps.map((step) => {
    const resource = resourceById.get(step.resourceId);
    if (resource === undefined) {
      throw new Error(`compileSceneCommands:计划步骤 ${step.actionId} 的资源在声明里找不到(计划与 spec 不匹配)`);
    }
    const service = serviceForKind(step.kind);
    // 载荷逐字：就是那条资源的 spec（浅拷贝一层，避免下游误改到 spec 上那份）。这是**声明正文
    // / 记账 / digest 的真相**，不因下游契约而变。
    const payload: Record<string, unknown> = { ...resource.spec };
    // 投影成**真实 RPC 入参**(MC-058)：交给执行端派发的是这一份,不是 payload。投影失败 → 明确的
    // 问题清单(绝不静默产出一个会在真实 handler 处被 Schema.parse 拒的入参)。
    const adapted = adaptScenePayload(step.kind, payload);
    const base: Omit<SceneStepCommand, "commandId"> = {
      sceneId: plan.sceneId,
      actionId: step.actionId,
      resourceId: step.resourceId,
      kind: step.kind,
      order: step.order,
      dependsOn: [...step.dependsOn],
      compensable: step.compensable,
      payload,
      rpcInput: adapted.ok ? adapted.input : null,
      payloadProblems: adapted.ok ? [] : adapted.problems,
      service,
    };
    const commandId = sceneCommandId({
      planDigest: plan.digest,
      actionId: step.actionId,
      kind: step.kind,
      order: step.order,
      payload: base.payload,
    });
    return { commandId, ...base };
  });
  const unresolved = commands.filter((c) => c.service.needsResolution).map((c) => c.commandId);
  const partial = { sceneId: plan.sceneId, planDigest: plan.digest, commands, unresolved };
  return { ...partial, digest: sceneCommandsDigest(partial) };
}

/** 整份命令集的**稳定摘要**（键序无关；改任一条命令的载荷/顺序/映射即变）。 */
export function sceneCommandsDigest(plan: Omit<SceneCommandPlan, "digest">): string {
  return `scenecommands:fnv1a:${fnv1aHex(canonicalize({
    sceneId: plan.sceneId,
    planDigest: plan.planDigest,
    commands: plan.commands.map((c) => ({
      commandId: c.commandId,
      actionId: c.actionId,
      kind: c.kind,
      order: c.order,
      dependsOn: c.dependsOn,
      payload: c.payload,
      // 投影后的真实入参也参与摘要：换了下游契约 / 少字段 → 命令集 digest 变(部署绑定它)。
      rpcInput: c.rpcInput,
      payloadProblems: c.payloadProblems,
      serviceLabel: c.service.serviceLabel,
      needsResolution: c.service.needsResolution,
    })),
    unresolved: plan.unresolved,
  }))}`;
}