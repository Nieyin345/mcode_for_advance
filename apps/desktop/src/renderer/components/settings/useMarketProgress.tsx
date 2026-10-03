import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketProgress } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";

/** Correlate each operation; a late event cannot paint a new operation's UI. */
export function useMarketProgress() {
  const current = useRef<string | null>(null);
  const alive = useRef(true);
  const timerRef = useRef<number | null>(null);
  const [progress, setProgress] = useState<MarketProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    alive.current = true;
    const off = api.on?.marketProgress?.(message => {
      if (alive.current && message.payload.requestId === current.current) setProgress(message.payload);
    });
    return () => {
      alive.current = false; current.current = null; off?.();
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, []);
  const run = useCallback(async <T,>(operation: (requestId: string) => Promise<T>): Promise<T> => {
    if (current.current) throw new Error("已有市场操作正在进行 / A market operation is already running");
    const requestId = crypto.randomUUID(), started = Date.now();
    current.current = requestId;
    setElapsed(0);
    setProgress({ requestId, phase: "clone", message: "连接 / 读取目录 · Connecting / reading catalog", elapsedMs: 0 });
    const timer = window.setInterval(() => { if (alive.current) setElapsed(Date.now() - started); }, 1000);
    timerRef.current = timer;
    try { return await operation(requestId); }
    finally {
      window.clearInterval(timer);
      if (timerRef.current === timer) timerRef.current = null;
      if (current.current === requestId) {
        current.current = null;
        if (alive.current) setProgress(null);
      }
    }
  }, []);
  const status = progress ? (
    <div role="status" className="mb-2 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-[0.7857em] text-content">
      <div className="break-words whitespace-pre-wrap">{progress.message}</div>
      <div className="text-content-subtle">
        {Math.floor(elapsed / 1000)}s
        {progress.timeoutMs ? ` · 单次克隆上限 / Clone limit: ${Math.round(progress.timeoutMs / 60_000)} min` : ""}
      </div>
    </div>
  ) : null;
  return { run, status };
}
