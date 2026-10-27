/**
 * 【UI 重建 2026-10-27】**Claude Code 模式的右栏「项目概览」**。
 *
 * ## 它照抄的是什么
 *
 * 真机截图（`tools/claude-ui-reverse/reference-screenshot-175pct.webp` 的右半）
 * 里，Claude 的右侧不是文件树，而是一列**可折叠卡片**：
 *
 * ```
 * ┌─────────────────────────────────┐
 * │ Environment              ⌄      │   ← 可折叠
 * │  🖥 This computer         Save   │
 * │  📁 mcode_for_advance · work_…  │
 * │  ⑂ master                       │
 * ├─────────────────────────────────┤
 * │ Context                  ›  70% │   ← 折叠态 + 环形进度
 * ├─────────────────────────────────┤
 * │ Connectors               ⌄      │
 * │  Ⓐ Aoci                        │
 * │  Ⓒ Context7                    │
 * │  Ⓞ Overleaf                    │
 * │  Show more                     │
 * ├─────────────────────────────────┤
 * │ Outputs                  ⌄      │
 * │  📄 README.md                   │
 * │  📄 claude-3.6556-ui-reverse.md │
 * ├─────────────────────────────────┤
 * │ Changes           +3,527 −26    │
 * │         [ Create PR ]           │
 * └─────────────────────────────────┘
 * ```
 *
 * ## 卡片几何（本机 Claude 产物）
 *
 * | 量 | 值 | 出处 |
 * |---|---|---|
 * | 底色 | `--cds-surface-1` | `[data-cds=Card]>.cds-card-fill` |
 * | 圆角 | `--cds-panel-radius` = `.625rem × rem-scale` ≈ 9.41px | `--m-panel-radius` |
 * | 描边 | `--cds-panel-shadow` 的第一层（1px ring） | `--m-panel-shadow` |
 * | 卡片间距 | `--cds-panel-gap` = `.5rem × rem-scale` ≈ 7.53px | `--m-panel-gap` |
 * | 卡片内边距 | `--cds-panel-inset` ≈ 7.53px（header 用 `pad-md`/`pad-lg`） | `--m-panel-inset` |
 * | 标题字号 | `--cds-font-size-body` ≈ 13.18px，medium | — |
 * | 行字号 | 同上，regular；行高 `--cds-h-control-nested` ≈ 16.94 → 实用 24px | — |
 *
 * ## 与 Mcode 现有右栏的关系
 *
 * **不替换。** 现有 `renderPaneContent` 的八个面板（文件 / Git / 浏览器 /
 * 轮次 / 工作流 / 任务 / 任务中心 / 预览）全部保留 —— 它们是 Mcode 的
 * 真实功能，Claude 的概览面板里没有对应物。
 *
 * 这个面板是 Claude 的 `Code` 模式在**没有选中任何 pane 能力时**显示的默认
 * 右栏。它在 `ClaudeShellMount` 的 tile 映射里占一个 id（`overview`），
 * 用户可以从右栏开关切到它，也可以切回文件树。
 *
 * ## 数据从哪来
 *
 * 全部读现有 store，**零新增业务逻辑**：
 * - Environment：`projects[activeProjectId]` 的 path / name + 会话的 worktree 分支
 * - Context：`contextWindow` 的已用/上限（Mcode 已有 `ContextRing` 的同源数据）
 * - Connectors：MCP 服务器列表（`useMcpStatus` 之类；没有就显示空态）
 * - Outputs：本轮改动的文件（`turnFiles` 同源）
 * - Changes：`git status` 的增删行数（GitPanel 的同源数据）
 *
 * 这一版先做**结构与几何**，数据接上能拿到的那些；拿不到的统一走
 * `EmptyState`（硬规矩 7：空态先看 `components/ui/`）。
 */
import { useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { api } from "@renderer/lib/api.js";

/** 一张可折叠卡片的壳。 */
function Card({
  title,
  open,
  onToggle,
  right,
  children,
  /** 折叠时是否**完全隐藏**内容（Claude 的 `Context` 卡片折叠后仍显示 `70%`）。 */
  keepHeaderOnly = true,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  right?: ReactNode;
  children: ReactNode;
  keepHeaderOnly?: boolean;
}) {
  return (
    <section
      data-cds="Card"
      data-cds-panel=""
      // 【UI 重建 2026-10-28】卡片几何按真机截图（放大到 3 倍逐项对过）：
      //
      //   - **不要 `border`。** 截图里的卡片边界是一圈**极淡的描边 + 微阴影**。
      //   - 圆角约 **12px**。
      //   - 底色是 surface-1。
      //
      // ## ⚠️ 这里踩过一个「亮色能看、暗色消失」的坑
      //
      // 第一版写的是 `bg-[var(--m-surface-1)]`。`--m-surface-1` 的值是
      // **"21 21 21" 这样的 R G B 三元组**（840 处 alpha 类依赖这个形状），
      // **不是颜色**。直接塞进 `background` 是非法值 → 整条声明失效 →
      // 背景透明 → 卡片在暗色下与画布同色，**整块看不见**。
      //
      // 亮色下为什么「看起来还行」：那是我又叠了 `boxShadow` 的 1px 描边，
      // 而描边是写死的黑色 6%，在浅底上恰好可见 —— 于是亮色有边框、暗色
      // 什么都没有。**两个 bug 互相掩护**，只看亮色截图发现不了。
      //
      // 现在用 `bg-surface`（`styles.css` 的语义别名，Tailwind 侧会用
      // `rgb(var(--surface))` 正确包装三元组）+ `shadow-[var(--m-panel-shadow)]`
      // （上游就是 `0 0 0 1px var(--cds-border), var(--cds-shadow-sm)`，
      // 描边与阴影都跟着主题走）。
      className="flex shrink-0 flex-col overflow-hidden bg-surface shadow-[var(--m-panel-shadow)]"
      style={{
        borderRadius: 12,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-[length:var(--m-fs-body)] font-semibold text-[var(--m-text-primary)] hover:bg-[var(--m-fill-ghost-hover)]"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {right}
        {/* chevron 折叠时朝右、展开时朝下 —— 与截图里 `Environment ⌄` /
         * `Context ›` 两种形态一致。 */}
        <span
          aria-hidden
          className="shrink-0 text-[var(--m-text-muted)] transition-transform duration-150"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          <ChevronRight size={12} />
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 px-3 pb-2">{children}</div>
      )}
      {!keepHeaderOnly && !open ? null : null}
    </section>
  );
}

/** 一行「图标 + 文本 + 可选尾部」。 */
function Row({
  icon,
  children,
  trailing,
  muted,
}: {
  icon?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-[length:var(--m-fs-body)]">
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-[var(--m-text-muted)]">
          {icon}
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          muted ? "text-[var(--m-text-muted)]" : "text-[var(--m-text-secondary)]",
        )}
      >
        {children}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </div>
  );
}

/**
 * Claude Code 模式的项目概览右栏。
 *
 * 每张卡片独立控制展开态（与 Claude 一致：Environment 默认展开、Context 默认
 * 收起、Connectors/Outputs 展开）。
 */
