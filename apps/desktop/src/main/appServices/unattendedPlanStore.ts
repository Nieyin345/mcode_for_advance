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
 * ## 坏数据:读不崩(空 store),但**不许当写回基准**,也不许对消费端谎报「没有计划」(MC-029)
 *
 * 读到的文件坏掉(非 JSON / 非本信封 / 版本不符)→ 解析当**空 store**,不崩;数组里**逐条**
 * 校验,形状不对的那一条丢掉、其余保留。但「空」只是一半事实:**持有核记着 `corrupt`**
 * (`isArchiveCorrupt()`),`commit` 在 corrupt 时**拒绝任何写入**(原字节一个不动,绝不拿空表
 * 回写);消费端(list / resume / run / abandon,见 `unattendedTaskPlan.ts`)也据此**显式拒绝**
 * 而不是把「读不懂」说成「没有计划」。空串(零字节文件)与文件不存在同判 `absent` —— 没有可
 * 恢复的字节,不算损坏。唯一条纪律是**绝不**把读不懂的东西当成一份有效计划去执行。
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
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
  /**
   * **存档健康度**(MC-029)—— 让持有核能区分「本来是空的」与「读不懂」。
   *
   * 从前 `load()` 把两者都化成 `[]`,于是损坏的存档被当成"从未有过计划",下一次 `put`
   * 整表 `save` 就把原坏文件**覆盖**了(截断前的计划正文、完成步骤、授权指针全不可恢复)。
   * 有了这个口,持有核在 `corrupt` 时**拒绝写入**,原字节一个不动。
   *
   * 可选:自定义持久化(测试桩)不实现它时按 `absent` 处理(不阻塞写入)。
   */
  health?(): UnattendedPlanStoreHealth;
  /**
   * 【MC-029 剩余项】比 {@link health} 更细的**四态**诊断:`unreadable`(文件在但读不了,
   * 权限 / IO 错误)与 `corrupt`(内容读不懂)分开。`BlobIO.read()` 把读错误吞成 `null`,
   * 所以只能由**真文件**那层回答;测试桩不实现时退回 {@link health} 的判据。
   */
  healthDetail?(): "ok" | "corrupt" | "unreadable";
}

/** 存档健康度:不存在 / 有效 / 损坏(读不懂)。 */
export type UnattendedPlanStoreHealth = "absent" | "valid" | "corrupt";

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

/**
 * **存档健康度**(MC-029)—— 与 {@link parseUnattendedPlans} **同一套判据**,只是保留
 * "为什么空"这一层:文件不存在 / 空串 = `absent`(真空);文件在但读不懂 = `corrupt`。
 *
 * 分母必须与 `parseUnattendedPlans` 逐条对齐(`null` / 非 JSON / 非对象 / 版本不符 /
 * `plans` 不是数组 ⇒ corrupt),否则会出现「解析当空、健康说有效」的错配。
 * `plans` 数组里**个别**坏记录被丢不算 corrupt —— 那是有意的「丢一条只会收紧」。
 *
 * 空串与 MC-022 的 `classifyProjectLinks` 同判据(`!raw` → absent):零字节文件里没有
 * 任何可恢复的字节,当成「没有计划」;把用户亲手清空的文件说成「损坏」是误报。
 */
export function classifyUnattendedPlanArchive(json: string | null): UnattendedPlanStoreHealth {
  if (json == null || json === "") return "absent";
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return "corrupt";
  }
  if (!data || typeof data !== "object") return "corrupt";
  const env = data as Partial<UnattendedPlanEnvelope>;
  if (env.version !== UNATTENDED_PLAN_STORE_VERSION) return "corrupt";
  if (!Array.isArray(env.plans)) return "corrupt";
  return "valid";
}

/** 把一份 `BlobIO` 适配成 {@link UnattendedPlanStorePersist}(与 `fileGrantPersist` 同姿势)。 */
export function fileUnattendedPlanPersist(blob: BlobIO): UnattendedPlanStorePersist {
  return {
    load: () => parseUnattendedPlans(blob.read()),
    save: (plans) => blob.write(serializeUnattendedPlans(plans)),
    // 只如实**报告**健康度,不在这里 import logger —— 本模块的硬约定是「不 import electron」
    // (文件头 / 与 GrantStore 同姿势),而 `@main/lib/logger` 依赖 electron。上报由持有核的
    // `isArchiveCorrupt()` 与调用方(装配层)负责(硬规矩 3 的"显式报出来"落在那里)。
    health: () => classifyUnattendedPlanArchive(blob.read()),
    // 【MC-029 剩余项】`BlobIO.read()` 把「读不了」吞成 null,分不出来 —— 这里没有真文件的
    // 读错误信息,只能退回 `health` 的判据(测试桩走这条)。真文件层见
    // {@link fileUnattendedPlanPersistOnDisk}。
    healthDetail: () => {
      const h = classifyUnattendedPlanArchive(blob.read());
      return h === "corrupt" ? "corrupt" : "ok";
    },
  };
}

