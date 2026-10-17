/**
 * **GrantStore 的磁盘侧** —— 把 GrantStore 的窄持久化接口 `GrantStorePersist`
 * 落到一份**独立 JSON 文件**上(ARC-004 实施步 ④ 的持久化切片)。
 *
 * ## 为什么不放在 SettingRepo(来源判据)
 *
 * ARC-004 的「明确禁止」列着「把审批状态放在**可导入的普通 setting** 中」。
 * `SettingRepo` 正是 `ipc/settingsTransfer.ts` 整表导出/导入的那张表
 * (`keysWithPrefix("")` 全量进导入),把每台机器、每个用户各自点头得到的授权塞进去,
 * 一次「导入设置」就能把别人的授权搬进本机、或把本机授权覆盖掉 —— 授权是**本机本用户**
 * 的事实,必须落在一份**不参与设置导入导出**的独立文件里。落盘复用仓库既有的
 * `atomicWrite`(tmp + rename,与 extensionStore / skillEngines 同款,共享实现只有一份),
 * 写到一半崩了不会留下半份 JSON、也不会污染数据库。
 *
 * ## 纯核心 + 注入 blob
 *
 * 本文件**不 import electron**(`@main/lib/appContext` 本身也不 import electron,已核实);
 * 真正的磁盘读写收在一个极窄的 `BlobIO`(`read` / `write` 两个方法)后面。生产用
 * `atomicFileBlob(path)` 得到真落盘的那份;无头 smoke 注入一个内存对象当桩,绝不去碰
 * 用户数据根。序列化 / 反序列化是纯函数,单独可测。
 *
 * ## 坏数据 = 空 store(fail-safe),不是抛 —— 与 engineToolPolicy 相反
 *
 * 读到的文件坏掉(非 JSON / 非本信封 / 版本不符)→ 当**空 store**,不崩。⚠️ 这与
 * `engineToolPolicy` 的取舍**恰好相反**:那边把坏配置读成空 = 把原本禁用的工具**重新
 * 启用** = fail-open,故必须拒绝执行(MC-071);这里空 store 的后果是「本机没有任何
 * 授权」—— 执行点查不到 grant → 回到「重新批准」,是**收紧**而非放宽。故此处丢掉坏数据
 * 是安全的 fail-safe;唯一条纪律是**绝不**把读不懂的东西当成「全部允许」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Grant } from "@contracts/policyEngine";
import type { GrantStorePersist } from "./grantStore.js";
import { atomicWrite } from "@main/lib/appContext.js";

/** 落盘信封的版本号;形状将来变了靠它分辨「旧文件」,而不是把旧数据硬读成新结构。 */
export const GRANT_STORE_VERSION = 1;

/** 磁盘上的信封:`{ version, grants }`。 */
export interface GrantStoreEnvelope {
  version: number;
  grants: Grant[];
}

/** 极窄的磁盘读写口 —— 生产用 `atomicFileBlob`,测试注入内存桩(充当可注入的 get/set)。 */
export interface BlobIO {
  /** 读整份文本;文件不存在 / 读不了 → null。 */
  read(): string | null;
  /** 覆盖写整份文本。 */
  write(text: string): void;
}

/** 真落盘的 `BlobIO`:读 `readFileSync`(失败当没有),写 `atomicWrite`(tmp + rename)。 */
export function atomicFileBlob(file: string): BlobIO {
  return {
    read() {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null; // 不存在 / 读不了 → 当没有(→ 空 store)
      }
    },
    write(text) {
      atomicWrite(file, text);
    },
  };
}

/** 授权文件路径:`<数据根>/appControl/grants.json`(数据根**由调用方注入**,纯字符串)。 */
export function grantStorePath(dataRoot: string): string {
  return join(dataRoot, "appControl", "grants.json");
}

/**
 * **可选布尔字段的严格判据**(MC-020)—— 缺席(`undefined`)仍合法(向后兼容),
 * 在场则必须是布尔;`"no"` / `0` / `null` 这类类型错一律判坏。
 *
 * 与 {@link isOptionalNonNegativeInteger} 一样是**两套授权解码器共用**的唯一一份判据:
 * 计划级授权(本文件)与主机 hook 授权(`../../hooks/hostHookGrantFile.ts`)逐字复用,
 * 免得一处收紧、另一处漂松(仓库硬规矩 2)。
 */
export function isOptionalBoolean(v: unknown): boolean {
  return v === undefined || typeof v === "boolean";
}

