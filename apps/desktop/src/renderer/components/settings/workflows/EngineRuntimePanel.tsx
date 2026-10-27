/**
 * 【ARC-006 NR2】**第三方工作流引擎**面板（设置 → 工作流 → 第三方引擎）。
 *
 * ## 它在链路的哪一段
 *
 * 主进程那侧已经有了完整的起停状态机（`workflowEngines/runtimeSupervisor.ts`）与
 * 四条 IPC（`workflowEngine.start/stop/status/list`，见 `main/ipc/workflowEngine.ts`）。
 * 本组件是它们**唯一**的渲染端消费者：
 *   1. 读走 `useRpc`（硬规矩 7），写（启动 / 停止）在事件处理器里显式 `await`；
 *   2. running 时把 `editorUrl` 交给 `documentView.open`（与 GenOffice 视图同一套
 *      受控 `WebContentsView` 通道 —— URL 围栏同样只放行本机回环）；
 *   3. 停止 / 卸载时 `documentView.close`。
 *
 * ## docId 为什么是 `workflow-engine-<id>` 而不是散列
 *
 * 一个引擎只有一个编辑器视图，`engineId` 本身在契约里就限定了 `[a-z0-9-]`（见
 * `@contracts/ipc/workflowEngine`），拼出来天然稳定、可读、且不会撞上 GenOffice
 * 那边的 `genoffice-view-…` 前缀。稳定性是必要的：宿主对同 docId 的 open 是复用
 * 语义，重渲染不该重建视图。
 *
 * ## 未安装 / 失败：显式说原因 + 安装指引
 *
 * Node-RED 不在 Mcode 的主依赖树里（方案文档取舍 1）。没装时 `start` 会以
 * `{ ok:false, reason }` 回来（"没有配置启动命令"），面板把 `reason` 原样摆出来，
 * 再给一段"装到哪"的指引 —— 不是一块空白，也不是一个永远转圈的按钮。失败同理
 * （就绪超时、进程崩溃都有 `reason`）。
 *
 * ## 为什么开视图失败要单独一条错误，而不是混进 status
 *
 * `documentView.open` 失败（主窗口未就绪、URL 被围栏拒绝）与引擎 `failed` 是两件
 * 事：前者引擎还在跑、只是嵌不进来。混成一句话会让用户以为引擎挂了，去按「启动」
 * —— 而那个按钮对 running 是禁用的。两条错误分开报，各给各的重试。
 *
 * ## SSR 下的行为
 *
 * 效果不跑（`react-dom/server`），所以 smoke 里这个组件只验**静态结构与纯判据**
 * （`engineDocId` / `engineStateBadge` / `engineInstallHint`），发 RPC 的那一段靠
 * `tsc` 与手动验收 —— 与 `GenofficeViewHostPane` 的测试面同一取舍。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useApprovalArming } from "@renderer/hooks/useApprovalArming.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Badge, Button, ErrorNote, LoadingNote, Spinner } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconAlertTriangle, IconPlayerPlay, IconPlayerStop, IconRefresh } from "@renderer/lib/icons.js";
import type { DocViewRect, WorkflowEngineStatusView } from "@contracts/ipc";

/**
 * 引擎视图的 docId。**只从 engineId 推**，不掺时间戳/随机数 —— 同 docId 的 open
 * 在宿主侧是"复用/更新"，掺随机数每次重渲染都会新建一个视图，旧的那个没人关。
 */
export function engineDocId(engineId: string): string {
  return `workflow-engine-${engineId}`;
}

/** 状态 → 徽标。`starting` 是中性的（还在起，不是错）；`failed` 才是 danger。 */
export function engineStateBadge(state: WorkflowEngineStatusView["state"]): {
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  key: "settings.workflows.engine.stateStopped" | "settings.workflows.engine.stateStarting" | "settings.workflows.engine.stateRunning" | "settings.workflows.engine.stateFailed";
} {
  switch (state) {
    case "running":
      return { tone: "success", key: "settings.workflows.engine.stateRunning" };
    case "starting":
      return { tone: "accent", key: "settings.workflows.engine.stateStarting" };
    case "failed":
      return { tone: "danger", key: "settings.workflows.engine.stateFailed" };
    default:
      return { tone: "neutral", key: "settings.workflows.engine.stateStopped" };
  }
}

/**
 * 这个引擎现在能不能打开编辑器。判据**只有** `editorUrl !== null` —— 不看
 * `state === "running"`：URL 由主进程只在 running 且有端口时给出（`toStatusView`），
 * 两处各判一次 state 就是两个真相。
 */
export function canOpenEditor(status: WorkflowEngineStatusView): boolean {
  return status.editorUrl !== null;
}

/** W6: a confirmed *current-process* deploy on an untrusted Node-RED engine.
 * Persisted flows.json or a running process alone never satisfies this gate. */
export function shouldShowRestartDeployNotice(status: WorkflowEngineStatusView): boolean {
  return status.engineId === "node-red" && status.state === "running"
    && status.deploymentState === "deployed";
}

/** 【Q8】这次启动没被信任时提示用户「重启后不会自动跑」。
 *
 *  与 `shouldShowRestartDeployNotice` 的区别：那条说的是"这次部署只在本次进程有效"，
 *  这条说的是"引擎本身是在 safeMode 下起的"。两者可能同时成立，也可能只有其一 ——
 *  只看 `trustedAtStart === false`，不猜它为什么是 false（可能是还有未审查的图，
 *  也可能库里根本没有 node-red 图）。 */
export function shouldShowUntrustedNotice(status: WorkflowEngineStatusView): boolean {
  return status.engineId === "node-red" && status.state === "running"
    && status.trustedAtStart === false;
}

/* ── 同一个 docId 的多个宿主：谁开的、还有谁在用 ── */

