/**
 * **宿主内置能力的唯一一份目录**（【MC-035】修法的一部分）。
 *
 * ## 它解决什么
 *
 * 同一对内置能力（`core.file.inspect` / `core.file.info`）从前在**两个地方各写一遍**：
 *
 *   - `modules/fileCapabilities.ts` 的 `fileCapabilities()` —— 真正注册给 `ModuleHost`
 *     的实现（id + kind 在这里）；
 *   - `orchestration/capabilityResolver.ts` 的 `HOST_CAPABILITY_DECLARATIONS` ——
 *     场景预检 / 工作流预检读的**声明**表（id + moduleKind 又写一遍）。
 *
 * 两份名单靠 `capability-smoke` 的"喂进目录后查得到"钉着，漂了会红 —— 但那是**事后**
 * 发现。台账 MC-035 点名这是"同一能力注册表还手写第二份声明"的孤岛形态。
 *
 * ## 为什么拆成这个文件
 *
 * `capabilityResolver.ts` **刻意不 import `modules/service`**：那会经 `dataRoot()` 把
 * DB / electron 拖进预检那条纯路径（它的文件头写着"保持纯函数"）。所以权威目录必须
 * 落在一个**不碰 fs / dataRoot / electron** 的模块里，两边都能安全 import。
 *
 * 本文件只有常量与类型，没有副作用。
 *
 * ## 加新内置能力时
 *
 * 只改这里，然后在 `fileCapabilities.ts` 里实现对应 `run`。**不要再往
 * `capabilityResolver.ts` 抄第二份 id 列表** —— 两份同名不同步正是这条台账的形态。
 */

/** `ModuleHost` 认的能力种类。与 `modules/ModuleHost.ts` 的 `Capability.kind` 同域。 */
export type BuiltinCapabilityKind = "query" | "action" | "task";

export interface BuiltinCapabilityEntry {
  /** 能力 id —— 模块清单的 `contributions[].capability` 就引用它。 */
  readonly id: string;
  /** 能力种类。`action` 需要模块显式声明 `resource.write`（见 `missingCapabilityPermission`）。 */
  readonly kind: BuiltinCapabilityKind;
  /** 给用户看的来源标签（能力目录 / 诊断文案）。 */
  readonly source: string;
}

/**
 * 宿主自带、**实现在生产主进程里**的能力。顺序即展示顺序。
 *
 * ⚠️ 这份清单与 `fileCapabilities()` 的**产出**是同一件事：后者用这里的 `id`/`kind`
 * 构造能力对象，`capabilityResolver.ts` 的 `HOST_CAPABILITY_DECLARATIONS` 也从这里
 * 派生。`capability-smoke` 逐项比对三者（目录 / 实现产出 / 预检声明）。
 */
export const BUILTIN_CAPABILITY_CATALOGUE: readonly BuiltinCapabilityEntry[] = [
  { id: "core.file.inspect", kind: "task", source: "host" },
  { id: "core.file.info", kind: "query", source: "host" },
];
