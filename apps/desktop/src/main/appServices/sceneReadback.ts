import {
  type SceneSpec,
  type SceneResourceKind,
} from "@contracts/sceneSpec";
import { serviceForKind, sceneResourceIdentity } from "@contracts/sceneCommands";
import type { SceneDeployment, SceneStepPriorExistence } from "@contracts/sceneDeployment";
import { callRpc, findEntry } from "@main/appControl/tools.js";

/**
 * `sceneDeploy` 的**独立回读**（M-C058，从 `sceneDeploy.ts` 拆出）。
 *
 * 收尾验收用的「真实资源回读」：`probeResource` / `readbackScene` /
 * `probeExistingResource` 与它们的返回类型。只依赖 `callRpc` / `findEntry` 与
 * sceneSpec / sceneCommands 的契约类型，对 deploy 的状态机零引用。
 * **纯搬迁，函数体逐字节一致。**
 */
/* ───────────────────────── 独立回读(M-C058 的真实资源回读) ───────────────────────── */

/** 一条资源的**独立回读**结果。 */
export interface SceneStepReadback {
  actionId: string;
  kind: SceneResourceKind;
  /** 是否**独立回读**到了宿主真实资源(查得到才算 present)。 */
  observed: boolean;
  /** 回读所用入口标签(如 `workflow.get`);无回读入口时为 `null`。 */
  readLabel: string | null;
  /** 不能独立回读的原因(无回读入口 / 查询出错);能回读时为 `null`。 */
  unverifiableReason: string | null;
}

/** 一次部署的**独立回读**汇总 —— `observed` 直接喂给 `evaluateAcceptance`。 */
export interface SceneReadbackResult {
  steps: SceneStepReadback[];
  /** 独立回读到的资源 actionId 集合(= 喂给 `evaluateAcceptance` 的 observed)。 */
  observed: string[];
  /** 无法独立回读的资源 actionId(无回读入口 / 查询出错)—— 明确列出,不当成 present。 */
  unverifiable: string[];
}

/**
 * 对**一条**资源做独立回读 —— 调 `service.readback` 描述的既有入口,按**服务侧稳定身份**
 * 重新查询宿主真实资源。判据只有「查得到才 present」:绝不从部署记录里推。
 *
 * ## 按**真实契约钉死身份**(MC-058 残余②)
 *
 * 回读用的**不是**场景内的资源 id(`actionId`),而是该资源在**它自己的服务**里的稳定身份
 * ——由 {@link sceneResourceIdentity} 从声明正文(`spec`)按 kind 的 `identityPath` 取出
 * (`workflow`→`doc.id`、`skill`/`mcp`→`name`、`hook`→`id`、`module`→`manifest.id`)。各服务
 * 返回形状不统一,身份字段也各不相同;拿场景 id 去查一个按服务身份索引的列表,会**永远匹配
 * 不上**(假绿)。**声明里推不出稳定身份**(该 kind 的 `identityPath` 为 null,如 plugin / panel /
 * scaffold;或这一条声明缺那个字段)时,如实记 **`unverifiable`**,**绝不**用它去查。
 *
 * @param actionId 资源 id(= 计划步骤的 actionId;回读结果按它回报)。
 * @param kind 资源种类(决定回读入口与匹配字段)。
 * @param spec 该资源的声明正文(提供它在服务侧的稳定身份)。
 */
export async function probeResource(actionId: string, kind: SceneResourceKind, spec: Record<string, unknown>): Promise<SceneStepReadback> {
  const entry = serviceForKind(kind);
  const rb = entry.readback;
  if (rb === null) {
    return {
      actionId,
      kind,
      observed: false,
      readLabel: null,
      unverifiableReason: `kind「${kind}」无单条确定回读入口,无法独立回读(如实记为「未验证」,不当成 present)`,
    };
  }
  // ★ 按真实契约钉死身份:声明里推不出稳定身份 → 坦白记「未验证」,绝不用永远匹配不上的值假装回读过了。
  const identity = sceneResourceIdentity(kind, spec);
  if (identity === null) {
    return {
      actionId,
      kind,
      observed: false,
      readLabel: rb.label,
      unverifiableReason:
        entry.identityPath === null
          ? `kind「${kind}」的声明里没有可从声明推出的稳定身份,无法可靠回读(如实记为「未验证」,绝不拿一个永远匹配不上的值假装回读过了)`
          : `声明正文里缺稳定身份字段「${entry.identityPath}」,无法可靠回读(如实记为「未验证」)`,
    };
  }
  try {
    const rpc = findEntry(rb.label);
    if (!rpc) {
      return { actionId, kind, observed: false, readLabel: rb.label, unverifiableReason: `回读入口「${rb.label}」在当前版本里没有注册` };
    }
    if (rb.mode === "byArg") {
      const res = (await callRpc(rpc, { [rb.arg as string]: identity })) as Record<string, unknown> | null;
      const node = res?.[rb.field];
      const observed = typeof node === "object" && node !== null && !Array.isArray(node);
      return { actionId, kind, observed, readLabel: rb.label, unverifiableReason: null };
    }
    const res = (await callRpc(rpc, {})) as Record<string, unknown> | null;
    const list = res?.[rb.field];
    const observed =
      Array.isArray(list) && list.some((x) => typeof x === "object" && x !== null && (x as Record<string, unknown>)[rb.matchField] === identity);
    return { actionId, kind, observed, readLabel: rb.label, unverifiableReason: null };
  } catch (err) {
    return { actionId, kind, observed: false, readLabel: rb.label, unverifiableReason: `回读查询出错:${(err as Error).message}` };
  }
}