/**
 * 【MC-029 剩余项】真文件版的持久化 —— 与 {@link fileUnattendedPlanPersist} 同一份读写,
 * 只是**保留读错误**这一层:文件在但 `readFileSync` 抛(EACCES / EIO…)→ `unreadable`;
 * 不存在(`ENOENT`)→ `ok`(真空);内容坏 → `corrupt`。
 *
 * 为什么不在 `atomicFileBlob` 里改:`BlobIO` 的契约(读不了 → null)是 `grantStoreFile`
 * 与 hook 授权的**共用约定**,改它会影响两套已经闭合的存档;这层细分只对需要
 * `unreadable` 诊断的计划存档开放。
 */
export function fileUnattendedPlanPersistOnDisk(file: string): UnattendedPlanStorePersist {
  const blob = atomicFileBlob(file);
  return {
    ...fileUnattendedPlanPersist(blob),
    healthDetail: () => {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "ok"; // 真空
        return "unreadable"; // 权限 / IO:文件在,读不了
      }
      return classifyUnattendedPlanArchive(text) === "corrupt" ? "corrupt" : "ok";
    },
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
  /** 载入时存档是否读不懂(MC-029)—— 为真则**拒绝写入**,保住原字节。 */
  private readonly corrupt: boolean;

  constructor(deps: { persist?: UnattendedPlanStorePersist } = {}) {
    this.persist = deps.persist;
    // 载入前先问健康度(MC-029):损坏的存档读成空表这件事**要记住**,否则下一次 `put`
    // 会拿"空表"当基准整表回写,把原坏文件抹掉。既有的自定义持久化桩没实现 `health`
    // 时按 absent 处理(不阻塞写入,保持向后兼容)。
    this.corrupt = this.persist?.health?.() === "corrupt";
    const loaded = this.persist?.load();
    if (loaded) for (const p of loaded) this.plans.set(p.planId, p);
  }

  /** 存档此刻是否处于「读不懂、已拒绝写入」状态(供诊断 / 测试)。 */
  isArchiveCorrupt(): boolean {
    return this.corrupt;
  }

  /**
   * 【MC-029 剩余项】**结构化健康度** —— `ok` / `corrupt` / `unreadable`。
   *
   * `corrupt` 是**载入时**定下的(写侧闸与它同一枚标记);`unreadable` 是**此刻现问**
   * 持久层得到的(文件可能在运行期被改权限 —— 载入时读得动、之后读不动)。现问失败
   * (持久层没实现 `healthDetail`)时退回载入时的 `corrupt` 判定。
   */
  archiveHealth(): "ok" | "corrupt" | "unreadable" {
    if (this.corrupt) return "corrupt";
    try {
      return this.persist?.healthDetail?.() ?? "ok";
    } catch {
      return "unreadable";
    }
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
   *
   * **MC-029 加的那道闸**:载入时若存档是 `corrupt`(读不懂),`this.corrupt` 为真 ——
   * 此刻**拒绝任何写入**,把原字节原样保住,并抛出可诊断的错误。否则下一次 `put` 会拿
   * 「损坏读成空表」当基准整表回写,把截断前的计划正文 / 完成步骤 / 授权指针**永久抹掉**。
   */
  private commit(next: Map<string, UnattendedPlanRecord>): void {
    if (this.corrupt) {
      throw new Error(
        "unattended-plans.json 内容读不懂 —— 拒绝写入以免覆盖原存档(原字节已保留;请修复或删除该文件后重启)。",
      );
    }
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
    // 【MC-029 剩余项】真文件版:保留「文件在但读不了」这一层,`archiveHealth()` 才能
    // 把 `unreadable` 与 `corrupt` 分开。
    persist: fileUnattendedPlanPersistOnDisk(unattendedPlanStorePath(dataRoot)),
  });
  setUnattendedPlanStore(store);
  return store;
}
