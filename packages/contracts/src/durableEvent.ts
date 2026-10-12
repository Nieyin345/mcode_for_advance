/**
 * **DurableEventEnvelope(ARC-015④)** —— 「事件先落一份**可查的封装**,再投递」这条纪律的
 * **类型落点**。
 *
 * ## 它在补哪个洞
 *
 * 文件事件 / 触发载荷今天全是**内存**的(`automationRunner` 的 `PendingFire`、`TriggerPayload`)。
 * 进程一挂,「本来该投递的那批事件」跟着没影:既没有一个可查的「它来过」的封装,也没有一条
 * 一告我们就知道「投递到哪一步了、失败了几次、上一次为什么没成」的记录。ARC-007 要的
 * 「投递语义可观测 / 可查询」与 ARC-005 的「领取→执行→结算」在这里缺一个**共同的形状**。
 *
 * ## 它接的是 ARC-007 / ARC-005 的哪两处
 *
 *  - **ARC-007**(钩子/长时任务的投递语义):一个事件「被接收」与「被投递」是**两件事**。
 *    这份封装让「接收」这件事先落成一条可查的记录,投递是其后的一个**状态迁移**。
 *  - **ARC-005**(可恢复操作账本 `begin` / `settle`):本文件把那个账本的**形状**搬过来 ——
 *    `enqueueEventEnvelope` 对应「领取/登记」,`settleEventEnvelope` 对应「结算」,状态集合
 *    照搬 `enqueued`(在途)/ `delivered`(终态成功)/ `failed`(终态失败)/ `uncertain`
 *    (终态**不可确认**,绝不自动重投 —— 与 ARC-005 对不可幂等外部动作的纪律同一条)。
 *
 * ## 硬约束:**只记引用与摘要,绝不拷 payload**
 *
 * 一份事件载荷可能很大(几百个路径、一长串条目)。封装里**只放** `payloadDigest`
 * (内容指纹),不放正文 —— 否则「先落一份封装」就退化成「把大 payload 也拷一份」,内存与
 * 落盘两头都涨。`digestOfPayload` 是这条约束的可测落点:两份**键序不同但内容相同**的
 * 载荷得到**同一个**摘要,内容不同则不同。
 *
 * ## 本切片是**纯契约**
 *
 * 只定义形状 + 一处纯状态机,**不碰 DB、不接 `SettingRepo`**。真正的落盘(把它写进哪张表 /
 * 哪个 settings 键)是后续切片的事 —— 先把类型落点与判据钉死,免得后面各写一份。
 *
 * ⚠️ 摘要用**自足的 FNV-1a**(不是 crypto):本模块与 `@contracts/hook` 一样会被打进
 * **渲染端** bundle(见 `HooksPanel`),那里没有 `node:crypto`。它是一枚**内容指纹**
 * (稳定、跨进程一致、对键序不敏感),不是密码学摘要 —— 文档里就这么说,不假装更强。
 */

/** 一条事件封装在投递上的状态。`ENQUEUED` 是唯一**非终态**;其余三个都是终态。 */
export const DURABLE_EVENT_STATUSES = ["ENQUEUED", "DELIVERED", "FAILED", "UNCERTAIN"] as const;
export type DurableEventStatus = (typeof DURABLE_EVENT_STATUSES)[number];

/**
 * 一条事件封装的**引用本体**。**没有载荷正文字段** —— 只有它的指纹 `payloadDigest`。
 *
 * 字段刻意与 ARC-005 账本及 `triggerClaim` 取值一致,好让「接收→投递→结算」这条线在
 * 三处长得一样:
 *  - `eventId` —— 这一次事件的唯一 id(幂等键的原料);
 *  - `sceneId?` —— 归属场景(ARC-013 的 sceneId);没有就省略,不塞空串;
 *  - `triggerKey` —— 哪条触发器收到的(`workflowId:nodeId`,同 `automationTriggerKey`);
 *  - `kind` —— 事件种类(钩子事件名 / `"file"` / `"schedule"` 这类),给查询时按种类筛;
 *  - `payloadDigest` —— 载荷**内容指纹**(见 {@link digestOfPayload});正文不在这里;
 *  - `enqueuedAt` —— 封装的时刻(ms,墙钟);
 *  - `attempt` —— **已经投递过几次**(0 = 还没投);重投在结算里 +1;
 *  - `lastError?` —— 最近一次失败/不确定的原因(**刻意保留**,好让「为什么没投成」可查)。
 */
export interface DurableEventEnvelope {
  eventId: string;
  sceneId?: string;
  triggerKey: string;
  kind: string;
  payloadDigest: string;
  enqueuedAt: number;
  attempt: number;
  lastError?: string;
}

/** 封装 + 它的投递状态(与 ARC-005 把 `status` 放在 record 上同形)。 */
export interface DurableEventRecord {
  envelope: DurableEventEnvelope;
  status: DurableEventStatus;
  /** 最后一次状态迁移的时刻(ms)。 */
  updatedAt: number;
}

