/**
 * **无人值守任务计划的存档** —— 把一份已签发的计划**正文**落盘,让「签发了但还没执行(或
 * 执行到一半)时应用重启」这件事真的能闭合(MC-059 残余 ④:跨重启 WAITING_APPROVAL)。
 *
 * ## 它在补哪个洞(源码可确认)
 *
 * `unattendedTaskPlan.ts` 的 `approveUnattendedPlan` 只调 `issueGrant` 铸出一枚计划级授权 ——
 * **授权本身**经 `appControl/grantStoreFile.ts` 落盘(跨重启读得回),但**计划正文**
 * (哪几步、在哪个项目、标题 / 首条消息是什么)只活在渲染端内存里。于是进程一关:
 *   - 授权的 `sceneId` 还在 `grants.json`,但**它对应哪份计划**无从读回(正文没了);
 *   - 「等待批准 / 待执行」的计划**列不出来**(没有可枚举的正文源);
 *   - 「执行到一半」续跑更无从谈起(不知道剩下的步骤是什么)。
 *
 * 本模块给计划正文一条**与授权同源**的落盘路径:复用 `grantStoreFile.ts` 的同一套窄姿势
 * (`BlobIO` 落到一份**独立 JSON 文件** + `atomicWrite` 的 tmp+rename),落点是
 * `<数据根>/appControl/unattended-plans.json`。
 *
 * ## 为什么不放进 `grants.json` / 为什么不另造一张表
 *
 *  - **不进 `grants.json`**:那份信封由 `GrantStore` 独占,它每次签发 / 撤销 / 记账都
 *    `flush()` **整份覆盖**——把计划正文塞进去会被下一次 `flush` 静默清掉。两者的**生命周期
 *    本就不同**:授权可被撤销 / 过期,而计划正文是一份「批准过什么」的记录。
 *  - **不另造一张表**:授权与计划都是**本机本用户**的事实,不参与设置导入导出(理由见
 *    `grantStoreFile.ts` 文件头)。故本模块**不碰 DB / SettingRepo**,只走**同一套**文件落盘
 *    机制(`atomicWrite` + `BlobIO`),与授权文件并列放在 `appControl/` 下。
 *
 * ## 坏数据 = 空 store(fail-safe),与 `grantStoreFile.ts` 同一条纪律
 *
 * 读到的文件坏掉(非 JSON / 非本信封 / 版本不符)→ 当**空 store**,不崩;数组里**逐条**校验,
 * 形状不对的那一条丢掉、其余保留。空 store 的后果是「看不出有哪些计划在等」—— 回到「重新
 * 批准」,是**收紧**而非放宽;唯一条纪律是**绝不**把读不懂的东西当成一份有效计划去执行。
 */
import { join } from "node:path";
import type { BlobIO } from "@main/appControl/grantStoreFile.js";
import { atomicFileBlob } from "@main/appControl/grantStoreFile.js";
import type { UnattendedOperation } from "./unattendedTaskPlan.js";

/** 存档信封的版本号;形状将来变了靠它分辨「旧文件」,而不是把旧数据硬读成新结构。 */
export const UNATTENDED_PLAN_STORE_VERSION = 1;

/** 一份计划在存档里的**状态**。`pending` = 待执行(还没跑完);`completed` = 已跑完;`abandoned` = 明确放弃。 */
export type UnattendedPlanStatus = "pending" | "completed" | "abandoned";

/**
 * 一份**已签发计划**的存档记录 —— 计划正文 + 它绑定的授权 id + 执行到哪一步的事实。
 *
 * ⚠️ 这里**不存授权内容**(那在 `grants.json`),只存 `grantId` 这枚**指针**。是否还能跑由
 * `getGrantStore()` 现取现判(撤销 / 过期 / 次数用尽)—— 存档**绝不自带一份"还能跑"的判断**,
 * 那会与授权核分家。
 */
export interface UnattendedPlanRecord {
  planId: string;
  /** 授权核里的 scene id(= `unattended.<planId>` 或缺省展开后的那个)。 */
  sceneId: string;
  projectId: string;
  /** 计划绑定的授权 id(指针,不是授权内容)。 */
  grantId: string;
  /** 计划声明的操作序列(正文 —— 上次「执行到一半」要续跑就靠它)。 */
  operations: UnattendedOperation[];
  maxCount: number;
  /** 签发时刻(ms epoch)。 */
  createdAt: number;
  /** 计划此刻的状态(执行完毕 / 放弃由执行端回写)。 */
  status: UnattendedPlanStatus;
  /**
   * **已建成的操作 id**(逐条建会话成功后回写)。续跑(`resume`)**跳过**它们 —— 重跑就是重复的
   * 外部副作用(再建一条会话 / 再发一条首条消息)。这是「跳过已建成、只跑剩下的」那条判据的
   * **落盘依据**(与 `sceneDeploy` 的 `runPlanSteps` 跳过 `done` 步同取向)。
   */
  completedOperationIds: string[];
  /** 上次执行停在哪一条 / 为什么(没跑过或没停过为 null)。 */
  lastStoppedAt: string | null;
  lastStopCode: string | null;
}

