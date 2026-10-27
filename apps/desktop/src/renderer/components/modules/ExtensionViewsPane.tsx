/**
 * 【UI 重建 2026-10-28】**扩展视图**（右栏 `mcpapp` tile / `extensions` 页签）。
 *
 * ## 为什么需要它
 *
 * 这个 tile 的位置此前被**命名撞车**占了：`browser` 页签曾被接到 `mcpapp` 上，
 * 而 `mcpapp` 的原义是「扩展贡献的视图」。两者共用一个 tile 时，接哪一个，
 * 另一个就再也找不到入口 —— 事实是接成浏览器之后，**扩展视图在右栏彻底
 * 没有入口了**（用户装了扩展，却在当前外壳里找不到它）。
 *
 * 现在拆开：`browser` 页签 → `browser` tile → `BrowserPane`；
 * `extensions` 页签 → `mcpapp` tile → **本文件**。
 *
 * ## 数据从哪来
 *
 * `api.modules.theiaInstalled({ op: "webviewList" })` —— 与 `TheiaWebviewHost`
 * 读的是**同一个 RPC**（硬规矩 2：共享实现只有一份）。那个宿主负责把
 * webview 真正渲染出来（iframe + 消息桥），本文件只负责**列出有哪些视图**
 * 并给一个「去装/去开」的出口。
 *
 * ⚠️ **不复制 webview 渲染逻辑。** 这里只列条目 + 跳转；真正的渲染仍由
 * `TheiaWebviewHost` 在全局层承担（它已经挂在 `App.tsx`）。
 * 在右栏再嵌一层 iframe 会得到两个 `postMessage` 源竞争同一个 webview id。
 *
 * ## 空态
 *
 * 没有扩展视图时**不显示空白** —— 给出明确的下一步（去设置里装）。
 * 这是硬规矩 7：空态先看 `components/ui/`，且要说清「为什么空、下一步做什么」。
 */
import { useRpc } from "@renderer/hooks/useRpc.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { EmptyState, Spinner } from "@renderer/components/ui/index.js";

/** `theiaInstalled` 在 `webviewList` 下返回的条目形状。
 *
 *  **只声明本文件真正读的字段** —— 主进程那边这份结构更宽（还带 iframe 的
 *  html、消息队列等），但那些由 `TheiaWebviewHost` 消费，不在这里重复。 */
interface ExtensionViewItem {
  /** webview 的唯一 id（宿主用它做 key 与消息路由）。 */
  id?: string;
  /** 显示标题 —— VS Code webview 的 `title`。 */
  title?: string;
  /** 来源扩展 id（`publisher.name`），用来区分同名视图。 */
  extensionId?: string;
}

export function ExtensionViewsPane() {
  /* ⚠️ `toastOnError: false`：扩展系统在没装任何扩展时**本来就会**
   * 返回空/失败（web 渲染端与旧运行时没有 VSIX webview，见
   * `TheiaWebviewHost` 的 `catch`）。那不是错误，是正常空态。 */
  const { data, loading, error } = useRpc(
    () => api.modules.theiaInstalled({ op: "webviewList" }),
    [],
    { toastOnError: false },
  );
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  const items: ExtensionViewItem[] =
    data && data.kind === "webviews" ? (data.items as unknown as ExtensionViewItem[]) : [];

  if (loading && items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (items.length === 0) {
    /* 空态三种情况必须分开说（否则用户不知道该做什么）：
     *   - 有 error：扩展系统没起来（Theia 运行时未就绪）；
     *   - 没 error 但也没条目：装了扩展，但它的贡献点里没有 webview 视图；
     *   - 根本没有扩展。
     * 三者的下一步完全不同，混成一句「没有视图」等于什么都没说。 */
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          title="没有扩展视图"
          desc={
            error
              ? "扩展运行时未就绪。装好并启用扩展后，它贡献的视图会出现在这里。"
              : "已装扩展里没有贡献视图的。到设置 → 扩展里安装或启用。"
          }
          action={
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded-[var(--radius-btn-xs)] border border-[var(--m-border-strong)] px-3 py-1.5 text-[length:var(--m-fs-body)] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]"
            >
              打开扩展设置
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div data-cds="ExtensionViews" className="flex h-full flex-col gap-1 overflow-y-auto p-2">
      {items.map((it, i) => {
        const key = it.id ?? `${it.extensionId ?? "ext"}-${i}`;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={it.extensionId ? `${it.title ?? it.id} · ${it.extensionId}` : (it.title ?? it.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-[var(--radius-btn-xs)] px-2 py-1.5 text-left",
              "text-[length:var(--m-fs-body)] text-[var(--m-text-secondary)]",
              "hover:bg-[var(--m-fill-ghost-hover)] active:bg-[var(--m-fill-ghost-selected)]",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{it.title ?? it.id ?? "（未命名视图）"}</span>
            {it.extensionId ? (
              <span className="shrink-0 truncate text-[length:var(--m-fs-caption)] text-[var(--m-text-muted)]">
                {it.extensionId}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
