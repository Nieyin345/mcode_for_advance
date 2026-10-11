import type { ProviderHealthCheckResult } from "@contracts/ipc";
import type { AgentProvider, ProviderHealthCheckContext } from "@contracts/provider";

export interface ProviderHealthProbeOptions {
  /** Skip a completed cached result. An already-running probe is still shared. */
  force?: boolean;
}

interface CachedHealth {
  expiresAt: number;
  result: ProviderHealthCheckResult;
}

/**
 * 【MC-076】一次在途探测。底层 `healthCheck` 现在拿到受信 `ProviderHealthCheckContext`
 * (`signal` / `deadline` / `probeId`),超时到点会 **abort** 它 —— 而不是像从前那样
 * 只让外层 `Promise.race` 停止等待、把底层 SDK 查询/子进程/会话永远挂在后台。
 *
 * 生命周期:
 *   - `checking`:底层还没到点。此时同引擎的并发请求**合并**到这一条(`promise`)。
 *   - `cancelling`:超时已 abort,但底层资源**还没归还**(underlying 未 settle)。
 *     此时**不允许**起下一份同引擎探测 —— 这就是「全局同引擎并发预算」。
 *     待 underlying settle(引擎确认释放),这条记录清除,之后才允许新探测。
 */
interface ActiveProbe {
  readonly probeId: string;
  promise: Promise<ProviderHealthCheckResult>;
  readonly controller: AbortController;
  phase: "checking" | "cancelling";
}

/**
 * Build one provider-health probe shared by every transport. Besides keeping
 * desktop IPC and mobile RPC behavior identical, this coalesces concurrent
 * requests and briefly caches completed probes so fast provider switching does
 * not repeatedly spawn the same CLI.
 *
 * 【MC-076】同时它也是**唯一的** `ProviderProbeService`(不要再开第二套):
 *   - 合并同引擎在途探测(并发调用共享一条);
 *   - 全局**同引擎在途预算 = 1**:超时进入 `cancelling` 后,底层资源未释放前
 *     不接受新的同引擎探测(强制 force 也只会拿到 `cancelling`,不会另起一份);
 *   - 超时**真的 abort** 底层(`ProviderHealthCheckContext.signal`),等它 settle
 *     确认释放后才允许下一份。
 */
export function createProviderHealthProbe(
  getProvider: (providerId: string) => AgentProvider | undefined,
  options: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {},
) {
  const ttlMs = options.ttlMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedHealth>();
  const active = new Map<string, ActiveProbe>();
  let probeSeq = 0;

  return async function probeProviderHealth(
    providerId: string,
    probeOptions: ProviderHealthProbeOptions = {},
  ): Promise<ProviderHealthCheckResult> {
    // ── 在途合并 / 预算闸门 ───────────────────────────────────────────────
    const running = active.get(providerId);
    if (running) {
      // `checking`:同引擎并发请求共享同一条探测。
      if (running.phase === "checking") return running.promise;
      // `cancelling`:超时已 abort、但底层资源**还没归还**。
      // 绝不再起一份 —— 那正是 MC-076 累积未归还任务的根。返回一个诚实的
      // 「正在取消」状态;底层一 settle,这条记录就清除,届时可以重新探测。
      return {
        providerId, ok: false, checkedAt: now(), code: "cancelling",
        error: `上一次健康检查正在取消(释放底层资源),请稍后重试(probeId=${running.probeId})`,
      };
    }

    // ── 缓存(只在没有在途探测且非 force 时命中)──────────────────────────
    const cached = cache.get(providerId);
    if (!probeOptions.force && cached && cached.expiresAt > now()) return cached.result;

    const provider = getProvider(providerId);
    if (!provider) return {
      providerId, ok: false, code: "not_registered", checkedAt: now(),
      error: `未注册的引擎：${providerId}`,
    };
    if (!provider.healthCheck) return {
      providerId, ok: false, code: "unsupported", checkedAt: now(),
      error: "该引擎未提供健康检查",
    };

    const controller = new AbortController();
    const probeId = `probe-${providerId}-${++probeSeq}`;
    const deadline = now() + timeoutMs;
    const probeCtx: ProviderHealthCheckContext = {
      signal: controller.signal,
      deadline,
      probeId,
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const attempt: ActiveProbe = {
      probeId,
      controller,
      phase: "checking",
      // 占位,下面立刻替换为真实 promise。
      promise: undefined as unknown as Promise<ProviderHealthCheckResult>,
    };

    // 底层业务:先真正把受信上下文交给引擎;引擎据此在 abort 时释放资源。
    const underlying: Promise<{ ok: boolean; version?: string; error?: string }> =
      (async () => provider.healthCheck!(probeCtx))();

    // 底层 settle(成功或失败)即视为「资源已归还」。此刻若有新探测等着,可以开工。
    const underlyingSettled = underlying.then(
      () => { /* settled */ },
      () => { /* settled */ },
    );

    /** 底层资源确认归还后,清除在途记录(仅当仍是这一条)。 */
    const clearWhenReleased = (): void => {
      void underlyingSettled.then(() => {
        if (active.get(providerId) === attempt && attempt.phase === "cancelling") {
          active.delete(providerId);
        }
      });
    };

    const normalized: Promise<ProviderHealthCheckResult> = underlying.then(
      (result) => ({
        ...result, providerId, checkedAt: now(),
        code: result.ok ? "ok" : "unavailable",
      }),
      (error) => ({
        providerId, ok: false, checkedAt: now(), code: "probe_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    const promise = (async (): Promise<ProviderHealthCheckResult> => {
      try {
        // 竞争:底层正常结束,或到点触发 abort。
        const result = await Promise.race([
          normalized,
          new Promise<ProviderHealthCheckResult>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              // ★ 关键:超时**真的** abort 底层的受信信号 —— 引擎据此释放
              //   SDK 查询流 / 子进程 / 会话,而不是只停掉这一层的等待。
              controller.abort();
              resolve({
                providerId, ok: false, checkedAt: now(), code: "timeout",
                error: `健康检查超时（${timeoutMs}ms）`,
              });
            }, timeoutMs);
          }),
        ]);
        if (timedOut) {
          // 超时:这条请求已经拿到结果,但底层资源**可能还在释放**。阶段切到
          //   `cancelling`,等 underlyingSettled 确认释放后才清除记录、放行下一份。
          attempt.phase = "cancelling";
          if (timer) { clearTimeout(timer); timer = undefined; }
          clearWhenReleased();
          return result;
        }
        // 未超时:底层已在预算内归还资源,可以直接清除记录并缓存结果。
        if (timer) { clearTimeout(timer); timer = undefined; }
        if (active.get(providerId) === attempt) active.delete(providerId);
        cache.set(providerId, { result, expiresAt: now() + ttlMs });
        return result;
      } catch (error) {
        // 理论上 normalized 不再会拒(它把异常也收敛成结果),这里只是兜底。
        if (timer) { clearTimeout(timer); timer = undefined; }
        attempt.phase = "cancelling";
        clearWhenReleased();
        return {
          providerId, ok: false, checkedAt: now(), code: "unknown",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();

    attempt.promise = promise;
    active.set(providerId, attempt);

    return promise;
  };
}
