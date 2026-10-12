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
 * 一份 grant 是否**形状正确**到足以落盘 / 载回。缺必需字段 / 类型不对一律判否(→ 丢弃)。
 * 只校验**必需**字段(见契约 `Grant`);可选字段(`revoked` / `usedCount` / `budgetUsed` …)
 * 原样随 JSON 往返,不做类型纠缠 —— 丢一条授权只会收紧,不会放宽。
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
  return true;
}

/** 序列化:整份信封,缩进两格。**原样带出** `revoked` / `expiresAt` —— 重启后撤销与过期才仍生效。 */
export function serializeGrants(grants: Grant[]): string {
  const env: GrantStoreEnvelope = { version: GRANT_STORE_VERSION, grants };
  return JSON.stringify(env, null, 2) + "\n";
}

/**
 * 反序列化 —— **fail-safe**:任何读不懂的输入都当空 store。
 *   - `null`(文件不存在)→ 空;
 *   - 非 JSON、非对象、版本不符、`grants` 不是数组 → 空;
 *   - 数组里**逐条**校验:形状不对的那一条**丢掉**,其余保留(丢一条授权只会收紧,
 *     不会放宽 —— 与「坏数据当空」同一条纪律)。
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
  return env.grants.filter(isGrantShape);
}

/** 把一份 `BlobIO` 适配成 `GrantStore` 认的窄持久化接口。 */
export function fileGrantPersist(blob: BlobIO): GrantStorePersist {
  return {
    load: () => parseGrants(blob.read()),
    save: (grants) => blob.write(serializeGrants(grants)),
  };
}
