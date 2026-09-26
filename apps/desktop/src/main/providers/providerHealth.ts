import type { ProviderHealthCheckResult } from "@contracts/ipc";
import type { AgentProvider } from "@contracts/provider";

export interface ProviderHealthProbeOptions {
  /** Skip a completed cached result. An already-running probe is still shared. */
  force?: boolean;
}

interface CachedHealth {
  expiresAt: number;
  result: ProviderHealthCheckResult;
}

/**
 * Build one provider-health probe shared by every transport. Besides keeping
 * desktop IPC and mobile RPC behavior identical, this coalesces concurrent
 * requests and briefly caches completed probes so fast provider switching does
 * not repeatedly spawn the same CLI.
 */
export function createProviderHealthProbe(
  getProvider: (providerId: string) => AgentProvider | undefined,
  options: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {},
) {
  const ttlMs = options.ttlMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedHealth>();
  const inFlight = new Map<string, Promise<ProviderHealthCheckResult>>();

  return async function probeProviderHealth(
    providerId: string,
    probeOptions: ProviderHealthProbeOptions = {},
  ): Promise<ProviderHealthCheckResult> {
    const running = inFlight.get(providerId);
    if (running) return running;

    const cached = cache.get(providerId);
    if (!probeOptions.force && cached && cached.expiresAt > now()) return cached.result;

    const pending = (async (): Promise<ProviderHealthCheckResult> => {
      const provider = getProvider(providerId);
      if (!provider) return {
        providerId, ok: false, code: "not_registered", checkedAt: now(),
        error: `未注册的引擎：${providerId}`,
      };
      if (!provider.healthCheck) return {
        providerId, ok: false, code: "unsupported", checkedAt: now(),
        error: "该引擎未提供健康检查",
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          provider.healthCheck(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("PROVIDER_HEALTH_TIMEOUT")), timeoutMs);
          }),
        ]);
        return {
          ...result, providerId, checkedAt: now(),
          code: result.ok ? "ok" : "unavailable",
        };
      } catch (error) {
        const timedOut = error instanceof Error && error.message === "PROVIDER_HEALTH_TIMEOUT";
        return {
          providerId, ok: false, checkedAt: now(),
          code: timedOut ? "timeout" : "probe_failed",
          error: timedOut ? `健康检查超时（${timeoutMs}ms）`
            : error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    inFlight.set(providerId, pending);
    try {
      const result = await pending;
      cache.set(providerId, { result, expiresAt: now() + ttlMs });
      return result;
    } finally {
      if (inFlight.get(providerId) === pending) inFlight.delete(providerId);
    }
  };
}
