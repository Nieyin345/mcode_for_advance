/**
 * **HostHookGrant 的磁盘侧** —— 把主机 hook 授权的**可注入持久化接口** `HostHookGrantPersist`
 * 落到一份**独立 JSON 文件**上(MC-061「HostHookGrant 未持久化」这一片的落盘一半)。
 *
 * ## 为什么要持久化(而不是停在内存表)
 *
 * `hostHookGrants.ts` 此前是**纯内存** Map:进程一重启就空,于是用户对某条插件 hook 的授信
 * **每次开机都得重签** —— 这不是安全,而是把「默认拒绝」当成了「永远拒绝」。授权是**本机本用户**
 * 的事实,该跨重启活着,撤销 / 过期也才在重启后仍生效(与 ARC-004 的 GrantStore 同一条纪律)。
 *
 * ## 为什么不放进 SettingRepo(来源判据)
 *
 * 与 `grantStoreFile.ts` **同一条理由**:授权状态**不得**落在 `SettingRepo` —— 那张表整份参与
 * 「导入设置 / 导出设置」(`keysWithPrefix("")` 全量进出),把本机本用户的授信塞进去,一次导入就能
 * 把别人的授权搬进本机、或把本机授权覆盖掉。授权必须落在一份**不参与设置导入导出**的独立文件里。
 *
 * ## 纯核心 + 注入 blob(共享实现只有一份)
 *
 * 真正的磁盘读写**复用** `appControl/grantStoreFile.ts` 已有的 `BlobIO` + `atomicFileBlob`
 * (tmp + rename,与 extensionStore / skillEngines 同款)——**不再另写一份文件 IO**。生产用
 * `atomicFileBlob(path)` 得到真落盘的那份;无头 smoke 注入一个内存对象当桩,绝不去碰用户数据根。
 * 序列化 / 反序列化是纯函数,单独可测。
 *
 * ## 坏数据 = 空 store(fail-safe),不是抛
 *
 * 读到的文件坏掉(非 JSON / 非本信封 / 版本不符)→ 当**空 store**,不崩。与 GrantStore 的
 * `parseGrants` 取舍一致:空 store 的后果是「本机没有任何主机 hook 授权」,执行点查不到 → 回到
 * 「默认拒绝」—— 是**收紧**而非放宽。唯一条纪律是**绝不**把读不懂的东西当成「全部允许」。
 */
import { join } from "node:path";
import type { HostHookGrant } from "@contracts/hostHookGrant";
import {
  atomicFileBlob,
  filterShapesOrWarn,
  isOptionalNonNegativeInteger,
  type BlobIO,
} from "@main/appControl/grantStoreFile.js";
import { configureHostHookGrantPersist, type HostHookGrantPersist } from "./hostHookGrants.js";

/** 落盘信封的版本号;形状将来变了靠它分辨「旧文件」,而不是把旧数据硬读成新结构。 */
export const HOST_HOOK_GRANT_VERSION = 1;

/** 磁盘上的信封:`{ version, grants }`。 */
export interface HostHookGrantEnvelope {
  version: number;
  grants: HostHookGrant[];
}

/** 授权文件路径:`<数据根>/hooks/host-hook-grants.json`(数据根**由调用方注入**,纯字符串)。 */
export function hostHookGrantStorePath(dataRoot: string): string {
  return join(dataRoot, "hooks", "host-hook-grants.json");
}

/**
 * 一份授权是否**形状正确**到足以落盘 / 载回。缺必需字段 / 类型不对一律判否(→ 隔离)。
 * 可选字段(`matcherDigest` / `version`)允许缺省;但**执行预算字段同样严格**(MC-020,
 * 与 `grantStoreFile.isGrantShape` 一套判据):`maxRuns` / `usedRuns` 缺席合法、在场必须是
 * 有限非负整数 —— 第四轮 E1 红例证实过 `usedRuns: 'bad'` 会让 `countBudgetExhausted`
 * 的数值比较(`'bad' >= 1` 为 false)把「已用尽」误读成「还有余额」,额度被绕过。
 * 坏记录**隔离**只会收紧,不会放宽。
 */
export function isHostHookGrantShape(x: unknown): x is HostHookGrant {
  if (!x || typeof x !== "object") return false;
  const g = x as Record<string, unknown>;
  if (typeof g.grantId !== "string" || g.grantId === "") return false;
  if (typeof g.pluginId !== "string" || g.pluginId === "") return false;
  if (!(g.version === undefined || typeof g.version === "string")) return false;
  if (!Array.isArray(g.events) || g.events.some((e) => typeof e !== "string")) return false;
  if (typeof g.commandDigest !== "string") return false;
  if (!(g.matcherDigest === undefined || typeof g.matcherDigest === "string")) return false;
  if (typeof g.issuedAt !== "number" || typeof g.expiresAt !== "number") return false;
  if (typeof g.revoked !== "boolean") return false;
  // ★ MC-020:执行预算字段的**严格**校验(与 grantStoreFile 共用 ../../appControl/grantStoreFile 的判据)。
  if (!isOptionalNonNegativeInteger(g.maxRuns)) return false;
  if (!isOptionalNonNegativeInteger(g.usedRuns)) return false;
  return true;
}