/** 磁盘上的信封:`{ version, plans }`。 */
export interface UnattendedPlanEnvelope {
  version: number;
  plans: UnattendedPlanRecord[];
}

/** 极窄的持久化接口 —— 与 `GrantStorePersist` 同姿势(load 全量 / save 全量)。 */
export interface UnattendedPlanStorePersist {
  load(): UnattendedPlanRecord[] | null;
  save(plans: UnattendedPlanRecord[]): void;
}

/** 授权文件路径的姊妹:`<数据根>/appControl/unattended-plans.json`(数据根**由调用方注入**,纯字符串)。 */
export function unattendedPlanStorePath(dataRoot: string): string {
  return join(dataRoot, "appControl", "unattended-plans.json");
}

/** 一条操作是否**形状正确**到足以落盘 / 载回(逐条校验,坏的丢掉、好的留着)。 */
function isOperationShape(x: unknown): x is UnattendedOperation {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.operationId !== "string" || o.operationId === "") return false;
  if (o.method !== "session.create") return false;
  if (o.prompt !== undefined && typeof o.prompt !== "string") return false;
  if (o.title !== undefined && typeof o.title !== "string") return false;
  if (o.expectedRevision !== undefined && typeof o.expectedRevision !== "string") return false;
  return true;
}

/**
 * 一份计划记录是否**形状正确**到足以落盘 / 载回。缺必需字段 / 类型不对一律判否(→ 丢弃)。
 * 只校验**必需**字段,可选字段原样随 JSON 往返 —— 丢一条计划只会收紧(回到「重新批准」),不会放宽。
 */
export function isUnattendedPlanRecordShape(x: unknown): x is UnattendedPlanRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (typeof r.planId !== "string" || r.planId === "") return false;
  if (typeof r.sceneId !== "string") return false;
  if (typeof r.projectId !== "string" || r.projectId === "") return false;
  if (typeof r.grantId !== "string" || r.grantId === "") return false;
  if (!Array.isArray(r.operations) || r.operations.length === 0) return false;
  if (!r.operations.every(isOperationShape)) return false;
  if (typeof r.maxCount !== "number") return false;
  if (typeof r.createdAt !== "number") return false;
  if (r.status !== "pending" && r.status !== "completed" && r.status !== "abandoned") return false;
  if (!Array.isArray(r.completedOperationIds) || r.completedOperationIds.some((x) => typeof x !== "string")) return false;
  if (r.lastStoppedAt !== null && typeof r.lastStoppedAt !== "string") return false;
  if (r.lastStopCode !== null && typeof r.lastStopCode !== "string") return false;
  return true;
}

/** 序列化:整份信封,缩进两格 —— 与 `serializeGrants` 同一姿势(可读、diff 友好)。 */
export function serializeUnattendedPlans(plans: UnattendedPlanRecord[]): string {
  const env: UnattendedPlanEnvelope = { version: UNATTENDED_PLAN_STORE_VERSION, plans };
  return JSON.stringify(env, null, 2) + "\n";
}

/**
 * 反序列化 —— **fail-safe**:任何读不懂的输入都当空 store。
 *   - `null`(文件不存在)→ 空;
 *   - 非 JSON、非对象、版本不符、`plans` 不是数组 → 空;
 *   - 数组里**逐条**校验:形状不对的那一条**丢掉**,其余保留。
 */
export function parseUnattendedPlans(json: string | null): UnattendedPlanRecord[] {
  if (json == null) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const env = data as Partial<UnattendedPlanEnvelope>;
  if (env.version !== UNATTENDED_PLAN_STORE_VERSION) return [];
  if (!Array.isArray(env.plans)) return [];
  return env.plans.filter(isUnattendedPlanRecordShape);
}

/** 把一份 `BlobIO` 适配成 {@link UnattendedPlanStorePersist}(与 `fileGrantPersist` 同姿势)。 */
export function fileUnattendedPlanPersist(blob: BlobIO): UnattendedPlanStorePersist {
  return {
    load: () => parseUnattendedPlans(blob.read()),
    save: (plans) => blob.write(serializeUnattendedPlans(plans)),
  };
}