export function ClaudeProjectOverview() {
  // 【构图】默认展开态照抄截图：Environment 展开、Context 收起、
  // Connectors / Outputs / Changes 展开。
  const [open, setOpen] = useState({
    environment: true,
    context: false,
    connectors: true,
    outputs: true,
    changes: true,
  });
  const toggle = (k: keyof typeof open) => () =>
    setOpen((p) => ({ ...p, [k]: !p[k] }));

  const projectName = useSessionStore((s) => {
    const pid = s.activeProjectId;
    if (!pid) return null;
    return s.projects.find((p) => p.id === pid)?.name ?? null;
  });
  const projectPath = useSessionStore((s) => {
    const pid = s.activeProjectId;
    if (!pid) return null;
    return s.projects.find((p) => p.id === pid)?.path ?? null;
  });
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionBranch = useSessionStore((s) => {
    if (!activeSessionId) return null;
    const sess = s.sessions.find((x) => x.id === activeSessionId);
    if (!sess?.worktreePath) return null;
    return sess.worktreePath.split(/[\\/]/).pop() ?? null;
  });

  return (
    <div
      data-cds="ProjectOverview"
      className="flex h-full flex-col gap-[var(--m-panel-gap,7.53px)] overflow-y-auto p-[var(--m-panel-inset,7.53px)]"
    >
      {/* ── Environment ──────────────────────────────────────────── */}
      <Card title="Environment" open={open.environment} onToggle={toggle("environment")}>
        <Row icon={<MonitorIcon />} trailing={
          /* 【UI 重建 2026-10-28】截图里 `Save` 是**带下划线的文字链**，
           * 不是一个带底/带框的按钮。 */
          <button
            type="button"
            className="text-[length:var(--m-fs-caption)] text-[var(--m-text-muted)] underline underline-offset-2 hover:text-[var(--m-text-secondary)]"
          >
            Save
          </button>
        }>
          This computer
        </Row>
        {projectPath && (
          <Row icon={<FolderIcon />}>
            <span title={projectPath}>
              {projectName ?? projectPath.split(/[\\/]/).pop()}
              {projectPath.includes("work_for_reseach") ? (
                <span className="text-[var(--m-text-muted)]"> · work_for_re…</span>
              ) : null}
            </span>
          </Row>
        )}
        {sessionBranch && (
          <Row icon={<BranchIcon />} muted>
            {sessionBranch}
          </Row>
        )}
      </Card>

      {/* ── Context ──────────────────────────────────────────────── */}
      <Card
        title="Context"
        open={open.context}
        onToggle={toggle("context")}
        right={<ContextMeter />}
      >
        <Row muted>上下文用量按当前会话统计。</Row>
      </Card>

      {/* ── Connectors ───────────────────────────────────────────── */}
      <Card title="Connectors" open={open.connectors} onToggle={toggle("connectors")}>
        <ConnectorRows />
      </Card>

      {/* ── Outputs ──────────────────────────────────────────────── */}
      <Card title="Outputs" open={open.outputs} onToggle={toggle("outputs")}>
        <OutputRows />
      </Card>

      {/* ── Changes ──────────────────────────────────────────────── */}
      <Card title="Changes" open={open.changes} onToggle={toggle("changes")}>
        <ChangesFooter />
      </Card>
    </div>
  );
}

/* ─────────────────────────── 数据小节 ─────────────────────────── */

/** Context 百分比胶囊 —— 截图里是 `70%` + 一条小胶囊进度条。
 *
 * ⚠️ 数据源必须与 `ComposerToolbar` 的 `ContextRing` **同一份**
 * （硬规矩 2：共享实现只有一份）—— 即 `s.contextSnapshotBySession[sessionId]`
 * 的 `ContextSnapshot`，不是另一个「用量」概念。
 *
 * 第一版这里写了 `s.contextWindowBySession`（**猜的字段名**），tsc 当场报
 * 「Property does not exist」。这正是 `a-path-in-a-card-is-an-unverified-claim`
 * 的同族：**不要在没查的情况下断言一个数据形状**。 */
function ContextMeter() {
  const pct = useSessionStore((s) => {
    const id = s.activeSessionId;
    if (!id) return null;
    const snap = s.contextSnapshotBySession[id];
    // snapshot 缺席 = 「还不知道」，不是「占用 0%」—— ContextRing 的注释
    // 就是这么区分这两个状态的，这里沿用同一语义（不显示比显示 0% 诚实）。
    if (!snap || typeof snap.pct !== "number") return null;
    return Math.round(snap.pct);
  });
  if (pct === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-2 text-[length:var(--m-fs-caption)] text-[var(--m-text-muted)]">
      {pct}%
      {/* 【UI 重建 2026-10-28】进度条形状按截图：一个**实心蓝胶囊**夹在灰轨道里。
       * 截图放大后能看到：轨道约 24×8 css px、圆角全满，填充是纯 `#2a78d6`
       * 那种实蓝（不是渐变也不是细线）。
       *
       * 上一版是 `h-1.5 w-6` 的 2px 细条 —— 太细，在缩略图里根本看不出是进度。
       * 这里改成 26×7 的胶囊，填充同宽圆角。 */}
      <span className="relative h-[7px] w-[26px] overflow-hidden rounded-full bg-[var(--m-fill-ghost-selected)]">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--m-accent)]"
          style={{ width: `${Math.min(100, Math.max(4, pct))}%` }}
        />
      </span>
    </span>
  );
}