/** 序列化:整份信封,缩进两格。**原样带出** `revoked` / `expiresAt` —— 重启后撤销与过期才仍生效。 */
export function serializeHostHookGrants(grants: HostHookGrant[]): string {
  const env: HostHookGrantEnvelope = { version: HOST_HOOK_GRANT_VERSION, grants };
  return JSON.stringify(env, null, 2) + "\n";
}

/**
 * 反序列化 —— **fail-safe**:任何读不懂的输入都当空 store。
 *   - `null`(文件不存在)→ 空;
 *   - 非 JSON、非对象、版本不符、`grants` 不是数组 → 空;
 *   - 数组里**逐条**校验:形状不对的那一条**隔离**(不进结果、不参与额度判定)并
 *     **显式报告**(共用 `grantStoreFile.filterShapesOrWarn` 的 `console.warn`);
 *     其余保留(丢一条授权只会收紧,不会放宽)。
 *
 * ⚠️ **注意**:把损坏读成空表是安全的**读**语义,但**不能**成为**写**的依据 —— 见
 * {@link classifyHostHookGrantArchive} 与 `hostHookGrants.ts` 的 `commit`(MC-029)。
 */
export function parseHostHookGrants(json: string | null): HostHookGrant[] {
  if (json == null) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const env = data as Partial<HostHookGrantEnvelope>;
  if (env.version !== HOST_HOOK_GRANT_VERSION) return [];
  if (!Array.isArray(env.grants)) return [];
  return filterShapesOrWarn(env.grants, isHostHookGrantShape, "host-hook-grants.json");
}

/**
 * **存档健康度**(MC-029,与 `unattendedPlanStore.classifyUnattendedPlanArchive` 同判据):
 * 文件不存在 = `absent`;在但读不懂 = `corrupt`。分母与 {@link parseHostHookGrants} 逐条对齐。
 * 个别坏记录被丢**不算** corrupt(那是有意的"丢一条只会收紧")。
 */
export function classifyHostHookGrantArchive(json: string | null): "absent" | "valid" | "corrupt" {
  if (json == null) return "absent";
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return "corrupt";
  }
  if (!data || typeof data !== "object") return "corrupt";
  const env = data as Partial<HostHookGrantEnvelope>;
  if (env.version !== HOST_HOOK_GRANT_VERSION) return "corrupt";
  if (!Array.isArray(env.grants)) return "corrupt";
  return "valid";
}

/** 把一份 `BlobIO` 适配成 `hostHookGrants.ts` 认的窄持久化接口。 */
export function fileHostHookGrantPersist(blob: BlobIO): HostHookGrantPersist {
  return {
    load: () => parseHostHookGrants(blob.read()),
    save: (grants) => blob.write(serializeHostHookGrants(grants)),
    // 只如实报告健康度,不在这里 import logger(本模块 electron-free);上报由持有核的
    // `isArchiveCorrupt()` 与装配层负责。
    health: () => classifyHostHookGrantArchive(blob.read()),
  };
}

/**
 * **纯装配函数**:给定数据根,装配一份**落盘版**的主机 hook 授权持久化,并把它接到
 * `hostHookGrants.ts` 的授权表上(载入已存授权 + 之后每次签发 / 撤销都落盘)。
 *
 * 落点由 {@link hostHookGrantStorePath} 决定 —— `<数据根>/hooks/host-hook-grants.json`,
 * 与 `grantStoreFile.ts` 同源:授权是**本机本用户**的事实,**不参与设置导入导出**。
 * `main/index.ts` 那层只传真实的 `dataRoot()`;无头 smoke 传临时目录即可,绝不碰数据根。
 *
 * 与 `assembleGrantStore` 同姿势 —— 唯一区别是授权表本身(`hostHookGrants.ts`)已是模块级单例,
 * 所以这里不另立单例,只把持久化接上去。真落盘的 `BlobIO` **复用**
 * `grantStoreFile.atomicFileBlob`(tmp + rename),不另写一份文件 IO。
 */
export function assembleHostHookGrantPersist(dataRoot: string): HostHookGrantPersist {
  const persist = fileHostHookGrantPersist(atomicFileBlob(hostHookGrantStorePath(dataRoot)));
  configureHostHookGrantPersist(persist);
  return persist;
}
