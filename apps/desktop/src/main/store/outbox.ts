/**
 * 【ARC-005 切片⑤】提交后事件的**同进程可重试投递** —— 一条有界、可重试、
 * **失败如实登记**(绝不静默丢、绝不假装成功)的投递路径。
 *
 * ## 它补的洞(接 `runStore` 的 `onRunCommitted`)
 *
 * `runStore.saveRun` 已经做到「运行 durable 之后才发『运行已提交』成功信号」(切片②)。
 * 但那个信号的**扇出口**从前的写法是:逐个 `try { listener(run) } catch { log.warn }`
 * —— 一个抛错的订阅者,它那条**领域事件就被这一句 warn 吞掉了**:调用方以为"发了",
 * 事件其实没到;而**没有任何地方记得"它没到"**。这正是 ARC-005 判据要消掉的那种态:
 * 「投递成功 / 投递失败」在旧写法里是**同一个**可观察结果(一条 warn 日志)。
 *
 * ## 判据(本切片钉死的三条)
 *
 *  1. **有界重试**:一条事件对每个订阅者最多投 `retryBudget` 轮(轮 = 一次对全部
 *     "还没投成的订阅者"的扇出)。投成的不再重投(绝不把已成功的又发一遍 —— 与
 *     `@contracts/durableEvent` 的 `settleEventEnvelope` 终态纪律同一条)。
 *  2. **有界队列**:待投事件攒在一条有上限的队列里;超过 `capacity` 时丢**最旧**的一条,
 *     并把丢掉的**条数如实计数**(`overflowDropped`)—— 有界本身要可查,不是静默截断。
 *  3. **失败如实登记**:重试用尽仍投不成的订阅者,**逐条**落进 `deadLetters`(事件 id +
 *     订阅者 id + 试了几轮 + 最后那句错),`stats().failed` 计数,并 `log.error`。它既
 *     **不算**投成(`delivered` 不增),也**不**从账上消失。
 *
 * ## 为什么复用 `@contracts/durableEvent` 的状态机
 *
 * 事件身份(稳定指纹)、投递轮次、终态纪律(投成/用尽预算落终态/终态不复活的形状)在
 * ARC-015④ 已经有一份纯契约(`enqueueEventEnvelope` / `settleEventEnvelope`)。投递账本
 * 再抄一遍那些判据,迟早分家 —— 所以本模块的每个事件**就是**一份 `DurableEventRecord`,
 * 重投走它的 `settle`。**本切片不落盘**(跨重启的持久 outbox 是更大的重构,台账明确
 * 划出范围外):这里只保证**同进程内**的有界重投与诚实的失败登记。
 *
 * ## 边界
 *
 *  - 只对**投递**负责,不判断"该不该发" —— 门(candidate:只有 durable 之后才 enqueue)
 *    在调用方(`runStore` 的 `saveRun`)。同 `settingSync` 的取舍:投递失败**不逆转**
 *    已确认的提交。
 *  - 重投是**同步、立即**的:订阅者是同进程内的函数,"暂不可达"没有时间维度。将来若
 *    要留到"某个时刻再投",那是跨时间的持久 outbox,另行按 ARC-009 建。
 */
import { log } from "@main/lib/logger.js";
import {
  enqueueEventEnvelope,
  settleEventEnvelope,
  isPendingEnvelope,
  type DurableEventRecord,
} from "@contracts/durableEvent";

/** 一个投递目标(订阅者):稳定 `id`(dead-letter / 日志按它点名)+ 投一次的函数。 */
export interface OutboxTarget<T> {
  /** 订阅者的稳定身份(重投时按它跳过已投成的,**绝不**把已成功的再发一遍)。 */
  id: string;
  /** 投一次;抛错 = 这一轮对它没投成(会被有界重试)。 */
  deliver(event: T): void;
}

/** 一条**重试用尽仍没投成**的投递 —— 如实登记,不静默丢。 */
export interface OutboxFailure {
  eventId: string;
  targetId: string;
  /** 一共试了几轮(轮 = 对全部未投成订阅者的一次扇出)。 */
  attempts: number;
  lastError: string;
}