/**
 * 一次结算的结论。**三个分支,各自对应一种**确定的事实:
 *  - `delivered` —— 投递成功,**终态**;
 *  - `failed` —— 投递失败。**可能还能重投**:`attempt + 1 >= retryBudget` 时才落终态 `FAILED`,
 *    否则留在 `ENQUEUED`(待重投)。`retryBudget` 省略 = 1(一次就死,不无限重试);
 *  - `uncertain` —— 外部动作**可能已经发生、但结果不可确认**(ARC-005 的 UNCERTAIN 纪律)。
 *    落**终态**,**绝不自动重投** —— 盲发第二次就是拿重复副作用换一个漂亮的"保证"。
 */
export type EnvelopeSettlement =
  | { outcome: "delivered" }
  | { outcome: "failed"; error: string; retryBudget?: number }
  | { outcome: "uncertain"; error?: string };

/** 稳定序列化:对象按 key 排序,数组保持顺序;`undefined` 与缺失同义(→ `null`)。 */
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

/** FNV-1a(32 位)十六进制。自足、无 `node:crypto` / `TextEncoder` 依赖(契约的 `lib`
 *  只到 ES2022,没有 DOM)。按 UTF-16 码元逐位混入;同一字符串在任何进程里结果一致。 */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // 高位字节、低位字节各混一次,让 BMP 之外的字符也不只吃低位。
    h ^= code & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (code >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 一份载荷的**内容指纹**。用于 `payloadDigest` —— 让「这次封装的是哪份载荷」可判等,而
 * 不必把载荷正文也拷进封装里。
 *
 * 判据:先**规范化序列化**(键序无关),再 FNV-1a,前缀 `fnv1a:`,定长 8 位十六进制。
 * **不是密码学摘要** —— 它只是一枚指纹;要防碰撞的话该用 sha256,而 contracts 不能引
 * `node:crypto`(见文件头)。
 */
export function digestOfPayload(payload: unknown): string {
  return `fnv1a:${fnv1aHex(canonicalize(payload))}`;
}

/**
 * **接收**一个事件:算出载荷指纹、登记一条 `ENQUEUED` 的封装。**投递之前**调它 ——
 * 这就是「事件先落一份可查的封装,再投递」里的前半句。
 *
 * `attempt` 从 **0** 起(还没投过),`enqueuedAt` = 传进来的 `at`。`sceneId` 缺省就**不给键**
 * (同 `TriggerPayload` 里 `overflowDropped`/`changes` 的口径:别多一个恒空的可选字段)。
 */
export function enqueueEventEnvelope(input: {
  eventId: string;
  triggerKey: string;
  kind: string;
  payload: unknown;
  sceneId?: string;
  at: number;
}): DurableEventRecord {
  const envelope: DurableEventEnvelope = {
    eventId: input.eventId,
    ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    triggerKey: input.triggerKey,
    kind: input.kind,
    payloadDigest: digestOfPayload(input.payload),
    enqueuedAt: input.at,
    attempt: 0,
  };
  return { envelope, status: "ENQUEUED", updatedAt: input.at };
}

/** 这条封装是否还在**待投递**(非终态)。 */
export function isPendingEnvelope(record: DurableEventRecord): boolean {
  return record.status === "ENQUEUED";
}

/** 这条封装是否已是**终态**(投递成功 / 失败 / 不可确认)。终态**不再迁移**。 */
export function envelopeTerminal(record: DurableEventRecord): boolean {
  return record.status !== "ENQUEUED";
}

/**
 * **结算**一条封装 —— 投递之后调它,与 ARC-005 的 `settle` 同形(纯函数:返回**新的**
 * record,不改入参那一份)。
 *
 * 三条纪律,各自都由判据钉死:
 *  1. **终态不可复活**:已 `DELIVERED` / `FAILED` / `UNCERTAIN` 的再结算**原样返回**;
 *  2. **失败可带预算重投**:`attempt + 1 >= retryBudget` 才落 `FAILED`,否则留 `ENQUEUED`;
 *  3. **UNCERTAIN 绝不自动重投**:落终态,`attempt` 记一次,原因进 `lastError`。
 */
export function settleEventEnvelope(
  record: DurableEventRecord,
  settlement: EnvelopeSettlement,
  at: number,
): DurableEventRecord {
  // 纪律 1:终态不再迁移(不复活、不覆盖)。这一条挡住"重投把已成功的又发一遍"。
  if (envelopeTerminal(record)) return record;
  const env = record.envelope;
  if (settlement.outcome === "delivered") {
    // 投成了:清掉上次的失败原因(免得界面拿着旧账说这次也没成),attempt 记这一次。
    const { lastError: _priorError, ...rest } = env;
    return { envelope: { ...rest, attempt: env.attempt + 1 }, status: "DELIVERED", updatedAt: at };
  }
  if (settlement.outcome === "uncertain") {
    // 纪律 3:UNCERTAIN 是终态,`attempt` 记一次,**不重投**。
    return {
      envelope: {
        ...env,
        attempt: env.attempt + 1,
        lastError: settlement.error ?? env.lastError ?? "投递结果不确定",
      },
      status: "UNCERTAIN",
      updatedAt: at,
    };
  }
  // failed:纪律 2 —— 用掉一次额度,到顶才落终态,否则留着待重投。
  const attempt = env.attempt + 1;
  const budget = settlement.retryBudget ?? 1;
  const exhausted = attempt >= budget;
  return {
    envelope: { ...env, attempt, lastError: settlement.error },
    status: exhausted ? "FAILED" : "ENQUEUED",
    updatedAt: at,
  };
}
