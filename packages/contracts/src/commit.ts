/**
 * 一次持久化提交的结果(ARC-005 步②)。
 *
 * ## 为什么单拎出来
 *
 * 从前持久化边界只有两种事实 —— 「成功」或「抛错」 —— 调用方**分不清**这三件事:
 *
 *  1. 磁盘真的 durable 了(fsync 过、rename 过);
 *  2. **内存已应用、写盘没成** —— 这一次修改已经在 sql.js 的内存表里,进程还握着它,
 *     可换台机器 / 重启就没了;
 *  3. 什么都没发生(比如数据库尚未初始化)。
 *
 * 把 (2) 归进「成功」就是**假成功**:重启后那份修改不见了,而调用方以为落定了。
 * 归进「失败」又抹掉了「进程还握着它」这个真事实 —— 于是同一份状态在两处读出来
 * 对不上(见 MC-053 那次实测的 `oldCheckpointMutated`)。
 *
 * ## 用它的规矩
 *
 * **领域里的「操作成功」事件只许在 `DURABLE` 之后发** —— 绝不在 `APPLIED_NOT_DURABLE`
 * 之后。判据用 {@link isDurable} 一处收口,别在调用点各写一遍 `=== "DURABLE"`。
 */
export type CommitOutcome =
  /** fsync 成功:磁盘上真的是这一份。 */
  | "DURABLE"
  /** 内存已应用、写盘失败:进程还握着它,重启即失,不可对外报成功。 */
  | "APPLIED_NOT_DURABLE"
  /** 什么都没应用(如数据库尚未初始化),不留任何副作用。 */
  | "FAILED";

/** {@link CommitOutcome} 连同可选的字节数与失败原因。 */
export interface CommitResult {
  outcome: CommitOutcome;
  /** `DURABLE` 时写出的整库字节数;其余情况缺席。 */
  bytes?: number;
  /**
   * `DURABLE` 时这份落盘在**本进程内的序号**(从 1 起,每次成功 fsync 递增)。
   *
   * 它回答「这两次落盘哪个更新」以及「我手上这个版本是不是最后一次成功的落盘」——
   * 单靠 `bytes` 不行(两次写入可能恰好等长),单靠时间戳也不行(同一毫秒内两次落盘
   * 分不出先后)。**进程内单调**、不跨进程比较;`APPLIED_NOT_DURABLE` / `FAILED` 时缺席
   * (没落盘就没有版本)。
   *
   * ⚠️ 它与「内存修订号」是**两件事**:内存改十次才 fsync 一次,那十次内存修订共用一个
   * durableRevision —— 这正是要区分的「提交 vs 落盘」。
   */
  durableRevision?: number;
  /** 非 `DURABLE` 时的人类可读原因;`DURABLE` 时为 undefined。 */
  reason?: string;
}

/** 唯一的「可以发布成功领域事件」判据。 */
export function isDurable(result: CommitResult): boolean {
  return result.outcome === "DURABLE";
}

/**
 * 把一份 `CommitResult` 的版本号渲染成 `OperationResult.durableRevision` 要的字符串
 * (ARC-009)。**只有 `DURABLE` 且有版本号时**才给值 —— `APPLIED_NOT_DURABLE` 没有落盘,
 * 编一个版本号就是假成功。前缀 `sqlite:` 标明这是**整库落盘序列**,不是内存修订号。
 *
 * 判据收口在**这一处**:调用点(如操作账本 settle)别各写一遍 `durableRevision !== undefined`。
 */
export function durableRevisionOf(result: CommitResult): string | undefined {
  return isDurable(result) && result.durableRevision !== undefined
    ? `sqlite:${result.durableRevision}`
    : undefined;
}