/** 投递账本的可查投影。 */
export interface OutboxStats {
  /** 此刻队列里还没投完(以及正在投)的条数。 */
  pending: number;
  /** 累计投成的(事件 × 订阅者)次数。 */
  delivered: number;
  /** 累计重试用尽、如实登记为失败的(事件 × 订阅者)次数。 */
  failed: number;
  /** 队列满时被丢弃的**事件**条数(有界要可查,不是静默截断)。 */
  overflowDropped: number;
}

interface InFlight<T> {
  record: DurableEventRecord;
  event: T;
  /** 本轮之前**已经投成**的订阅者 id —— 重投只补投没成的。 */
  deliveredTargets: Set<string>;
  /** Previously failed targets may disappear from a dynamic targets() list.
   * Unsubscribing is not delivery success: keep their failure attributable
   * until a later retry actually reaches them or the budget is exhausted. */
  unresolvedTargets: Set<string>;
}

/**
 * 有界、可重试、失败如实登记的同进程投递账本。
 *
 * 泛型 `T` 是被投递的事件本体(如 `RunCommitted`)。`targets` 是**每次投递时现取**的
 * 目标列表(订阅者会动态增删,不能构造时定死),`identify` 把事件折成稳定身份
 * (落成 `@contracts/durableEvent` 的封装)。
 */
export class RetryableOutbox<T> {
  private readonly queue: InFlight<T>[] = [];
  private deliveredTotal = 0;
  private failedTotal = 0;
  private overflowDropped = 0;
  private readonly deadLetterLog: OutboxFailure[] = [];
  /** 防重入:投递过程中若订阅者又 `enqueue`(如一次提交触发下一次提交),嵌套的
   *  `drain` 直接返回,交给外层那个 `while` 继续把新压入的条目投完。 */
  private draining = false;
  /** The head is shifted out of queue *before* delivery; count it until
   * callback completion so stats.pending remains truthful during callbacks. */
  private active = 0;

