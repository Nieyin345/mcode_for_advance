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
    needsResolution: false,
    resolutionHint: null,
    note: "工作流图交既有 workflow.save 建立（WorkflowSaveInput）。",
  },
  automation: {
    kind: "automation",
    serviceLabel: "workflow.save",
    readback: { label: "workflow.get", mode: "byArg", arg: "id", field: "workflow", matchField: "id" },
    compensation: { label: "workflow.remove", arg: "id", note: "自动化就是工作流，workflow.remove 按 id 删除。" },
    needsResolution: false,
    resolutionHint: null,
    note: "自动化就是带 trigger 的工作流（见 @contracts/workflow 文件头），无独立 automation.save，走同一个 workflow.save。",
  },
  skill: {
    kind: "skill",
    serviceLabel: "skills.save",
    readback: { label: "skills.list", mode: "byList", arg: null, field: "skills", matchField: "name" },
    compensation: { label: null, arg: null, note: "skills.delete 还要 source（global/project）才能定位删哪条目录，单靠资源 id 不足以稳妥撤销——本层不猜，如实记为未补偿。" },
    needsResolution: false,
    resolutionHint: null,
    note: "技能声明交既有 skills.save 落成 SKILL.md（SkillsSaveInput）。",
  },
  plugin: {
    kind: "plugin",
    serviceLabel: null,
    readback: { label: "plugins.list", mode: "byList", arg: null, field: "plugins", matchField: "name" },
    compensation: { label: "plugins.remove", arg: "name", note: "plugins.remove 按插件名卸载（若这一步已建成）。" },
    needsResolution: true,
    resolutionHint: "spec.source(本地 / git / 市场)",
    note: "插件安装入口取决于来源：plugins.installLocal / plugins.installGit / plugins.installMarketplace——仓里无单一 plugins.install，交部署器按 spec.source 决议。",
  },
  mcp: {
    kind: "mcp",
    serviceLabel: "mcp.save",
    readback: { label: "mcp.list", mode: "byList", arg: null, field: "servers", matchField: "name" },
    compensation: { label: "mcp.remove", arg: "name", note: "mcp.remove 按服务器名删掉刚写入的 MCP 声明。" },
    needsResolution: false,
    resolutionHint: null,
    note: "MCP 声明交既有 mcp.save（McpSaveInput）。",
  },
  hook: {
    kind: "hook",
    serviceLabel: "hooks.save",
    readback: { label: "hooks.list", mode: "byList", arg: null, field: "hooks", matchField: "id" },
    compensation: { label: "hooks.remove", arg: "id", note: "hooks.remove 按钩子 id 删掉刚装上的钩子。" },
    needsResolution: false,
    resolutionHint: null,
    note: "钩子声明交既有 hooks.save（HooksSaveInput），与 HookRunner 同一份定义。",
  },
  module: {
    kind: "module",
    serviceLabel: "modules.install",
    readback: { label: "modules.catalog", mode: "byList", arg: null, field: "modules", matchField: "id" },
    compensation: { label: "modules.remove", arg: "moduleId", note: "modules.remove 按模块 id 卸载刚装上的模块。" },
    needsResolution: false,
    resolutionHint: null,
    note: "模块声明交既有 modules.install（ModuleInstallInput）。",
  },
  panel: {
    kind: "panel",
    serviceLabel: "setting.set",
    readback: null,
    compensation: { label: null, arg: null, note: "面板落在整块 customUi.config.v1 里，无单条删除入口（删一条要重写整块配置）；本层不猜，如实记为未补偿。" },
    needsResolution: true,
    resolutionHint: "customUi.config.v1",
    note: "面板落在自定义 UI 配置这一个整块 setting（CUSTOM_UI_SETTING_KEY）里——需决议：单条面板要并进整份配置，不是逐面板一个入口。",
  },
  scaffold: {
    kind: "scaffold",
    serviceLabel: "projectInit.apply",
    readback: null,
    compensation: { label: null, arg: null, note: "脚手架条目由整份模板 projectInit.apply 落盘，无单条撤销入口；本层不猜，如实记为未补偿。" },
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
    needsResolution: true,
    resolutionHint: null,
    note: `未知的资源 kind「${kind}」——不在 SceneResourceKind 枚举里，无既有服务可映射（应先经 validateSceneSpec）。`,
  };
}

/**
 * 取一个 kind 的服务映射。枚举内的 kind 直接查 {@link SCENE_KIND_SERVICE_MAP}；
 * 枚举外的(绕过校验)返回一条**显式**「无法映射」而不是 `undefined`(硬规矩 3)。
 */
export function serviceForKind(kind: string): SceneKindServiceEntry {
  return (SCENE_KIND_SERVICE_MAP as Record<string, SceneKindServiceEntry | undefined>)[kind]
    ?? unknownKindEntry(kind);
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
    const base: Omit<SceneStepCommand, "commandId"> = {
      sceneId: plan.sceneId,
      actionId: step.actionId,
      resourceId: step.resourceId,
      kind: step.kind,
      order: step.order,
      dependsOn: [...step.dependsOn],
      compensable: step.compensable,
      // 载荷逐字：就是那条资源的 spec（浅拷贝一层，避免下游误改到 spec 上那份）。
      payload: { ...resource.spec },
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
      serviceLabel: c.service.serviceLabel,
      needsResolution: c.service.needsResolution,
    })),
    unresolved: plan.unresolved,
  }))}`;
}