/** Connectors：MCP 服务器列表。
 *
 * ⚠️ MCP 不在 store 里 —— 它是 `api.mcp.list()` 的 RPC（`McpPanel` 用的同一个）。
 * 按硬规矩 7 用 `useRpc`，不手写 `await api.*` + loading/catch。
 *
 * 第一版读 `s.mcpServers`（猜的），store 上根本没有这个字段。**不要从 store
 * 读一个它不持有的东西。** */
function ConnectorRows() {
  const { data, loading } = useRpc(() => api.mcp.list({}), [], {
    // 右栏可能长期挂着，MCP 列表变化不频繁；读失败在这是「没有连接器」的
    // 正常分支（用户没配过），不值得每次弹 toast。
    toastOnError: false,
  });
  const servers = data?.servers ?? [];
  if (loading && servers.length === 0) {
    return (
      <Row muted>
        <span className="text-[length:var(--m-fs-caption)]">读取中…</span>
      </Row>
    );
  }
  if (servers.length === 0) {
    return (
      <Row muted>
        <span className="text-[length:var(--m-fs-caption)]">没有已连接的 MCP 服务器</span>
      </Row>
    );
  }
  return (
    <>
      {servers.slice(0, 4).map((srv) => (
        <Row
          key={srv.name}
          icon={
            <span className="flex size-4 items-center justify-center rounded-full border border-[var(--m-border-strong,rgba(0,0,0,.2))] text-[9px] leading-none">
              {srv.name.slice(0, 1).toUpperCase()}
            </span>
          }
        >
          {srv.name}
        </Row>
      ))}
      {servers.length > 4 && (
        <button
          type="button"
          className="w-fit text-[length:var(--m-fs-caption)] text-[var(--m-text-muted)] hover:text-[var(--m-text-secondary)]"
        >
          Show more
        </button>
      )}
    </>
  );
}

/** 空数组的**稳定引用**。
 *
 * ⚠️ zustand 的 selector 用 `Object.is` 比较返回值。在 selector 里写
 * `return []` 每次都是一个新数组 —— 引用每次不同 → store 认为「值变了」→
 * 触发重渲染 → selector 再跑 → 再返回新数组 → **无限循环**
 * （React error #185，实测把整个外壳打崩，57 个基线格全 DATA_MISSING）。
 *
 * 这不是理论问题：第一版就是这么写崩的。**selector 里任何对象/数组字面量
 * 都必须提到模块作用域**，除非它的内容真的每次都要重算。 */
const EMPTY_FILES: readonly string[] = [];

/** Outputs：本轮改动的文件。
 *
 * ⚠️ 数据源是 store 的 `turnFilesBySession[sessionId]`，元素类型
 * `TurnFileEntry`（`@contracts/runtime`）的 **`filePath`** —— 不是 `path`。
 * 第一版写了 `x.path`（猜的），并且用 `as unknown as` 把类型错误压住 ——
 * 那是把「我不确定」变成「编译器闭嘴」，运行时会静默空列表。
 *
 * 这里删掉所有 `as unknown as`：store 上有这个字段，直接读，让 tsc 守。 */