  constructor(
    private readonly opts: {
      /** 队列上限。攒的**事件**条数达到它时,丢最旧的一条并计数。 */
      capacity: number;
      /** 每个订阅者的投递轮数上限(含第一轮)。省略按 3。 */
      retryBudget: number;
      /** 现取当前投递目标(动态订阅者)。 */
      targets: () => OutboxTarget<T>[];
      /** 把事件折成稳定身份(事件 id + 触发器键 + 种类)。 */
      identify: (event: T) => { eventId: string; triggerKey: string; kind: string };
      /** 可注入时钟(测试用);缺省 `Date.now`。 */
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * 登记一条事件并**立即投递**。队列满时丢最旧的一条(计 `overflowDropped`,打一条
   * warn —— 有界的溢出要看得见,不是静默丢)。
   */
  enqueue(event: T): void {
    const at = this.now();
    const id = this.opts.identify(event);
    const record = enqueueEventEnvelope({
      eventId: id.eventId,
      triggerKey: id.triggerKey,
      kind: id.kind,
      payload: event,
      at,
    });
    if (this.queue.length >= this.opts.capacity) {
      const dropped = this.queue.shift();
      this.overflowDropped += 1;
      log.warn(
        `outbox: 队列已满(capacity=${this.opts.capacity}),丢弃最旧的一条未投事件 ` +
          `${dropped?.record.envelope.eventId ?? ""}(累计丢弃 ${this.overflowDropped})`,
      );
    }
    this.queue.push({ record, event, deliveredTargets: new Set(), unresolvedTargets: new Set() });
    this.drain();
  }

  /**
   * 把队列里剩下的事件都投完(含重投)。防重入:已在投递中就返回,由外层继续。
   *
   * ⚠️ **先把队首取出来再投**,不留它在队列里:订阅者的一轮投递里可能又 `enqueue`
   * (一次提交触发下一次提交),而那一下若撞上 `capacity` 会**丢最旧的一条** —— 若队首
   * 还在队列中,被丢掉的就会是**正在投的这一条**,它却已经投出去了。取出来投就没有这个窗口。
   */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const head = this.queue.shift()!;
        this.active += 1;
        try {
          this.deliverHead(head);
        } finally {
          this.active -= 1;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 投递队首这一条:对每个**还没投成**的订阅者扇出一轮。
   *
   *  - 一轮全成 → 结算 `delivered`(终态),完;
   *  - 有订阅者抛错 → 结算 `failed`(消耗一轮预算):还在预算内就**立即再扇一轮**
   *    (只补投没成的那些),预算用尽则落终态 `FAILED` —— 逐条登记进 `deadLetters`
   *    并计数,**如实记为失败**。
   */
  private deliverHead(item: InFlight<T>): void {
    for (;;) {
      const failures = this.runRound(item);
      if (failures.length === 0) {
        // 一轮下来没有任何订阅者抛错 → 这一条投成了。
        item.record = settleEventEnvelope(item.record, { outcome: "delivered" }, this.now());
        return;
      }
      // 用掉一轮预算(形状与纪律来自 @contracts/durableEvent)。
      item.record = settleEventEnvelope(
        item.record,
        { outcome: "failed", error: failures[0]!.error.message, retryBudget: this.opts.retryBudget },
        this.now(),
      );
      if (isPendingEnvelope(item.record)) continue; // 还在预算内 → 立即补投一轮
      // 预算用尽:逐条如实登记(不静默丢、不算成投成)。
      for (const f of failures) {
        this.failedTotal += 1;
        this.deadLetterLog.push({
          eventId: item.record.envelope.eventId,
          targetId: f.targetId,
          attempts: item.record.envelope.attempt,
          lastError: f.error.message,
        });
        log.error(
          `outbox: 事件 ${item.record.envelope.eventId} 投给订阅者 ${f.targetId} 重试 ` +
            `${item.record.envelope.attempt} 轮仍失败,如实登记为失败(不静默丢、不假装成功)`,
        );
      }
      return;
    }
  }

  /** 对全部**还没投成**的订阅者扇出一轮;返回这一轮抛错的那些(空 = 全成)。 */
  private runRound(item: InFlight<T>): Array<{ targetId: string; error: Error }> {
    const failures: Array<{ targetId: string; error: Error }> = [];
    let targets: OutboxTarget<T>[];
    try {
      targets = this.opts.targets();
    } catch (err) {
      // The event has already left the queue. Letting this exception escape
      // silently loses the durable-after-commit notification forever.
      // Treat discovery as a failed target with the SAME retry/dead-letter
      // path as a failed deliver(), without fabricating a successful result.
      const reason = err instanceof Error ? err : new Error(String(err));
      failures.push({ targetId: "@target-discovery", error: reason });
      for (const targetId of item.unresolvedTargets) {
        failures.push({ targetId, error: reason });
      }
      return failures;
    }
    const available = new Set<string>();
    for (const target of targets) {
      available.add(target.id);
      if (item.deliveredTargets.has(target.id)) continue; // 已投成的不再重投
      try {
        target.deliver(item.event);
        item.unresolvedTargets.delete(target.id);
        item.deliveredTargets.add(target.id);
        this.deliveredTotal += 1;
      } catch (err) {
        item.unresolvedTargets.add(target.id);
        failures.push({ targetId: target.id, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
    // A target that failed the preceding round may unsubscribe before a
    // retry. That disappearance does NOT turn a failed delivery into DELIVERED.
    for (const targetId of item.unresolvedTargets) {
      if (!available.has(targetId)) {
        failures.push({ targetId, error: new Error("订阅者在上次投递失败后不可用，未确认送达") });
      }
    }
    return failures;
  }

  /** 投递账本的当前投影。 */
  stats(): OutboxStats {
    return {
      pending: this.queue.length + this.active,
      delivered: this.deliveredTotal,
      failed: this.failedTotal,
      overflowDropped: this.overflowDropped,
    };
  }

  /** 重试用尽仍没投成的那些(诊断 / 测试;只读快照)。 */
  deadLetters(): readonly OutboxFailure[] {
    return this.deadLetterLog.map((entry) => ({ ...entry }));
  }
}