/**
 * **可选数值字段的严格判据**(MC-020)—— 缺席仍合法;在场必须是**有限非负整数**
 * (`Number.isFinite` 且 `Number.isInteger` 且 `>= 0`)。`'bad'` / `NaN` / `Infinity`
 * / `-1` / `1.5` 全部判坏。
 *
 * 为什么必须收这么紧:`countBudgetExhausted` 是 `used >= limit` 的**数值比较**,
 * `'bad' >= 1` 为 false —— 坏值(mc-020 第四轮 E1 红例: `maxCount:1, usedCount:'bad'`)
 * 一旦混进表,「已用尽」就被误读成「还有余额」,额度判定被整体绕过。隔离比比较更早、
 * 也更省事:坏记录根本不该进表。
 */
export function isOptionalNonNegativeInteger(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0);
}

/**
 * 一份 grant 是否**形状正确**到足以落盘 / 载回。缺必需字段 / 类型不对一律判否(→ 隔离)。
 * **可选字段同样严格**(MC-020):缺席合法,在场必须是布尔 / 有限非负整数 ——
 * `revoked: "no"`、`usedCount: "bad"`、`usedCount: NaN` / -1 / 小数这类坏值若放进表,
 * 会让 `countBudgetExhausted` 的数值比较误读额度(`'bad' >= 1` 为 false),
 * 把「已用尽」错当「还有余额」。坏记录**隔离**(不进 Map、不参与额度判定),只会收紧。
 */
export function isGrantShape(x: unknown): x is Grant {
  if (!x || typeof x !== "object") return false;
  const g = x as Record<string, unknown>;
  if (typeof g.grantId !== "string" || g.grantId === "") return false;
  if (typeof g.sceneId !== "string") return false;
  if (!Array.isArray(g.allowedActions) || g.allowedActions.some((a) => typeof a !== "string")) return false;
  if (!g.scopedCore || typeof g.scopedCore !== "object") return false;
  if (typeof g.configHash !== "string") return false;
  if (typeof g.expiresAt !== "number") return false;
  const src = g.approvalSource as Record<string, unknown> | undefined;
  if (!src || typeof src !== "object" || typeof src.kind !== "string" || typeof src.id !== "string") return false;
  // ★ MC-020:可选字段的**严格**校验(两套解码器共用判据,见文件头 helper)。
  if (!isOptionalBoolean(g.revoked)) return false;
  if (!isOptionalNonNegativeInteger(g.maxCount)) return false;
  if (!isOptionalNonNegativeInteger(g.usedCount)) return false;
  if (!isOptionalNonNegativeInteger(g.maxBudget)) return false;
  if (!isOptionalNonNegativeInteger(g.budgetUsed)) return false;
  return true;
}

/** 序列化:整份信封,缩进两格。**原样带出** `revoked` / `expiresAt` —— 重启后撤销与过期才仍生效。 */
export function serializeGrants(grants: Grant[]): string {
  const env: GrantStoreEnvelope = { version: GRANT_STORE_VERSION, grants };
  return JSON.stringify(env, null, 2) + "\n";
}

/**
 * **逐条校验并隔离坏记录 + 显式报告**(MC-020)—— 形状对的留下,坏的**不进结果**,
 * 并在 `console.warn` 里报出「第几条、被隔离了」。
 *
 * 为什么用 `console.warn` 而不是 `@main/lib/logger`:本文件是 **electron-free 叶子**
 * (文件头写着「不 import electron」),真 logger 依赖 electron —— 与
 * `sessionCleanupHooks.ts` 同一取舍(那个叶子的注释同样写着「用 console.warn 而不是
 * @main/lib/logger 是为了保住这个叶子的零依赖」)。
 *
 * 为什么报告是「隔离」而不是「抛」:坏记录按不存在处理 = 授权收紧(回到重新批准),
 * 是 fail-safe;但**不静默**(仓库硬规矩 3)—— 用户/日志得看得见哪一条没了、为什么。
 * 两套授权解码器(本文件与 `../../hooks/hostHookGrantFile.ts`)共用这一份「隔离+报告」
 * 流程,措辞与行为不会漂成两套。
 */
export function filterShapesOrWarn<T>(
  items: readonly unknown[],
  isShape: (x: unknown) => x is T,
  fileLabel: string,
): T[] {
  const kept: T[] = [];
  items.forEach((item, index) => {
    if (isShape(item)) {
      kept.push(item);
      return;
    }
    const rawId = (item as Record<string, unknown> | null)?.grantId;
    const who = typeof rawId === "string" && rawId !== "" ? `(grantId「${rawId}」)` : "";
    console.warn(
      `${fileLabel} 第 ${index + 1} 条记录形状不合法(必需字段缺失或可选字段类型错误),已隔离、不参与授权判定:${who}`,
    );
  });
  return kept;
}

