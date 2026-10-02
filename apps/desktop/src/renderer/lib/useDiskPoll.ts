import { useEffect, useRef } from "react";

/**
 * 盯着一个打开着的文件有没有在**磁盘上**被改(AI 的工具调用、外部程序、git 切分支)。
 *
 * 没有文件监听的 IPC,所以用轮询:窗口可见时每 `intervalMs` 一次,另外窗口重新获得
 * 焦点 / 页面重新可见时立刻一次。只把\"该看一眼了\"告诉调用方,读不读、怎么比、
 * 发现变化怎么办都由调用方决定(两种编辑器的\"基准\"不一样)。
 */
export function useDiskPoll(filePath: string | null, onTick: (filePath: string) => void, intervalMs = 2000): void {
  const tickRef = useRef(onTick);
  useEffect(() => {
    tickRef.current = onTick;
  }, [onTick]);
  useEffect(() => {
    if (!filePath) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      tickRef.current(filePath);
    };
    const timer = setInterval(tick, intervalMs);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [filePath, intervalMs]);
}
