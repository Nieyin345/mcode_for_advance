/**
 * **场景预检服务(只读)** —— ARC-002 / MC-058:校验 + 编译 + **能力预检**。
 *
 * 与 `scenePlanning.ts` 的 `planScene` 同一条链,只是多走最后一步:把宿主**已装配的能力清单**
 * 喂给 `sceneCapabilityPreflight`,回答「这份声明要用的能力,本机在不在、对这个引擎适不适用」。
 *
 * ## 这条命令同样**不执行任何东西**
 *
 * 只读:不建资源、不装插件、不碰磁盘(清单来自内存中的注册表 / 已启用插件读数)。
 * 「预检通过」只意味着「现有能力够用」,**不**等于获得执行权限 —— 执行仍要独立的计划级授权
 * (ARC-004)。
 *
 * ## 清单来源(与 runner 的能力预检同源)
 *
 * `collectCapabilityInventory` 的输入全是参数:providers 来自 `providerRegistry`、plugins 来自
 * `getEnabledPlugins`、executorKinds 来自 `executionEngine`、宿主内置来自 `HOST_CAPABILITY_DECLARATIONS`。
 * 本服务负责**装配**这份清单,再把纯判定交给 `sceneCapabilityPreflight`。
 */
import { validateSceneSpec } from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import { sceneCapabilityPreflight } from "@contracts/scenePreflight";
import type { ScenePreflightInput, ScenePreflightIpcResult, ScenePlanWire } from "@contracts/ipc";
import { providerRegistry } from "@main/providers/registry.js";
import { getEnabledPlugins } from "@main/plugins/pluginManager.js";
import { executionEngine } from "@main/orchestration/executionEngine.js";
import {
  HOST_CAPABILITY_DECLARATIONS,
  collectCapabilityInventory,
  hostCapabilityDeclarationsFromCatalog,
} from "@main/orchestration/capabilityResolver.js";
import { getModuleHost } from "@main/modules/service.js";

/** 把一份 `ScenePlanResult` 的计划部分转成过 IPC 的线格(与 `planScene` 保持一致的一份实现)。 */
function toPlanWire(plan: ReturnType<typeof compileScenePlan>): ScenePlanWire {
  return {
    sceneId: plan.sceneId,
    specDigest: plan.specDigest,
    digest: plan.digest,
    steps: plan.steps.map((s) => ({
      actionId: s.actionId,
      resourceId: s.resourceId,
      kind: s.kind,
      order: s.order,
      dependsOn: [...s.dependsOn],
      compensable: s.compensable,
      verifier: { kind: s.verifier.kind, resourceId: s.verifier.resourceId },
    })),
  };
}

/**
 * 规划 + 预检一份候选场景声明。校验失败一次报全(不抛);通过则编译并做能力预检。
 *
 * 装配清单失败时**不吞**:能力清单装配不了(注册表读不动 / 插件清单读失败)本身就是故障,
 * 不该伪装成「预检通过」—— 那样会把「没查到」谎报成「都在」。
 */
export async function preflightScene(input: ScenePreflightInput): Promise<ScenePreflightIpcResult> {
  const validation = validateSceneSpec(input.spec);
  if (!validation.ok) {
    return { ok: false, problems: validation.problems };
  }
  const plan = compileScenePlan(validation.spec);
  const plugins = (await getEnabledPlugins()).map((p) => ({
    name: p.name,
    manifest: p.manifest,
    compatibleProviderIds: p.compatibleProviderIds,
    componentReports: p.componentReports,
  }));
  // 【MC-035】已安装扩展的能力进**同一份**清单:从宿主注册表现读(卸载/重装后立刻生效),
  // 与 `modules.catalog` / `app_api_*` / 工作流预检看的是同一张注册表,不另存声明。
  const moduleCatalog = await (await getModuleHost()).catalog();
  const inventory = collectCapabilityInventory({
    providers: providerRegistry.list(),
    plugins,
    executorKinds: [...executionEngine.kinds()],
    hostCapabilities: [...HOST_CAPABILITY_DECLARATIONS, ...hostCapabilityDeclarationsFromCatalog(moduleCatalog)],
  });
  const preflight = sceneCapabilityPreflight(validation.spec, inventory);
  return {
    ok: true,
    plan: toPlanWire(plan),
    preflight: {
      ok: preflight.ok,
      gaps: preflight.gaps.map((g) => ({ ...g, missingCapabilities: [...g.missingCapabilities] })),
      requiredGaps: preflight.requiredGaps.map((g) => ({ ...g, missingCapabilities: [...g.missingCapabilities] })),
      checkedCapabilities: preflight.checkedCapabilities,
    },
  };
}