/**
 * **独立回读一次部署的真实资源** —— 对部署里每一步的资源按 kind 调**既有回读入口**重新查询
 * 宿主是否真的存在它,收成 `observed`(可直接喂 `evaluateAcceptance`)。
 *
 * 与「本次走到 done 的步」的关键区别(MC-058 点名的缺口):**资源被带外删掉**时,部署记录里那步
 * 仍是 `done`,但这里**查不到** → 不进 `observed` → 验收不通过。只信记录会把这谎报成成功。
 *
 * @param deployment 要回读的部署记录(以它的 steps 为要回读的资源清单)。
 * @param spec 该部署基于的场景声明(提供每条资源的 kind)。
 */
export async function readbackScene(deployment: SceneDeployment, spec: SceneSpec): Promise<SceneReadbackResult> {
  const resourceById = new Map(spec.resources.map((r) => [r.id, r] as const));
  const steps: SceneStepReadback[] = [];
  for (const step of deployment.steps) {
    const resource = resourceById.get(step.actionId);
    if (resource === undefined) {
      steps.push({
        actionId: step.actionId,
        kind: "workflow",
        observed: false,
        readLabel: null,
        unverifiableReason: `部署步骤「${step.actionId}」在声明里找不到对应资源,无法回读`,
      });
      continue;
    }
    steps.push(await probeResource(step.actionId, resource.kind, resource.spec));
  }
  const observed = steps.filter((s) => s.observed).map((s) => s.actionId);
  const unverifiable = steps.filter((s) => s.unverifiableReason !== null).map((s) => s.actionId);
  return { steps, observed, unverifiable };
}

/* ─────────────── 派发前探测(MC-058 补偿安全闸:资源是本次新建还是覆盖既有) ─────────────── */

/** 派发**前**对目标资源的一次探测结果:它存不存在(created / preExisting)、当前修订号、服务侧身份。 */
interface PriorResourceProbe {
  existence: SceneStepPriorExistence;
  /** 探测到的当前修订号(byArg 结果里的 `revision` 字段;拿不到为 `null`)。 */
  revision: string | null;
  /**
   * 探测所用 / 回读到的**服务侧稳定身份**(`workflow`→doc.id、`skill`/`mcp`→name、`hook`→id、
   * `module`→manifest.id);声明里推不出稳定身份时为 `null`(此时不探测、记 `unknown`)。落进
   * 部署步骤的 `resourceUid` —— 补偿时用它去撤真实资源(按服务身份,不是按场景 id)。
   */
  uid: string | null;
}

/**
 * **派发前探测**目标资源在宿主里是否**已经存在** —— 调该 kind 的既有回读入口查一次,查的是
 * 该资源在**它自己的服务**里的稳定身份(见 {@link sceneResourceIdentity})。
 *
 * 这是补偿安全闸的第一半(MC-058):`workflow.save` 的 `id` 是**主键**,往一个已存在的 id 存
 * 就是**覆盖**它。故补偿必须知道「这一步动的是谁的资源」——只有**本次新建**的才敢撤,**覆盖
 * 既有的绝不删除**(删了就把用户原有资源整个抹掉)。
 *
 * 判据只有「查得到 = 已存在」,与 {@link probeResource} 同一份回读口径;查不到 / 无入口 / 出错
 * / **声明里推不出稳定身份** 一律记 **`unknown`**(**绝不猜成 `created`** —— 猜错会误删)。
 *
 * @param kind 资源种类(决定回读入口与匹配字段)。
 * @param spec 该资源的声明正文(提供它在服务侧的稳定身份)。
 */
export async function probeExistingResource(kind: SceneResourceKind, spec: Record<string, unknown>): Promise<PriorResourceProbe> {
  const entry = serviceForKind(kind);
  const rb = entry.readback;
  if (rb === null) return { existence: "unknown", revision: null, uid: null };
  // ★ 按真实契约钉死身份:声明里推不出稳定身份 → 不探测(记 unknown),绝不用场景 id 冒充服务身份。
  const uid = sceneResourceIdentity(kind, spec);
  if (uid === null) return { existence: "unknown", revision: null, uid: null };
  try {
    const rpc = findEntry(rb.label);
    if (!rpc) return { existence: "unknown", revision: null, uid };
    if (rb.mode === "byArg") {
      const res = (await callRpc(rpc, { [rb.arg as string]: uid })) as Record<string, unknown> | null;
      const node = res?.[rb.field];
      const present = typeof node === "object" && node !== null && !Array.isArray(node);
      const revision = typeof res?.revision === "string" ? res.revision : null;
      return { existence: present ? "preExisting" : "created", revision, uid };
    }
    const res = (await callRpc(rpc, {})) as Record<string, unknown> | null;
    const list = res?.[rb.field];
    const present =
      Array.isArray(list) && list.some((x) => typeof x === "object" && x !== null && (x as Record<string, unknown>)[rb.matchField] === uid);
    const revision = typeof res?.revision === "string" ? res.revision : null;
    return { existence: present ? "preExisting" : "created", revision, uid };
  } catch {
    return { existence: "unknown", revision: null, uid };
  }
}