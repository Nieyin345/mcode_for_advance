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

/**
 * **已安装扩展的能力目录** —— 装配层注入。
 *
 * ## 为什么是注入而不是在这里取
 *
 * 这份目录从前来自 ，而 ModuleHost 已整体删除（扩展统一到 Theia
 * plugin host）。Theia 侧的「扩展声明了哪些能力」还没有对应物 —— 所以这里**不猜**：
 * 没有注入时按空集处理（预检对扩展能力一律判缺失，fail-closed），而不是假装它们都在。
 *
 * 空集对用户是可解释的：「这个场景要的扩展能力本机没登记」；假装存在会让预检判绿、
 * 部署之后才在运行期炸。
 *
 * ## ⚠️ 现状（2026-10-27）：**这个注入点还没有任何装配方调用**
 *
 * 也就是说：**装了扩展，场景预检仍然报「扩展能力本机不可用」**，因为目录始终是空集。
 * 这是 fail-closed 的方向（不会误判绿），但**它是缺口不是设计** —— 别把「预检说没有」
 * 读成「确实没有」。
 *
 * 补上它需要先回答一个问题：Theia 扩展怎么声明自己的场景能力？VS Code 扩展模型里
 * **没有** `capabilities: [{kind: "query"|"action"|"task"}]` 这个概念 —— 所以不能
 * 直接把 Theia 的 registry 接过来当目录用，得先定一份映射或约定。
 * 在定下来之前，保持空集比编一份假的映射安全。
 */
let extensionCatalogSource: (() => { capabilities: readonly { id: string; kind: "query" | "action" | "task" }[] } | undefined) | null = null;

/** 装配层调用：把「本机装了哪些扩展能力」接进来。传 null 解除。 */
export function setSceneExtensionCatalogSource(
  source: (() => { capabilities: readonly { id: string; kind: "query" | "action" | "task" }[] } | undefined) | null,
): void {
  extensionCatalogSource = source;
}

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
  const inventory = collectCapabilityInventory({
    providers: providerRegistry.list(),
    plugins,
    executorKinds: [...executionEngine.kinds()],
    hostCapabilities: [
      ...HOST_CAPABILITY_DECLARATIONS,
      ...hostCapabilityDeclarationsFromCatalog(extensionCatalogSource?.()),
    ],
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