/**
 * 【W15】宿主的视图按 docId 复用（`documentViewHost.open` 的注释：「同 docId 重复
 * open = 复用同一个 view」）。设置页的引擎页签与右侧面板的 NR 停靠位各挂一份
 * `EngineRow`，两份用同一个 `engineDocId(engineId)` —— 于是**一个原生视图、两个
 * 实例**。关闭是实例动作，而视图是共享资源：谁卸载谁 `close` 就会把另一个实例
 * 正在显示的编辑器一并销毁（症状是另一个实例下一次 `sync()` 收到
 * `文档视图不存在或已关闭`，而且它不会自己重新 open）。
 *
 * 判据抽在这里（不是藏在 effect 里）：effect 在 SSR 里不跑，埋在 effect 里的
 * 判断没法被无头断言碰到。`shouldCloseAfterRelease` 是纯函数，持有表由
 * `acquireView` / `releaseView` 维护；组件只用这几个入口。
 *
 * 规则：**只有释放后持有表为空，才关。** 没登记过的调用方永远得到 `false`
 * —— 它没有资格关别人的视图。
 */
export type DocViewHolders = ReadonlyMap<string, ReadonlySet<string>>;

/** 释放 `holderId` 之后该不该 `close(docId)`。纯判据，可独立断言。 */
export function shouldCloseAfterRelease(
  holders: DocViewHolders,
  docId: string,
  holderId: string,
): boolean {
  const set = holders.get(docId);
  if (set === undefined || !set.has(holderId)) return false; // 没登记过 = 不是我的
  return set.size === 1; // 只剩我 = 最后一个持有者
}

/** 进程内持有表。渲染端只有一棵树，模块单例就是两个宿主实例共享的那一份。 */
const viewHolders = new Map<string, Set<string>>();
let viewHolderSeq = 0;

/** 每个 `EngineRow` 实例一个稳定 id（同一实例的重复 acquire 是幂等的）。 */
export function nextViewHolderId(): string {
  viewHolderSeq += 1;
  return `engine-row-${viewHolderSeq}`;
}

/** 本实例现在持有这个 docId（视图已由它 open 或复用）。 */
export function acquireView(docId: string, holderId: string): void {
  let set = viewHolders.get(docId);
  if (set === undefined) {
    set = new Set();
    viewHolders.set(docId, set);
  }
  set.add(holderId);
}

/** 释放本实例的持有；返回 true 表示它是最后一个持有者、应当 close。 */
export function releaseView(docId: string, holderId: string): boolean {
  const close = shouldCloseAfterRelease(viewHolders, docId, holderId);
  const set = viewHolders.get(docId);
  if (set !== undefined) {
    set.delete(holderId);
    if (set.size === 0) viewHolders.delete(docId);
  }
  return close;
}

/** 诊断/冒烟用：当前有几个存活实例持有这个 docId。 */
export function __viewHolderCount(docId: string): number {
  return viewHolders.get(docId)?.size ?? 0;
}

/** 冒烟用：清空持有表（每个用例从空表出发，避免上一轮状态污染）。 */
export function __resetViewHolders(): void {
  viewHolders.clear();
}

/**
 * 「要不要给安装指引」。
 *
 * 判据不是"失败了"，而是**启动失败 + 引擎停在 stopped 且没有任何失败原因**：
 * 主进程的 `start` 在启动参数取不到（未安装）时恰好回这个形状
 * （`toStatusView(runtime.status())` = stopped / reason null，见
 * `main/ipc/workflowEngine.ts` 的 `spec === null` 分支）。端口分配失败、就绪超时、
 * 进程崩溃都会带非空 `reason` —— 那时给"去装一个"的指引是把用户往错方向指。
 */
export function needsInstallHint(status: WorkflowEngineStatusView | null, startFailed: boolean): boolean {
  if (!startFailed || status === null) return false;
  return status.state === "stopped" && status.reason === null;
}

/** 占位矩形的窗口坐标 → 契约 bounds。与 GenOffice 面板同一套夹取理由。 */
function measureBounds(el: HTMLElement): DocViewRect | null {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const clamp = (v: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(v)));
  return {
    x: clamp(r.left, 0, 16384),
    y: clamp(r.top, 0, 16384),
    width: clamp(r.width, 1, 16384),
    height: clamp(r.height, 1, 16384),
  };
}

/** close 的两条拒绝形态都要兜住（桌面 rejected Promise / 手机同步抛），理由同
 *  `GenofficeViewHostPane.closeQuietly`：留一个未处理拒绝会整棵卸载 React 19。 */
function closeQuietly(docId: string): void {
  try {
    void api.documentView.close({ docId }).catch(() => {});
  } catch {
    /* web 传输同步拒绝 —— 卸载路径无事可做 */
  }
}

/**
 * 【W15】最后一个持有者释放之后，**延后一拍再确认**才关。
 *
 * 为什么不能立刻关：设置页关闭时，「设置实例卸载」与「右侧面板实例变 active」
 * 发生在**同一个 commit**——React 先跑卸载清理、再跑其余 effect，所以清理那一刻
 * 右侧面板还没登记。若在这里直接 `close`，紧接着右侧面板的 `open` 只能重建视图
 * （Node-RED 编辑器页重新加载，画了一半的流没了）。延后到本轮 effect 全部跑完，
 * 接手的实例已经登记，持有表非空，就不关。
 */
function closeIfStillUnowned(docId: string): void {
  queueMicrotask(() => {
    if (__viewHolderCount(docId) === 0) closeQuietly(docId);
  });
}

/** 一次启动/停止的结局。写操作用显式 await，不塞进 useRpc。 */
type EngineActionError = { kind: "start" | "stop"; reason: string } | null;

/** 一行的状态视图。**导出是为了 smoke 能在 SSR 下直接画它**（`EngineRuntimePanel`
 *  在无头环境里会停在 loading —— effects 不跑），见 scripts/workflow-view-smoke。 */
