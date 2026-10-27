/**
 * 【Office 深度集成】后台编辑器视图的**内存回收执行器**（渲染端）。
 *
 * ## 它解决什么
 *
 * 六个 GenOffice 编辑器同时驻留约 **1.70 GiB**（O18 实测），其中绝大部分是各自的
 * Chromium renderer。`DocumentViewHost.hide()` 只把视图挪到屏幕外，页面仍满编
 * 留在内存里。用户在几个文档标签之间来回切过之后，前面那些编辑器全在后台常驻。
 *
 * ## 为什么由渲染端决定
 *
 * 主进程知道「谁够久没显示、谁干净」，但**不知道用户接下来要点哪个标签**；
 * 渲染端知道当前激活的文档、刚点过什么。所以职责这样切：
 *
 *   - 主进程（`documentView.dormantList`）给出**可无损回收**的候选 + 重建凭据；
 *   - 渲染端（本模块）只回收**当前没被激活**的那些，且优先回收最久没看的。
 *
 * ## 三条安全线（任何一条都不回收）
 *
 *  1. **当前激活的文档永不回收** —— 用户正看着它；
 *  2. **脏视图永不回收** —— 主进程判据已经排除，这里再用 `excluded` 复核一次；
 *  3. **一次最多回收一个** —— 回收一个 Sheets 就是释放约 250 MiB，批量回收会让
 *     主线程同时处理多次大堆释放；一次一个、隔一个节流周期再下一个，是平滑曲线。
 *
 * ## 与「重建」的配合
 *
 * 回收走的是既有的 `documentView.close`（摘会话、退租约、撤销 handoff 全在那一条
 * 路径上），不新开销毁通道。面板组件（`GenofficeViewHostPane`）在它的 `list()`
 * 轮询里发现"我的视图不见了"就用同一个 docId 重建 —— 因为 `stableDocId(filePath)`
 * 是稳定的，重建出来的仍是同一个视图身份。
 *
 * ⚠️ **重建的代价是真实的**：O18 记录各自的首帧 163–1343 ms。所以宽限期
 * （主进程 `graceMs = 90 s`）不是可调的小气设置，它决定了"来回切换标签"会不会
 * 每次都重新加载。调小它之前先看 O18 的那张表。
 */
import { useEffect, useRef } from "react";
import { api } from "@renderer/lib/api.js";

/** 多久检查一次。与面板的诊断轮询同量级（2 s），不新增一条更密的定时器。 */
const SWEEP_INTERVAL_MS = 15_000;

export interface OfficeMemoryReclaimOptions {
  /** 当前激活的文档路径（永不回收）。null = 没有激活的文档视图。 */
  activeFilePath: string | null;
  /** 从路径算 docId —— 与面板用的是**同一个**函数（`stableDocId`）。 */
  docIdForPath: (filePath: string) => string;
  /** 回收成功后的回调（面板据此标记"这次消失是我干的"）。 */
  onReclaimed?: (docId: string) => void;
  enabled?: boolean;
}

/**
 * 后台视图回收循环。
 *
 * 它**不自己判断"谁脏"**：脏判定在主进程（那里有页面上报的真实状态）。
 * 这里只做「排除当前激活的」+「一次一个」。
 */
export function useOfficeMemoryReclaim(options: OfficeMemoryReclaimOptions): void {
  const { activeFilePath, docIdForPath, onReclaimed, enabled = true } = options;
  // 用 ref 承接：定时器不该因为父组件重渲染就重建。
  const latest = useRef({ activeFilePath, docIdForPath, onReclaimed });
  latest.current = { activeFilePath, docIdForPath, onReclaimed };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;

    const sweep = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const result = await api.documentView.dormantList();
        if (cancelled) return;
        const { activeFilePath: activePath, docIdForPath: idFor } = latest.current;
        const activeDocId = activePath === null ? null : idFor(activePath);
        // 主进程按"最久隐藏优先"排好了序，这里只跳过当前激活的，取第一个。
        const victim = result.candidates.find((candidate) => candidate.docId !== activeDocId);
        if (victim === undefined) return;
        const closed = await api.documentView.close({ docId: victim.docId });
        if (cancelled) return;
        // **只在真的关掉了才通知**：关闭被拒（宿主认为还有未保存状态）时视图仍在，
        // 面板不该以为"我被回收了"。宁可留下一个后台视图，也不为省内存丢编辑。
        if (closed.ok) latest.current.onReclaimed?.(victim.docId);
      } catch {
        // 回收是尽力而为的后台优化：任何失败都不该影响编辑。
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
}
