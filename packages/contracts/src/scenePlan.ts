/**
 * **ScenePlan —— 场景的变更计划**(ARC-002 / MC-058)。
 *
 * ## 它在链上的位置
 *
 * ```text
 * SceneSpec(声明)  →  compileScenePlan()  →  ScenePlan(有序变更列表)  →  SceneCompiler(执行,后续切片)
 * ```
 *
 * 编译器**不执行任何东西**:它把一份**已校验的** `SceneSpec` 翻成一个**确定性的、按依赖拓扑排序的
 * 变更列表**,每个资源一条步骤。为什么要有这一步(而不是直接照 spec 顺序建):
 *
 *  1. **顺序**:一条自动化(触发器)依赖它要跑的工作流 —— 必须**先建工作流再建触发器**,否则
 *     触发器指向一个还不存在的图。拓扑排序把这件事变成编译器的事,不是调用方每次自己记得。
 *  2. **稳定 diff**:计划带 `planDigest`;同一个 spec 重复编译得到**同一个** digest ——
 *     「重复部署不产生额外节点/定时器」这条验收靠它判(见 MC-058)。
 *  3. **审批的对象是计划,不是 spec**:ARC-004 的计划级授权绑定的是 `planDigest`
 *     (批准之后 spec 被偷改 → digest 变 → 批准失效)。所以 digest 必须**只由语义内容**决定,
 *     不受键序/空白影响。
 *
 * ## 判据窄
 *
 * 只做「拓扑排序 + 稳定 digest」,**不**做能力预检(那要查本机真实能力,属部署 preflight)、
 * **不**生成命令、**不**碰磁盘。纯函数、无依赖。
 */
import type { SceneSpec, SceneResourceKind } from "./sceneSpec.js";

/** 计划里的一步 —— 对应 spec 里的一条资源。 */
export interface ScenePlanStep {
  /** 本步在计划内的稳定 id(= 资源 id;同一 spec 重编译不变)。 */
  actionId: string;
  resourceId: string;
  kind: SceneResourceKind;
  /** 执行顺序(0 起,按依赖拓扑)。**只由依赖关系决定**,与 spec 里的书写顺序无关。 */
  order: number;
  /** 本步依赖的其它步骤的 actionId(已存在于计划中)。 */
  dependsOn: string[];
  /**
   * 这一步**失败后能不能安全补偿**(撤掉本步已产生的资源)。
   *  - `true` —— 纯本地创建(工作流/触发器/面板):失败可删掉重建。
   *  - `false` —— 声明为不可补偿(如外部侧副作用);失败应停在 PARTIAL,交人核对。
   *  缺省(不声明)= `true`(本地资源,保守可补偿)。
   */
  compensable: boolean;
  /** 验收时**怎么证明这一步成了**的判据钩子(部署器据此回读);本契约只存类型,不执行。 */
  verifier: ScenePlanStepVerifier;
}

/** 一步的验收判据 —— 声明「凭什么说这一步成了」。部署器据 `kind` 做对应回读。 */
export interface ScenePlanStepVerifier {
  /** 回读方式:按资源 id 查它可见(`exists`)。 */
  kind: "exists";
  resourceId: string;
}

/** 一份编译好的计划。 */
export interface ScenePlan {
  sceneId: string;
  /** 编译来源 spec 的语义摘要(见 {@link sceneSpecDigest})。 */
  specDigest: string;
  /** 有序列变更列表(步骤 order 严格递增 0..n-1)。 */
  steps: ScenePlanStep[];
  /** 整份计划的稳定摘要 —— 计划级授权绑定它(见文件头第 3 条)。 */
  digest: string;
}

/** 稳定序列化:对象按 key 排序、数组保序(与 `@contracts/durableEvent` 同款,便于可复现 digest)。 */
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

/** FNV-1a(32 位)十六进制 —— 自足,不引 `node:crypto`(契约会被打进渲染端 bundle)。 */
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

/**
 * 一份 SceneSpec 的**语义摘要** —— 只由内容决定,不受键序/空白影响。
 * 用于「计划基于哪一版 spec」的可追溯(改一个字符就变)。
 */