export function EngineRow({
  status,
  active,
  onChanged,
}: {
  status: WorkflowEngineStatusView;
  /** 这个页签当前是不是显示中的那一个。`WorkflowsPanel` 的页签**同时挂载**、
   *  靠 `hidden` 类切换 —— 原生视图不认 CSS 的 display:none，不显式 hide 的话
   *  切到别的页签时编辑器仍会浮在上面盖住人家。这里用 hide/show（不是 close/open）：
   *  关掉会重新加载 Node-RED 编辑器页，用户画了一半的流就没了。 */
  active: boolean;
  /** 状态没有任何推送通道（契约只有 list/status 两条读口），所以写操作成功之后
   *  必须由这一层主动重读；否则徽标会一直停在旧状态，用户以为按钮没生效。 */
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [actionError, setActionError] = useState<EngineActionError>(null);
  const [busy, setBusy] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  /** 上一轮 open 用的 URL。URL 换了要重新 open（宿主按 URL 变化决定是否导航）。 */
  const openedUrlRef = useRef<string | null>(null);
  /** 【W15】本实例在共享视图持有表里的身份 —— 一个 `EngineRow` 一个，跨 effect 重跑不变。 */
  const [holderId] = useState(() => nextViewHolderId());
  /** 在途的 `documentView.open` 条数。卸载时若有在途 open，close 要等它落地
   *  （先 close 后建 = 视图在 close 之后才被建出来，没人关，浮在窗口最上层）。 */
  const openInFlightRef = useRef(0);
  /** 卸载时发现自己是最后一个持有者、但 open 还在途 —— 等落地再关。 */
  const closeWhenSettledRef = useRef(false);
  /** 最近一次渲染的 active。用于在途 open 落地时判断"这个视图现在还有人要显示吗"。 */
  const activeRef = useRef(active);
  activeRef.current = active;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const docId = useMemo(() => engineDocId(status.engineId), [status.engineId]);
  const badge = engineStateBadge(status.state);
  const dockSide = useSessionStore((s) => s.paneLayout?.placements?.find(p =>
    p.content?.kind === "flow" && p.content.flowId === status.engineId)?.side);
  // Pure reordering can move a native view without causing ResizeObserver to fire.
  // Re-measure in a post-layout frame; never call open/loadURL to move it.
  useEffect(() => {
    if (!active || !status.editorUrl || !dockSide) return;
    const raf = requestAnimationFrame(() => {
      const bounds = stageRef.current && measureBounds(stageRef.current);
      if (bounds) void api.documentView.bounds({ docId, bounds }).catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [dockSide, active, status.editorUrl, docId]);

  const run = async (kind: "start" | "stop"): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const result = kind === "start"
        ? await api.workflowEngine.start({ engineId: status.engineId })
        : await api.workflowEngine.stop({ engineId: status.engineId });
      if (!result.ok) {
        setActionError({ kind, reason: result.reason });
      }
      // 成功失败都重读：契约只有 list/status 两条读口（没有推送），失败的
      // `status` 也带着"停在哪个状态"的权威快照 —— 不重读的话徽标会一直停在
      // 点击之前的样子，用户分不清"没生效"和"生效了但失败了"。
      await onChanged();
    } catch (err) {
      // preload 的 rejected Promise 与手机端的同步抛都可能出现在这里。
      setActionError({ kind, reason: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  // 【W15】本实例要销毁时调这一句：释放持有、必要时延后确认关闭。**只在真正的
  // 「本实例不再用这个视图」时调**（卸载 / 引擎离开 running / 重试前丢弃旧视图）。
  // 返回 true = 本实例是最后一个持有者（调用方据此决定要不要等 open 落地再关）。
  const releaseOwnership = (targetDocId: string): boolean => {
    return releaseView(targetDocId, holderId);
  };
  // 【ARC-006】running 时把编辑器嵌进占位区。几何同步与 GenOffice 同一条做法：
  // rAF 节流 + ResizeObserver。**关视图只发生在两处**：离开 running（本 effect
  // 的 url === null 分支）与卸载（下面那条空依赖 effect）—— 页签切走**不关**，
  // 只 hide（见 `active` 分支；浏览器面板"保留浏览状态、切回来还在"的同一取舍）。
  //
  // 【W15】同一个 docId 有两个宿主（设置页的引擎页签 + 右侧面板的 NR 停靠位），
  // 视图按 docId 复用。所以「关」不是实例动作：离开 running / 卸载时先释放持有，
  // **只有持有表空了才关**（`shouldCloseAfterRelease`）。另一个实例还在用的时候
  // 谁都不许关。
  //
  // 为什么 `active` 在依赖里却不在本 effect 的清理里关视图：页签切换会让本 effect
  // 重跑（拿到新的 active），如果清理函数无条件 close，切走就等于关 —— 用户画了
  // 一半的流会被重新加载掉。所以清理只收 rAF/观察者，关闭责任拆给专门的一条。
  useEffect(() => {
    const url = status.editorUrl;
    if (url === null) {
      // 离开 running（停止/失败）：把还开着的视图关掉，别让一块原生视图浮在设置页上。
      // 【W15】只有最后一个持有者才关 —— 另一个宿主还在显示它的时候关掉，
      // 对方的下一次 sync 会收到「文档视图不存在或已关闭」。
      if (openedUrlRef.current !== null) {
        openedUrlRef.current = null;
        const last = releaseOwnership(docId);
        if (last) {
          if (openInFlightRef.current > 0) closeWhenSettledRef.current = true;
          else closeIfStillUnowned(docId);
        }
      }
      return;
    }
    if (!active) {
      // 视图已经建出来就只是藏起来；还没建（刚 running、用户没切到本页）就什么都不做
      // —— 等用户真的打开这一页再建，否则 Node-RED 编辑器页会在后台白加载一次。
      // 【W15】藏起来同样要登记持有：本实例还在用这个视图（只是没显示），
      // 另一个宿主关闭时不能替本实例把它销毁。
      if (openedUrlRef.current !== null) {
        acquireView(docId, holderId);
        try {
          void api.documentView.hide({ docId }).catch(() => {});
        } catch {
          /* web 传输同步拒绝 —— 手机端没有这个视图 */
        }
      }
      return;
    }
    const stage = stageRef.current;
    if (stage === null) return;

    let disposed = false;
    let raf = 0;
    let attempts = 0;
    let lastKey = "";
    let observer: ResizeObserver | null = null;

    const sendOpen = (bounds: DocViewRect): void => {
      lastKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      openedUrlRef.current = url;
      // 【W15】open 成功之前就登记：从这一刻起本实例"要用这个视图"，别的宿主
      // 卸载时不能替本实例关掉它。
      acquireView(docId, holderId);
      // 【ARC-006 Gate A 缺口】把 engineId 一起递下去：宿主据此从主进程注入
      // `Authorization`（令牌不进 URL / 不进 status/list）。渲染端拿不到令牌。
      openInFlightRef.current += 1;
      const pending = api.documentView.open({ docId, url, bounds, visible: true, workflowEngineId: status.engineId });
      void pending.then(
        (result) => {
          openInFlightRef.current -= 1;
          if (disposed) {
            // 【W15】这次 open 已被**本实例**的新一轮 effect 取代（retry / url 变化），
            // 或本实例已卸载。两种情况都**不许无条件 close** —— 视图可能与另一个
            // 宿主共享：
            //   · `closeWhenSettledRef` 表示卸载时本实例是最后一个持有者、只是在等
            //     这次 open 落地；落地后仍是空表才关（期间别的实例可能已接手）。
            //   · 否则持有登记属于本实例的**新一轮**，不能在这里撤。
            if (closeWhenSettledRef.current) {
              closeWhenSettledRef.current = false;
              if (__viewHolderCount(docId) === 0) closeIfStillUnowned(docId);
            }
            return;
          }
          if (!result.ok) {
            setViewError(result.reason);
            return;
          }
          setViewError(null);
          // 在途期间用户把面板藏了：视图已经 visible=true 地建出来，这里补一声 hide，
          // 免得编辑器浮在别的页签上面。
          if (!activeRef.current) {
            try {
              void api.documentView.hide({ docId }).catch(() => {});
            } catch {
              /* web 传输同步拒绝 */
            }
          }
        },
        (err: unknown) => {
          openInFlightRef.current -= 1;
          if (disposed) {
            if (closeWhenSettledRef.current) {
              closeWhenSettledRef.current = false;
              if (__viewHolderCount(docId) === 0) closeIfStillUnowned(docId);
            }
            return;
          }
          setViewError(err instanceof Error ? err.message : String(err));
          // 抛错 = 视图没建出来；本实例的持有登记撤回（视图不存在，没人该"持有"它）。
          releaseOwnership(docId);
        },
      );
    };

    // 首次进入 running：`start()` 会先 open（建视图 + 装凭据绑定），之后只发改几何。
    const sync = (): void => {
      if (disposed) return;
      const bounds = measureBounds(stage);
      if (bounds === null) return;
      const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      void api.documentView.bounds({ docId, bounds }).then(
        (result) => {
          if (!result.ok && !disposed) setViewError(result.reason);
        },
        () => { /* 下一帧还会再来 */ },
      );
    };
    const schedule = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    };

    const start = (): void => {
      if (disposed) return;
      const bounds = measureBounds(stage);
      if (bounds !== null) {
        sendOpen(bounds);
        schedule();
      } else if (attempts < 120) {
        attempts += 1;
        raf = requestAnimationFrame(start);
      } else {
        setViewError(t("settings.workflows.engine.viewStageTooSmall"));
      }
    };
    start();

    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(stage);
    }
    window.addEventListener("resize", schedule);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      // 这里**只**收定时器与观察者。视图的关闭归下面那条空依赖 effect 的卸载
      // 清理管 —— 若在这里 close，页签切走（active 变化让本 effect 重跑）也会关，
      // 重新进来就得重新加载 Node-RED 编辑器页。
    };
    // url/docId/active 变了要重建或显隐视图；retryNonce 是显式重试；t 只影响错误文案。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, status.editorUrl, active, retryNonce]);

  // 【ARC-006】组件卸载 = 关视图。原生 `WebContentsView` 不随 DOM 卸载（它不属于
  // React 树），漏掉这一步会在设置页关掉后把一块编辑器永远浮在窗口最上层。空依赖：
  // 只跑卸载那一次。用 ref 取最新的 docId（挂载后 engineId 不会再变，但闭包里拿
  // 第一次 render 的值是惯例上最容易错的地方）。
  //
  // 【W15】**只有最后一个持有者才关**。同一个 docId 有两个宿主时（设置页引擎页签
  // + 右侧面板 NR 停靠位），先卸载的那个把共享视图关掉，另一个正在显示的编辑器
  // 就没了 —— 它的下一次 sync 会收到「文档视图不存在或已关闭」，而且不会自己恢复
  // （依赖项一个都没变，不会再 open 一次）。卸载时若自己的 open 还在途，close 要
  // 等它落地（先 close 后建 = 视图在 close 之后才被建出来，没人关）。
  useEffect(() => {
    const docIdAtMount = engineDocId(status.engineId);
    return () => {
      if (openedUrlRef.current !== null) {
        openedUrlRef.current = null;
        const last = releaseView(docIdAtMount, holderId);
        if (last) {
          if (openInFlightRef.current > 0) closeWhenSettledRef.current = true;
          else closeIfStillUnowned(docIdAtMount);
        }
      } else {
        // 没有 openedUrlRef（从未 open / 已由别的分支释放）仍可能有登记残留：
        // 幂等释放，最后一个持有者照样关。
        if (releaseView(docIdAtMount, holderId) && openInFlightRef.current === 0) {
          closeIfStillUnowned(docIdAtMount);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editorOpen = canOpenEditor(status);
  const installHint = needsInstallHint(status, actionError?.kind === "start");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-engine-panel={status.engineId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[0.7857em] text-content">{status.engineId}</span>
        <Badge variant={badge.tone} data-engine-state={status.state}>
          {t(badge.key)}
        </Badge>
        {status.port !== null && (
          <span className="font-mono text-[0.7143em] text-content-subtle">
            {t("settings.workflows.engine.loopbackPort", { port: status.port })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {status.state === "running" ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void run("stop")}
            >
              <IconPlayerStop size={12} />
              {t("settings.workflows.engine.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={busy || status.state === "starting"}
              onClick={() => void run("start")}
            >
              <IconPlayerPlay size={12} />
              {t("settings.workflows.engine.start")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setRetryNonce((n) => n + 1);
              void onChanged();
            }}
            title={t("settings.workflows.engine.refreshStatus")}
          >
            {busy ? <Spinner size="xs" /> : <IconRefresh size={12} />}
          </Button>
        </div>
      </div>

      {shouldShowRestartDeployNotice(status) && (
        <div
          data-engine-deploy-notice=""
          role="status"
          className="rounded border border-edge px-3 py-2 text-[0.7857em] leading-relaxed text-content-muted"
        >
          {t("settings.workflows.engine.restartRequiresDeploy")}
          {shouldShowUntrustedNotice(status) && (
            <div className="mt-1" data-engine-untrusted-notice="">
              {t("settings.workflows.engine.pendingReviewHint")}
            </div>
          )}
        </div>
      )}

      {/* 【Q5】启动时没迁成功的旧工作流 —— 迁移发生在窗口出现之前，只能事后读。
          用户最需要它的时机正是"我那张图怎么不跑"的时候，所以逐条列出来，
          不只给一句汇总。 */}
      {status.pendingMigration !== null && status.pendingMigration !== undefined && (
        <ErrorNote
          tone="warning"
          icon={IconAlertTriangle}
          title={t("settings.workflows.engine.pendingMigrationTitle")}
        >
          <div className="break-words">{status.pendingMigration.summary}</div>
          <ul className="mt-1 space-y-0.5">
            {status.pendingMigration.pending.map((item) => (
              <li key={item.workflowId} className="break-words">
                「{item.name}」— {item.reason}
              </li>
            ))}
          </ul>
        </ErrorNote>
      )}

      {/* 失败 / 停止且有原因：把主进程给的那句人话原样摆出来。 */}
      {status.reason !== null && (
        <ErrorNote tone="warning" icon={IconAlertTriangle} title={t("settings.workflows.engine.notRunning")}>
          <div className="break-words">{status.reason}</div>
        </ErrorNote>
      )}
      {actionError !== null && (
        <ErrorNote
          title={t(actionError.kind === "start" ? "settings.workflows.engine.startFailed" : "settings.workflows.engine.stopFailed")}
          icon={IconAlertTriangle}
        >
          <div className="break-words">{actionError.reason}</div>
        </ErrorNote>
      )}
      {installHint && (
        <ErrorNote tone="warning" title={t("settings.workflows.engine.installTitle")}>
          <div>{t("settings.workflows.engine.installBody")}</div>
          <div className="mt-1 break-all font-mono text-[0.9em] text-content-muted">
            {t("settings.workflows.engine.installPath")}
          </div>
        </ErrorNote>
      )}
      {viewError !== null && (
        <ErrorNote
          title={t("settings.workflows.engine.viewOpenFailed")}
          action={
            <Button size="sm" variant="ghost" onClick={() => { setViewError(null); setRetryNonce((n) => n + 1); }}>
              {t("common.retry")}
            </Button>
          }
        >
          <div className="break-words">{viewError}</div>
        </ErrorNote>
      )}

      {/* 占位区：running 时主进程把 WebContentsView 摆到它的窗口矩形上。空 div 是
          故意的 —— 不与原生视图抢像素。非 running 时这里画出"为什么没有编辑器"，
          而且把**下一步**（启动）直接放在这段话下面：默认页签落到引擎页之后，
          这一块是用户打开「工作流」看到的第一屏。 */}
      {editorOpen ? (
        <div ref={stageRef} className="min-h-0 flex-1" data-engine-view-stage="" />
      ) : (
        <div
          className="flex min-h-24 flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-edge px-4 py-6 text-center text-[0.7857em] text-content-muted"
          data-engine-empty=""
        >
          <span>
            {status.state === "starting"
              ? t("settings.workflows.engine.waitingReady")
              : t("settings.workflows.engine.editorHint")}
          </span>
          {status.state !== "starting" && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void run("start")}>
              <IconPlayerPlay size={12} />
              {t("settings.workflows.engine.start")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 【ARC-006 桥 2】「让引擎回调 Mcode（可选）」—— 一个**如实标注为未实现**的预留位。
 *
 * ## 为什么画的是占位而不是可复制的配置
 *
 * 方案文档（`docs/planning/arc-006-wf-integration.md` 桥 2 段，2026-10-18 修订）的结论是
 * 走一个 stdio MCP server（`mcode-host-mcp`），而它**尚未实现**。此刻给出一份"看起来能用"
 * 的命令/args/env，等于教用户把它填进 Node-RED —— 用户会得到一个连不上的条目，然后来查
 * 一个根本不存在的故障。所以这里只画**形状**（字段名 + 尖括号占位值），明确写"现在还不能
 * 用"，并且**不提供复制按钮**：复制按钮本身就是"这是一份可用配置"的暗示。
 *
 * ## 为什么先说"能力面与 Agent 完全一致"
 *
 * 这是设计约束里最容易被误解的一条：既然引擎能回调 Mcode，用户会担心它是不是拿到了一张
 * 更大的权限表。事实相反 —— 实现将复用同一份 `appMcpTools()`，审批仍弹在 Mcode 窗口里
 * （引擎没有回合，不能替用户点）。这句话现在就要写上，因为它约束的是将来的实现，不是
 * 将来的文案。
 *
 * 等 server 落地后，本组件应该改成渲染真实的 command/args/env（届时再给复制按钮），
 * 文案键沿用 `callbackShape*`，不必改布局。
 */
export function EngineCallbackSection() {
  const { t } = useI18n();
  return (
    <section
      className="rounded-lg border border-dashed border-edge bg-surface-muted/40 p-3 text-[0.7857em]"
      data-engine-callback="pending"
      aria-labelledby="engine-callback-title"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 id="engine-callback-title" className="font-semibold text-content">
          {t("settings.workflows.engine.callbackTitle")}
        </h4>
        <Badge variant="warning">{t("settings.workflows.engine.callbackSoon")}</Badge>
      </div>
      <p className="mt-1 leading-relaxed text-content-muted">
        {t("settings.workflows.engine.callbackBody")}
      </p>
      <div className="mt-2 text-content-subtle">{t("settings.workflows.engine.callbackShapeLabel")}</div>
      {/* 占位形状：没有复制按钮，`<...>` 里是字段说明而不是值。 */}
      <pre
        className="mt-1 overflow-auto whitespace-pre rounded bg-surface-muted px-2 py-1.5 font-mono text-[0.9em] text-content-muted"
        data-engine-callback-shape=""
      >
        {t("settings.workflows.engine.callbackShape")}
      </pre>
      <p className="mt-2 leading-relaxed text-content-muted">
        {t("settings.workflows.engine.callbackParity")}
      </p>
    </section>
  );
}

/**
 * 【ARC-006 Gate E】**已装节点包**：列表 + 安装入口 + 渲染端审批卡。
 *
 * ## 它为什么长在设置页
 *
 * 安装节点包 = 往引擎里放一份会被 `require()` 执行的可执行代码（与「装 MCP 服务器」
 * 同一档）。审批卡放在用户主动点「安装」的这个面板里，卡片能说清包名/版本/来源/
 * 许可/能力（含 network）/sha256 —— 比原生框更说得清；这也与 `moduleApproval` 的
 * 分工一致（主进程发请求、渲染端画卡，`engineNodeApprovalBridge.ts`）。
 *
 * ## 审批卡不是"确认按钮"
 *
 * 主进程在安装时推送 `workflowEngine:nodeInstallApproval`；本组件画卡，用户点
 * 「允许安装/拒绝」后经 `respondNodeInstallApproval` **只回答那一次 requestId**。
 * 主进程不保存任何批准状态 —— 下次安装要重新点头。
 *
 * ## 不伪装空
 *
 * `nodesList` 的 `corrupt` 非空时显示原因（清单读不懂 ≠ 没装）。
 */
export function EngineNodePackagesSection() {
  const { t } = useI18n();
  const list = useRpc(() => api.workflowEngine.nodesList(), [], { toastOnError: false });
  // 安装请求的完整形状（`{sourceDir, meta}`）由调用方给：sha256 是**对着要装的那份字节**
  // 算出来的，面板没有能力自己算（也不该假装知道）。与 `ModuleSurface` 的清单草稿同形。
  const [draft, setDraft] = useState(() => JSON.stringify({
    sourceDir: "",
    meta: { name: "", version: "", source: "", sha256: "", license: "", capabilities: [] },
  }, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [approval, setApproval] = useState<Extract<Parameters<Parameters<typeof api.on.nodeInstallApproval>[0]>[0], { channel: "workflowEngine:nodeInstallApproval" }> | null>(null);
  const approvalCardRef = useRef<HTMLDivElement>(null);
  // 【ARC-005】审批卡输入保护：「允许安装」开卡后短延迟才可点（与 Claude 工具
  // 审批卡共用 useApprovalArming 一份实现）；Esc 视为拒绝。
  const allowArmed = useApprovalArming(approval?.requestId ?? null);

  // 主进程推来的审批卡：一次一张（安装是串行动作，不会并发）。
  useEffect(() => {
    const off = api.on.nodeInstallApproval((msg) => setApproval(msg));
    return off;
  }, []);

  // 默认焦点落在卡片本身（不是「允许安装」）：误按回车没有可激活的动作。
  useEffect(() => {
    if (approval === null) return;
    // 同步阶段把焦点移进卡：卡片挂载后的同一提交里完成。
    approvalCardRef.current?.focus({ preventScroll: true });
  }, [approval?.requestId]);

  const respond = async (approved: boolean): Promise<void> => {
    if (approval === null) return;
    const requestId = approval.requestId;
    setApproval(null);
    try { await api.workflowEngine.respondNodeInstallApproval({ requestId, approved }); }
    catch { /* 应答失败 = 主进程那边超时会按拒绝处理（fail-closed） */ }
  };

  const install = async (): Promise<void> => {
    if (busy) return;
    let request: { sourceDir: string; meta: { name: string; version: string; source: string; sha256: string; license: string; capabilities: string[] } };
    try {
      request = JSON.parse(draft) as typeof request;
    } catch {
      setError(t("settings.workflows.engine.nodesNeedDir"));
      return;
    }
    if (typeof request?.sourceDir !== "string" || request.sourceDir.trim() === "") {
      setError(t("settings.workflows.engine.nodesNeedDir"));
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      // 审批由主进程弹出（渲染端只回 requestId）；这里**没有** approvedByUser 字段可传。
      const result = await api.workflowEngine.nodeInstall({ sourceDir: request.sourceDir.trim(), meta: request.meta });
      if (!result.ok) { setError(`${t("settings.workflows.engine.nodesInstallFailed")}: ${result.reason}`); return; }
      setNotice(t("settings.workflows.engine.nodesInstalled", { name: result.node.name, version: result.node.version }));
      await list.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2" data-engine-nodes="">
      <h4 className="text-body font-semibold">{t("settings.workflows.engine.nodesTitle")}</h4>
      <p className="text-[0.7857em] text-content-muted">{t("settings.workflows.engine.nodesMetaHint")}</p>
      {list.loading && list.data === undefined && <LoadingNote label={t("common.loading")} />}
      {list.error !== null && list.data === undefined && <ErrorNote>{list.error.message}</ErrorNote>}
      {list.data?.corrupt !== null && list.data?.corrupt !== undefined && (
        <ErrorNote tone="warning" icon={IconAlertTriangle}>
          {t("settings.workflows.engine.nodesCorrupt", { reason: list.data.corrupt })}
        </ErrorNote>
      )}
      {list.data !== undefined && list.data.nodes.length === 0 && list.data.corrupt === null && (
        <p className="text-[0.7857em] text-content-subtle" data-engine-nodes-empty="">{t("settings.workflows.engine.nodesEmpty")}</p>
      )}
      {list.data !== undefined && list.data.nodes.length > 0 && (
        <ul className="space-y-1" data-engine-nodes-list="">
          {list.data.nodes.map((node) => (
            <li key={node.name} className="rounded border border-edge px-2 py-1 text-[0.7857em]">
              <span className="font-mono">{node.name}@{node.version}</span>
              <span className="ml-2 text-content-subtle">{t("settings.workflows.engine.nodesFieldLicense")}: {node.license}</span>
              <span className="ml-2 font-mono text-content-subtle" title={node.sha256}>{node.sha256.slice(0, 12)}…</span>
            </li>
          ))}
        </ul>
      )}
      <label className="block space-y-1 text-body">
        <span>{t("settings.workflows.engine.nodesSourceDir")}</span>
        <textarea
          data-testid="engine-nodes-request"
          className="h-40 w-full rounded border border-edge bg-surface-muted p-2 font-mono text-code"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
      </label>
      <Button variant="primary" disabled={busy} onClick={() => void install()}>
        {t("settings.workflows.engine.nodesInstall")}
      </Button>
      {error !== null && <ErrorNote title={t("settings.workflows.engine.nodesInstallFailed")}>{error}</ErrorNote>}
      {notice !== null && <p className="text-[0.7857em] text-content-muted">{notice}</p>}
      {approval !== null && (
        <div
          ref={approvalCardRef}
          tabIndex={-1}
          role="alertdialog"
          aria-label={t("settings.workflows.engine.nodesApprovalTitle")}
          className="space-y-2 rounded border border-warning/50 bg-warning/10 p-3 text-[0.7857em] focus:outline-none"
          data-engine-approval=""
          onKeyDown={(e) => {
            // 【ARC-005】Esc = 拒绝（明着回答这一次 requestId）。没有「关闭卡片但
            // 不作答」这条路：不作答会让主进程等到超时，用户却以为已经取消了。
            // 输入法合成中的按键不当作 Esc（与 ApprovalPrompt 同一守卫）。
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            void respond(false);
          }}
        >
          <div className="font-semibold">{t("settings.workflows.engine.nodesApprovalTitle")}</div>
          <p>{t("settings.workflows.engine.nodesApprovalBody")}</p>
          <div className="space-y-0.5 font-mono text-content-muted">
            <div>{approval.name}@{approval.version}</div>
            <div>{t("settings.workflows.engine.nodesFieldSource")}: {approval.source}</div>
            <div>{t("settings.workflows.engine.nodesFieldLicense")}: {approval.license}</div>
            <div>{t("settings.workflows.engine.nodesFieldCapabilities")}: {approval.capabilities.join(", ")}</div>
            <div>{t("settings.workflows.engine.nodesFieldSha")}: {approval.sha256.slice(0, 16)}…</div>
            <div>{t("settings.workflows.engine.nodesFieldIntent")}: {approval.intent}</div>
          </div>
          {approval.network && (
            <p className="text-warning">{t("settings.workflows.engine.nodesApprovalNetwork")}</p>
          )}
          <div className="flex gap-2">
            {/* 「拒绝」先渲染且立即可用；「允许安装」开卡 500ms 内不可点（防连击/
                与开卡撞车的回车误批）。顺序 = Tab 先到拒绝。 */}
            <Button size="sm" variant="secondary" onClick={() => void respond(false)}>{t("settings.workflows.engine.nodesApprovalDeny")}</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!allowArmed}
              aria-disabled={!allowArmed}
              onClick={() => void respond(true)}
            >
              {t("settings.workflows.engine.nodesApprovalAllow")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Only a visible workflow pane needs deploy-status polling. The engine and
 * triggers continue running in Host when Electron is minimized/backgrounded. */
export function shouldPollWorkflowEngineStatus(active: boolean, running: boolean, pageVisible: boolean): boolean {
  return active && running && pageVisible;
}

export function EngineRuntimePanel({ active: activeTab = true, engineId, editorOnly = false }: { active?: boolean; engineId?: string; editorOnly?: boolean }) {
  const { t } = useI18n();
  const listRead = useRpc(() => api.workflowEngine.list(), [], { toastOnError: false });
  // Node-RED Deploy happens in the native WebContentsView, outside React.
  // Read the Host's acknowledged deploy receipt through the existing list IPC
  // only while this pane is active. A status poll never causes a deploy.
  const refreshDeployState = listRead.refetch;
  /* ⚠️ `data?.engines` —— 可选链必须**一路到底**。
   *
   * 原来写的是 `listRead.data?.engines.some(...)`：只保护了 `data` 为 null，
   * 而 `engines` 是数组时才安全。当 Host 返回的载荷不带 `engines`（比如
   * `{kind:"list", items:[]}` 这种形状，或者读失败后落到的空结果）时，
   * 这一行抛 `TypeError: Cannot read properties of undefined (reading 'some')`，
   * **整棵设置页被 React 卸载** —— 用户看到的是「点工作流 → 设置界面整个消失」，
   * 控制台只有一条 TypeError，看不出是哪一页。
   *
   * 这类崩溃会被 `settings-layout-smoke` 抓到（`[diag] exceptions=...`），
   * 但它是运行时才炸的，类型系统看不见（`data` 的声明类型是可信的联合，
   * 而真实 IPC 载荷不一定满足）。 */
  const running = (listRead.data?.engines ?? []).some(
    e => e.engineId === "node-red" && e.state === "running",
  );
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === "undefined" || !document.hidden);
  // A minimized/backgrounded Electron window has no visible editor to keep
  // up to date. Completely suspend the interval rather than waking every
  // 2.5s just to discover document.hidden. On resume perform one immediate
  // status refresh so a Deploy/Stop while hidden appears without delay.
  useEffect(() => {
    const onVisibility = (): void => {
      const visible = !document.hidden;
      setPageVisible(visible);
      if (visible && activeTab && running) void refreshDeployState();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [activeTab, running, refreshDeployState]);
  // 【Q9b】**先订阅推送，轮询只做兜底。**
  //
  // 以前只有 2.5 秒轮询：用户点「启动」之后那几秒界面是空转的，因为下一次 poll
  // 还没到。现在主进程在状态变化的**那一刻**推一条，收到就重读权威状态。
  //
  // 轮询保留但**放宽到 15 秒**：推送是唯一的及时通道，轮询只兜「推送漏了」
  // （例如渲染端重新挂载的那一瞬间）。两个都在时不会重复刷新 —— 推送那条走同一个
  // `refetch`，React Query 会合并同一时刻的重复请求。
  useEffect(() => {
    if (typeof window === "undefined" || api.workflowEngine.engineChanged === undefined) return;
    // ⚠️ **必须包一层再返回**。`useEffect` 的返回值为非 `undefined` 时 React 会把它
    // 当成清理函数**调用**；这里若直接 `return api.workflowEngine.engineChanged(...)`，
    // 一旦桥那一层没有给出函数（渲染端预览台 / 手机端 HTTP 桥漏补一项 / 旧 preload），
    // 返回的就是 `undefined` 之外的东西，卸载时抛
    // `TypeError: destroy_ is not a function`，**React 19 会把整棵树卸载** ——
    // 画面空白，而控制台只剩一条与业务无关的类型错误。
    // 实测：`workflow-ui-smoke` 点「打开 Node-RED」之后整页变空（body 102 字符）。
    const off = api.workflowEngine.engineChanged(() => { void refreshDeployState(); });
    return typeof off === "function" ? off : undefined;
  }, [refreshDeployState]);
  const shouldPollDeploy = shouldPollWorkflowEngineStatus(activeTab, running, pageVisible);
  useEffect(() => {
    if (!shouldPollDeploy) return;
    const timer = window.setInterval(() => { void refreshDeployState(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [shouldPollDeploy, refreshDeployState]);
  // T59: a library-load can restart the engine while this panel is docked.
  // Refresh the authoritative runtime status, including the new editor URL.
  const refreshOnNativeLoad = listRead.refetch;
  useEffect(() => {
    const refresh = (): void => { void refreshOnNativeLoad(); };
    window.addEventListener("mcode:native-canvas-loaded", refresh);
    return () => window.removeEventListener("mcode:native-canvas-loaded", refresh);
  }, [refreshOnNativeLoad]);
  const engines = listRead.data?.engines ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = engines.find((e) => e.engineId === (engineId ?? selectedId)) ?? (engineId ? null : engines[0] ?? null);

  if (listRead.loading && listRead.data === undefined) {
    return <LoadingNote label={t("common.loading")} />;
  }
  if (listRead.error !== null && listRead.data === undefined) {
    return (
      <ErrorNote
        action={
          <Button size="sm" variant="ghost" onClick={() => void listRead.refetch()}>
            {t("common.retry")}
          </Button>
        }
      >
        {listRead.error.message}
      </ErrorNote>
    );
  }
  if (engines.length === 0) {
    return (
      <ErrorNote tone="warning" title={t("settings.workflows.engine.noneTitle")}>
        {t("settings.workflows.engine.noneBody")}
      </ErrorNote>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 只有一个引擎时也画这一行导航：注册表是开放的（加第二个引擎只多一条），
          而"当前看的是哪一个"在有两个之后必须有地方可点。 */}
      {!editorOnly && engines.length > 1 && (
        <div className="flex gap-1" role="tablist">
          {engines.map((engine) => {
            const activeRow = engine.engineId === selected?.engineId;
            return (
              <button
                key={engine.engineId}
                type="button"
                role="tab"
                aria-selected={activeRow}
                onClick={() => setSelectedId(engine.engineId)}
                className={cn(
                  "rounded border px-2 py-1 font-mono text-[0.7857em]",
                  activeRow
                    ? "border-edge/80 bg-surface-hover text-content ring-1 ring-inset ring-edge/70"
                    : "border-edge bg-surface text-content-muted hover:text-content",
                )}
              >
                {engine.engineId}
              </button>
            );
          })}
        </div>
      )}
      {selected !== null && (
        <EngineRow
          key={selected.engineId}
          status={selected}
          // 行自己所在的那一页签**就是**引擎页时才可见。`WorkflowsPanel` 的页签
          // 同时挂载、用 hidden 类切换；把"当前显示的是不是引擎页"传下去，行才能
          // 在离开时 hide 原生视图。直接嵌进别的容器时默认可见。
          active={activeTab}
          onChanged={listRead.refetch}
        />
      )}
      {selected !== null && ((selected.libraryMirrorPending ?? 0) > 0 || selected.libraryMirrorError === true) && (
        <div role="alert" className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-[0.7857em] text-content">
          {(selected.libraryMirrorPending ?? 0) > 0
            ? t("settings.workflows.engine.libraryMirrorPending", { count: selected.libraryMirrorPending ?? 0 })
            : t("settings.workflows.engine.libraryMirrorError")}
        </div>
      )}
      {/* 回调通道的预留位（桥 2）。放在引擎行下面而不是列表之上：它描述的是
          "引擎能对 Mcode 做什么"，是引擎配置的一部分，不是操作入口。 */}
      {!editorOnly && <EngineCallbackSection />}
      {!editorOnly && <EngineNodePackagesSection />}
      {!editorOnly && <div className="text-[0.7143em] text-content-subtle">
        {t("settings.workflows.engine.footnote")}
      </div>}
    </div>
  );
}
