/**
 * **ScenePreflight —— 场景的能力预检**(ARC-002 / MC-058 的「部署器能力预检」切片)。
 *
 * ## 它在链上的位置
 *
 * ```text
 * SceneSpec(声明) → validateSceneSpec → compileScenePlan → **sceneCapabilityPreflight** → 真正部署
 * ```
 *
 * 编译只回答「按什么顺序建」。但在建之前还有一件**绝不能跳过**的事:这份声明里要用的
 * 能力(插件 / 技能 / MCP / 模块),**这台机器上到底有没有、对这个引擎适不适用**。
 * MC-058 拒绝的正是「声明写完就开跑、跑一半才发现插件没装」—— 用户看到的是场景建了一半、
 * 某一步莫名其妙失败。预检把这件事**提到部署之前**,一次说清「缺什么」,而不是让模型/用户
 * 在部署中途撞墙。
 *
 * ## 两条判据(写在返回里)
 *
 * 1. **必需能力缺了 = 预检不通过**(`ok:false`)—— 部署应当被挡在门外,先让用户补齐。
 * 2. **可选能力缺了 = 部分可用**(`ok` 仍为 true,该条进 `gaps` 但**不**进 `requiredGaps`)——
 *    场景仍可部署,只是少一块;报告里如实列出,不假装它可用。
 *
 * 这两条对应 `SceneCapabilityRef.required` 的语义(缺省 = 必需)。**不查真实安装之外的东西**
 * —— 本函数只做「声明 ↔ 清单」的确定匹配,不联网、不装插件、不碰磁盘。
 *
 * ## 为什么不 import 主进程
 *
 * 输入是**已经装配好的能力清单**(`CapabilityDescriptor[]`,由宿主从 provider 注册表 / 已启用
 * 插件 / 执行器注册表算出),本文件只消费它。于是它可被渲染端 / 无头 smoke 直接打包,
 * 判定核也可逐条钉住。
 */
import type { CapabilityDescriptor, CapabilityKind } from "./capability.js";
import { resolveCapabilities } from "./capability.js";
import type { SceneCapabilityRef, SceneSpec } from "./sceneSpec.js";

/**
 * 一个**能力缺口** —— 声明里要的能力,清单里没有或不适用。
 * 比 `resolveCapabilities` 的原始结果多带两件「给人看 / 给判定用」的事实:`required`
 * (缺了会不会挡住部署)与 `source`(缺口来自哪条声明)。
 */
export interface ScenePreflightGap {
  /** 声明的能力种类(与 `SceneCapabilityRef.kind` 同形)。 */
  kind: SceneCapabilityRef["kind"];
  /** 能力 id。 */
  id: string;
  /** `missing` = 清单里根本没有;`incompatible` = 有,但对当前引擎/节点不适用或缺细粒度能力。 */
  reason: "missing" | "incompatible";
  /** `incompatible` 时:这条能力还缺哪些细粒度能力。 */
  missingCapabilities: string[];
  /** 是否必需(来自声明的 `required`;缺省为 true)。必需缺口会让 `ok` 变 false。 */
  required: boolean;
  /** 人读的一句话(进部署报告 / 模型回读)。 */
  detail: string;
}

/** 预检结果。`ok` 只由**必需**缺口决定;可选缺口照样进 `gaps` 供展示。 */
export interface ScenePreflightResult {
  /** 必需能力全部就位 → true。可选缺口**不**影响它。 */
  ok: boolean;
  /** 全部缺口(必需 + 可选),顺序 = 声明顺序。 */
  gaps: ScenePreflightGap[];
  /** 只含必需缺口(挡部署的那些);`ok === (requiredGaps.length === 0)`。 */
  requiredGaps: ScenePreflightGap[];
  /** 预检了几条能力(便于报告「查了 N 条、缺 M 条」)。 */
  checkedCapabilities: number;
}

/**
 * 声明的能力种类 → 清单用的 `CapabilityKind`。
 *
 * `module` 不在 `CapabilityKind` 里 —— 模块能力在清单里以 `builtin` 露面(见
 * `capabilityResolver.hostCapabilityDescriptors`),所以这里映射到 `builtin`。
 * 其余三类同名直通。
 */
const KIND_TO_CAPABILITY: Record<SceneCapabilityRef["kind"], CapabilityKind> = {
  plugin: "plugin",
  skill: "skill",
  mcp: "mcp",
  module: "builtin",
};

/**
 * **对一份已校验的 SceneSpec 做能力预检** —— 确定性纯函数。
 *
 * 把 `spec.capabilities` 逐条翻成能力需求,对**已装配的清单**做匹配(`resolveCapabilities`),
 * 把缺的/不适用的收成 `gaps`;再按 `required` 分出挡部署的 `requiredGaps`。
 *
 * @param spec      已通过 `validateSceneSpec` 的场景声明。
 * @param inventory 宿主装配的能力清单(providers + 已启用插件 + 执行器 + 宿主内置)。
 */
export function sceneCapabilityPreflight(
  spec: SceneSpec,
  inventory: readonly CapabilityDescriptor[],
): ScenePreflightResult {
  const refs = spec.capabilities;
  const requirements = refs.map((c) => ({
    kind: KIND_TO_CAPABILITY[c.kind],
    id: c.id,
  }));
  const resolution = resolveCapabilities(requirements, inventory, {
    // 声明的首选引擎参与适用性判定:带 `providers: ["claude-sdk"]` 约束的能力,只有
    // 选定了该引擎才算适用 —— 否则「声明明明选对了引擎却报不适用」是最冤枉的假阳性。
    ...(spec.preferredProviderId ? { providerId: spec.preferredProviderId } : {}),
  });
  const gaps: ScenePreflightGap[] = [];
  // 顺序 = 声明顺序:遍历 refs,按 (kind,id) 在 resolution 里找回它的判定结果。
  for (const ref of refs) {
    const capabilityKind = KIND_TO_CAPABILITY[ref.kind];
    const required = ref.required !== false; // 缺省 = 必需
    const missing = resolution.missing.find((m) => m.kind === capabilityKind && m.id === ref.id);
    if (missing) {
      gaps.push({
        kind: ref.kind,
        id: ref.id,
        reason: "missing",
        missingCapabilities: [],
        required,
        detail: `${ref.kind}「${ref.id}」在本机不可用${required ? "(必需)" : "(可选)"}`,
      });
      continue;
    }
    const incompatible = resolution.incompatible.find(
      (i) => i.requirement.kind === capabilityKind && i.requirement.id === ref.id,
    );
    if (incompatible) {
      const missingCaps = incompatible.missingCapabilities;
      gaps.push({
        kind: ref.kind,
        id: ref.id,
        reason: "incompatible",
        missingCapabilities: [...missingCaps],
        required,
        detail:
          missingCaps.length > 0
            ? `${ref.kind}「${ref.id}」存在但缺细粒度能力:${missingCaps.join("、")}${required ? "(必需)" : "(可选)"}`
            : `${ref.kind}「${ref.id}」存在但对当前引擎/上下文不适用${required ? "(必需)" : "(可选)"}`,
      });
    }
  }
  const requiredGaps = gaps.filter((g) => g.required);
  return {
    ok: requiredGaps.length === 0,
    gaps,
    requiredGaps,
    checkedCapabilities: refs.length,
  };
}