export function sceneSpecDigest(spec: SceneSpec): string {
  return `scenespec:fnv1a:${fnv1aHex(canonicalize(spec))}`;
}

/** 一份 ScenePlan 的**稳定摘要** —— 计划级授权绑定它(改任一步的顺序/内容即变)。 */
export function scenePlanDigest(plan: Omit<ScenePlan, "digest">): string {
  return `sceneplan:fnv1a:${fnv1aHex(canonicalize(plan))}`;
}

/**
 * **把一份已校验的 SceneSpec 编译成 ScenePlan** —— 纯函数。
 *
 * 顺序规则:**按 `dependsOn` 拓扑排序**,同层(互不依赖)保持 spec 里的**书写顺序**(稳定,
 * 不因 Map 遍历顺序抖动)。`dependsOn` 必须已由 `validateSceneSpec` 保证「只引用存在的 id 且无环」
 * —— 所以这里用 Kahn 算法不会残留未排的节点;若调用方绕开校验喂进一个有环/悬空引用的 spec,
 * 本函数**抛错**(不静默产出一个缺了几步的计划)。
 *
 * @param spec 已通过 `validateSceneSpec` 的场景声明。
 */
export function compileScenePlan(spec: SceneSpec): ScenePlan {
  const ids = new Set(spec.resources.map((r) => r.id));
  // 依赖边去重 + 只保留存在的 id(悬空引用在这里 = 调用方绕开了校验,抛错)。
  const deps = new Map<string, string[]>();
  for (const r of spec.resources) {
    const list = (r.dependsOn ?? []).filter((d) => d !== r.id);
    for (const d of r.dependsOn ?? []) {
      if (!ids.has(d)) {
        throw new Error(`compileScenePlan:资源 ${r.id} 依赖了不存在的 id ${d}(应先经 validateSceneSpec)`);
      }
      if (d === r.id) {
        throw new Error(`compileScenePlan:资源 ${r.id} 自依赖(应先经 validateSceneSpec)`);
      }
    }
    deps.set(r.id, [...new Set(list)]);
  }
  // Kahn 拓扑排序;入度 0 的节点按 spec 书写顺序(用原始下标)稳定出队。
  const indexOf = new Map(spec.resources.map((r, i) => [r.id, i] as const));
  const indeg = new Map<string, number>();
  for (const r of spec.resources) indeg.set(r.id, (deps.get(r.id) ?? []).length);
  const ready: string[] = spec.resources.filter((r) => (indeg.get(r.id) ?? 0) === 0).map((r) => r.id);
  ready.sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0));
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    // 找一个「解除后入度归零」的邻居:遍历剩余资源,谁依赖 id 就减它的入度。
    const unlocked: string[] = [];
    for (const r of spec.resources) {
      const d = deps.get(r.id) ?? [];
      if (!d.includes(id)) continue;
      const next = (indeg.get(r.id) ?? 0) - 1;
      indeg.set(r.id, next);
      if (next === 0) unlocked.push(r.id);
    }
    unlocked.sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0));
    ready.push(...unlocked);
  }
  if (ordered.length !== spec.resources.length) {
    // 有环 —— 校验该拦下;到这里说明调用方绕开了校验。
    throw new Error("compileScenePlan:资源依赖存在环(应先经 validateSceneSpec)");
  }
  const byId = new Map(spec.resources.map((r) => [r.id, r] as const));
  const steps: ScenePlanStep[] = ordered.map((id, order) => {
    const r = byId.get(id)!;
    return {
      actionId: id,
      resourceId: id,
      kind: r.kind,
      order,
      dependsOn: [...(deps.get(id) ?? [])],
      // spec 里显式声明 `spec.compensable === false` 时不可补偿;否则本地资源默认可补偿。
      compensable: r.spec.compensable !== false,
      verifier: { kind: "exists", resourceId: id },
    };
  });
  const partial = { sceneId: spec.sceneId, specDigest: sceneSpecDigest(spec), steps } satisfies Omit<ScenePlan, "digest">;
  return { ...partial, digest: scenePlanDigest(partial) };
}