/* ───────────────────────── 持有核 + 单例读取口 ───────────────────────── */

/** 防御性浅拷贝 —— 调用方改返回结果不污染 store 内部。 */
function cloneRecord(p: UnattendedPlanRecord): UnattendedPlanRecord {
  return {
    ...p,
    operations: p.operations.map((o) => ({ ...o })),
    completedOperationIds: [...p.completedOperationIds],
  };
}

/** 计划记录的**持有核** —— 纯逻辑(内存 Map + 可注入的窄持久化接口),与 `GrantStore` 同姿势。 */
export class UnattendedPlanStore {
  private plans = new Map<string, UnattendedPlanRecord>();
  private readonly persist?: UnattendedPlanStorePersist;

  constructor(deps: { persist?: UnattendedPlanStorePersist } = {}) {
    this.persist = deps.persist;
    const loaded = this.persist?.load();
    if (loaded) for (const p of loaded) this.plans.set(p.planId, p);
  }

  /** 写入 / 覆盖一份计划记录(重试是同一 planId 的覆盖)。落盘走可注入的 persist。 */
  put(record: UnattendedPlanRecord): void {
    // ★ 先落盘、成功后才发布内存(MC-017):`save` 抛错时内存一字未动 —— 不会留下「内存里
    //    有、磁盘上没有」的记录(重启后又消失)。候选表是**副本**,`commit` 里只 save 成功才换。
    const next = new Map(this.plans);
    next.set(record.planId, {
      ...record,
      operations: record.operations.map((o) => ({ ...o })),
      completedOperationIds: [...record.completedOperationIds],
    });
    this.commit(next);
  }

  /** 读一份计划记录(不存在为 null)。 */
  get(planId: string): UnattendedPlanRecord | null {
    const p = this.plans.get(planId);
    return p ? cloneRecord(p) : null;
  }

  /** 列出全部计划记录(**含**已完成 / 已放弃)—— 只读枚举口,与 `GrantStore.listAll` 同取向。 */
  listAll(): UnattendedPlanRecord[] {
    return [...this.plans.values()].map(cloneRecord);
  }

  /** 删除一份计划记录(放弃后清理;幂等)。返回是否真的删掉了一条。 */
  remove(planId: string): boolean {
    // 先落盘、成功后才删内存(MC-017):落盘失败时它**仍在** —— 与磁盘一致,重启后不会
    // 「删掉的记录又回来」(台账 E1 红例:`AFTER_FAILED_REMOVE_MEMORY false DISK 1`)。
    if (!this.plans.has(planId)) return false;
    const next = new Map(this.plans);
    next.delete(planId);
    this.commit(next);
    return true;
  }

  /**
   * **唯一的持久提交点**(MC-017)—— 先 `save` 候选全量,成功后才发布成活动表。
   * `save` 抛错时 `this.plans` 一字未动:内存与磁盘同版本。与 `GrantStore.commit` 同一条纪律。
   */
  private commit(next: Map<string, UnattendedPlanRecord>): void {
    this.persist?.save([...next.values()]);
    this.plans = next;
  }
}

/** 当前生效的 {@link UnattendedPlanStore}。**默认是进程内内存版**(未装配);生产启动时换成落盘版。 */
let activeStore: UnattendedPlanStore = new UnattendedPlanStore();

/** 单例读取口。执行端 / 签发端统一从这里取,**绝不在别处各 new 一份**。 */
export function getUnattendedPlanStore(): UnattendedPlanStore {
  return activeStore;
}

/**
 * 装配口 / 测试复位口。传 `null` 复位回一个**全新**的内存版;传实例则令它成为当前单例。
 * 生产不直接调它 —— 走 {@link assembleUnattendedPlanStore}。
 */
export function setUnattendedPlanStore(store: UnattendedPlanStore | null): void {
  activeStore = store ?? new UnattendedPlanStore();
}

/**
 * **纯装配函数**:给定数据根,装配一份落盘版的 {@link UnattendedPlanStore} 并令它成为单例。
 * 落点由 {@link unattendedPlanStorePath} 决定,与 `assembleGrantStore` 同姿势 —— `main/index.ts`
 * 那层只传真实的 `dataRoot()`;无头 smoke 传临时目录即可,绝不碰数据根。
 */
export function assembleUnattendedPlanStore(dataRoot: string): UnattendedPlanStore {
  const store = new UnattendedPlanStore({
    persist: fileUnattendedPlanPersist(atomicFileBlob(unattendedPlanStorePath(dataRoot))),
  });
  setUnattendedPlanStore(store);
  return store;
}
