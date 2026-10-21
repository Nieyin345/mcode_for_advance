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
import { Badge, Button, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
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

  // 【ARC-006】running 时把编辑器嵌进占位区。几何同步与 GenOffice 同一条做法：
  // rAF 节流 + ResizeObserver。**关视图只发生在两处**：离开 running（本 effect
  // 的 url === null 分支）与卸载（下面那条空依赖 effect）—— 页签切走**不关**，
  // 只 hide（见 `active` 分支；浏览器面板"保留浏览状态、切回来还在"的同一取舍）。
  //
  // 为什么 `active` 在依赖里却不在本 effect 的清理里关视图：页签切换会让本 effect
  // 重跑（拿到新的 active），如果清理函数无条件 close，切走就等于关 —— 用户画了
  // 一半的流会被重新加载掉。所以清理只收 rAF/观察者，关闭责任拆给专门的一条。
  useEffect(() => {
    const url = status.editorUrl;
    if (url === null) {
      // 离开 running（停止/失败）：把还开着的视图关掉，别让一块原生视图浮在设置页上。
      if (openedUrlRef.current !== null) {
        openedUrlRef.current = null;
        closeQuietly(docId);
      }
      return;
    }
    if (!active) {
      // 视图已经建出来就只是藏起来；还没建（刚 running、用户没切到本页）就什么都不做
      // —— 等用户真的打开这一页再建，否则 Node-RED 编辑器页会在后台白加载一次。
      if (openedUrlRef.current !== null) {
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
      // 【ARC-006 Gate A 缺口】把 engineId 一起递下去：宿主据此从主进程注入
      // `Authorization`（令牌不进 URL / 不进 status/list）。渲染端拿不到令牌。
      const pending = api.documentView.open({ docId, url, bounds, visible: true, workflowEngineId: status.engineId });
      void pending.then(
        (result) => {
          if (disposed) {
            closeQuietly(docId);
            return;
          }
          if (!result.ok) {
            setViewError(result.reason);
            return;
          }
          setViewError(null);
        },
        (err: unknown) => {
          if (!disposed) setViewError(err instanceof Error ? err.message : String(err));
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
  useEffect(() => {
    const docIdAtMount = engineDocId(status.engineId);
    return () => {
      if (openedUrlRef.current !== null) {
        openedUrlRef.current = null;
        closeQuietly(docIdAtMount);
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
            <IconRefresh size={12} className={cn(busy && "animate-spin")} />
          </Button>
        </div>
      </div>

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
          故意的 —— 不与原生视图抢像素。非 running 时这里画出"为什么没有编辑器"。 */}
      {editorOpen ? (
        <div ref={stageRef} className="min-h-0 flex-1" data-engine-view-stage="" />
      ) : (
        <div
          className="flex min-h-24 flex-1 items-center justify-center rounded border border-dashed border-edge px-4 py-6 text-center text-[0.7857em] text-content-muted"
          data-engine-empty=""
        >
          {status.state === "starting"
            ? t("settings.workflows.engine.waitingReady")
            : t("settings.workflows.engine.editorHint")}
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
      <h4 className="text-sm font-semibold">{t("settings.workflows.engine.nodesTitle")}</h4>
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
      <label className="block space-y-1 text-sm">
        <span>{t("settings.workflows.engine.nodesSourceDir")}</span>
        <textarea
          data-testid="engine-nodes-request"
          className="h-40 w-full rounded border border-edge bg-surface-muted p-2 font-mono text-xs"
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

export function EngineRuntimePanel({ active: activeTab = true, engineId, editorOnly = false }: { active?: boolean; engineId?: string; editorOnly?: boolean }) {
  const { t } = useI18n();
  const listRead = useRpc(() => api.workflowEngine.list(), []);
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