/**
 * 反序列化 —— **fail-safe**:任何读不懂的输入都当空 store。
 *   - `null`(文件不存在)→ 空;
 *   - 非 JSON、非对象、版本不符、`grants` 不是数组 → 空;
 *   - 数组里**逐条**校验:形状不对的那一条**隔离**(不进结果、不参与额度判定)并
 *     **显式报告**(`console.warn`,见 {@link filterShapesOrWarn})—— 不静默丢;
 *     其余保留(丢一条授权只会收紧,不会放宽 —— 与「坏数据当空」同一条纪律)。
 */
export function parseGrants(json: string | null): Grant[] {
  if (json == null) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const env = data as Partial<GrantStoreEnvelope>;
  if (env.version !== GRANT_STORE_VERSION) return [];
  if (!Array.isArray(env.grants)) return [];
  return filterShapesOrWarn(env.grants, isGrantShape, "grants.json");
}

/**
 * **跨实例写入的乐观并发约束**(MC-016 验收条件「并发两个实例」)。
 *
 * ## 它挡的是什么
 *
 * `GrantStore` 的 `commit` 是「把**本实例内存里的全量**写出去」。两个进程(或多开一份)
 * 各自载入同一份 `grants.json` 后各签一枚授权,后写的那份会把先写那份的授权**整份盖掉**
 * —— 而两个实例各自的内存里都认为"签发成功"。同进程内的 `assertGrantIdFree` 看不见
 * 另一个实例的写入,所以那条守卫对跨实例无效。
 *
 * ## 怎么挡(不引入锁文件)
 *
 * 用**内容比较 + 重读合并**:写之前先重读磁盘;若磁盘上的授权集合与本实例**上次载入/写入**
 * 时的基线不同(多了别的实例写的),说明有第三方写入 —— 此时:
 *   - 本次写入的每一条**新授权** id 在磁盘上已存在 → 冲突,拒写(调用方拿到
 *     `GrantStoreError`,与同进程撞名同一形状);
 *   - 否则把磁盘上多出来的授权**并进**候选全量再写 —— 不丢别人的授权,也不静默覆盖。
 *
 * 退一步说:这是**文件系统层的最后写赢**,不可能是强一致(没有跨进程锁)。但它把
 * 「静默覆盖别人的授权」变成「显式冲突 / 合并保留」,正是 MC-016 要求的
 * 「碰撞必须拒绝并保留旧记录」。进程内并发仍由 `commit` 的同步临界区保证。
 *
 * ## 为什么基线是「上次读到的全量」
 *
 * 每个 `BlobIO` 适配器持有一份 `baseline`(`load` 时更新、`save` 成功后更新)。比较的是
 * **id 集合**而不是字节:字节会因键序 / 缩进不同而假冲突(id 集合相同即视为同一份)。
 */
export interface FileGrantPersist extends GrantStorePersist {
  /** 最近一次成功 load / save 时的授权 id 集合(冲突判据的基线;测试可读)。 */
  baselineIds(): readonly string[];
}

export function fileGrantPersist(blob: BlobIO): FileGrantPersist {
  let baseline = new Set<string>();
  const remember = (grants: readonly Grant[]): void => {
    baseline = new Set(grants.map((g) => g.grantId));
  };
  return {
    load: () => {
      const grants = parseGrants(blob.read());
      remember(grants);
      return grants;
    },
    save: (grants) => {
      // ① 重读磁盘:看有没有**别的实例**在我们上次读写之后写过。
      const onDisk = parseGrants(blob.read());
      const onDiskIds = new Set(onDisk.map((g) => g.grantId));
      const incomingIds = new Set(grants.map((g) => g.grantId));
      const foreign = [...onDiskIds].filter((id) => !baseline.has(id));
      if (foreign.length > 0) {
        // ② 有第三方写入:本次**新增**的 id 若与它撞名 → 拒(不覆盖别人的授权)。
        const collisions = [...incomingIds].filter((id) => !baseline.has(id) && onDiskIds.has(id));
        if (collisions.length > 0) {
          throw new Error(
            `授权写入冲突:${collisions.join("、")} 已被另一个实例写入(磁盘上已有,本实例基线里没有)。` +
              "拒绝覆盖 —— 重新读取授权后再签发。",
          );
        }
        // ③ 没有撞名:把磁盘上多出来的授权**并进**候选全量再写(不丢别人的)。
        const merged = new Map<string, Grant>();
        for (const g of onDisk) merged.set(g.grantId, g);
        for (const g of grants) merged.set(g.grantId, g);
        const all = [...merged.values()];
        blob.write(serializeGrants(all));
        remember(all);
        return;
      }
      blob.write(serializeGrants(grants));
      remember(grants);
    },
    /** 冲突判据的基线(测试与诊断可读;生产不消费)。 */
    baselineIds: () => [...baseline],
  };
}