function OutputRows() {
  const files = useSessionStore((s) => {
    const id = s.activeSessionId;
    if (!id) return EMPTY_FILES;
    const list = s.turnFilesBySession[id];
    if (!list || list.length === 0) return EMPTY_FILES;
    // 注意：这里**仍然返回新数组**（map 的结果）。但它的依赖是 `list`
    // 本身的引用 —— 只有 turnFiles 真变了才会得到新引用，不会自激。
    // 「空的时候返回稳定常量」才是关键那一半：空 → 稳定 → 不再触发。
    return list.slice(0, 6).map((f) => f.filePath);
  });
  if (files.length === 0) {
    return (
      <Row muted>
        <span className="text-[length:var(--m-fs-caption)]">本轮还没有产物文件</span>
      </Row>
    );
  }
  return (
    <>
      {files.map((f) => (
        <Row key={f} icon={<DocumentIcon />}>
          <span title={f}>{f.split(/[\\/]/).pop()}</span>
        </Row>
      ))}
    </>
  );
}

/** Changes：本轮增删行数 + 不能用的 `Create PR`。
 *
 * **数据源与 Outputs 同一份**（`turnFilesBySession` 的 `adds` / `dels` 求和）。
 * 这是 Mcode 里唯一有真实增删行数的地方 —— GitPanel 用的是
 * `gitChangeVersionByRepo`（一个「变过几次」的版本号，**没有行数**）。
 *
 * 第一版读了一个不存在的 `s.gitDiffStat`。改这里之前先查了
 * `reduceGitChanged`：它只递增版本号，没有增删统计。**别再从那里取数。** */
function ChangesFooter() {
  // ⚠️ 两个 selector 各返回一个**数字**（原始值，`Object.is` 稳定），
  // 不返回对象 —— 返回 `{add, del}` 会每次都是新引用，与 `OutputRows` 同族的
  // 无限循环。第一版就是一个返回对象的 selector，它和 `return []` 一起
  // 把整个外壳打崩了（React #185）。
  const add = useSessionStore((s) => {
    const id = s.activeSessionId;
    const list = id ? s.turnFilesBySession[id] : undefined;
    if (!list) return 0;
    let n = 0;
    for (const f of list) n += f.adds ?? 0;
    return n;
  });
  const del = useSessionStore((s) => {
    const id = s.activeSessionId;
    const list = id ? s.turnFilesBySession[id] : undefined;
    if (!list) return 0;
    let n = 0;
    for (const f of list) n += f.dels ?? 0;
    return n;
  });
  const empty = add === 0 && del === 0;
  return (
    <div className="flex items-center justify-between pt-1">
      <span className="flex items-center gap-2 text-[length:var(--m-fs-caption)]">
        {empty ? (
          <span className="text-[var(--m-text-muted)]">本轮没有改动</span>
        ) : (
          <>
            <span className="text-[var(--m-fill-success,#009300)]">+{add.toLocaleString()}</span>
            <span className="text-[var(--m-fill-danger,#d03b3b)]">−{del.toLocaleString()}</span>
          </>
        )}
      </span>
      <button
        type="button"
        disabled
        title="Mcode 暂不支持从右栏创建 PR"
        className="rounded-[var(--radius-btn-xs)] border border-[var(--m-border-strong,rgba(0,0,0,.2))] px-2 py-1 text-[length:var(--m-fs-caption)] text-[var(--m-text-muted)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        Create PR
      </button>
    </div>
  );
}

/* ─────────────────────────── 图标（Phosphor 形） ─────────────────────────── */

function ChevronRight({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M1.8 4.2c0-.7.6-1.2 1.2-1.2h3l1.4 1.6h5.6c.7 0 1.2.6 1.2 1.2v6c0 .7-.6 1.2-1.2 1.2H3c-.7 0-1.2-.6-1.2-1.2V4.2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11.5" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 5.1v5.8M11.5 7.6c0 2-2 3-4.5 3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function DocumentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M9 1.8H4.5c-.7 0-1.2.6-1.2 1.2v10c0 .7.6 1.2 1.2 1.2h7c.7 0 1.2-.6 1.2-1.2V5.5L9 1.8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8.8 2v3.3h3.4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
