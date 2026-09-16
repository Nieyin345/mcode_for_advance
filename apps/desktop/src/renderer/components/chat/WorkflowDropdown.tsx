/**
 * 输入框的「工作流」选择器 —— 药丸工具栏里的一段，点开是工作流库的清单。
 *
 * ## 列的是**整个库**
 *
 * 六个内置打底（`workflow.list` 由主进程按内置优先排好），下面是用户自建的那些。
 * 每次打开菜单重新读一遍：在设置里改完工作流回到对话，这里应该是刚改过的那一份。
 *
 * ⚠️ **读不到就退回内置六个**，绝不让下拉变空：手机端的 web shim 里没有这个命名
 * 空间，而访问未知命名空间是**同步抛**的（见 `lib/webApi.ts` 文件头）—— 所以那
 * 一段必须是 `try/catch`，直接挂 `.then` 会让 React 19 把整棵树卸载。
 *
 * ## 内置的名字走 i18n，自建的用自己起的名字
 *
 * 都在 `lib/workflowLabels.tsx`（整个渲染端只此一份）。一个认不出的 id（库读不到
 * 时的自建 id、或者刚被删掉的那个）**原样显示它自己**，不冒充「默认」—— 后者是
 * 「界面在说假话」。
 *
 * ## 状态归谁
 *
 * 工作流**跟着会话走**（像模型选择），所以状态在 `sessionStore.workflowId`，
 * 持久化在 `sessions.composer_mode` 列上（列名是历史遗留 —— 值就是工作流 id，
 * 内置六个沿用旧值，所以那次改名不需要任何迁移）。这里只是它的一个视图 ——
 * 组件本身不存任何状态，除了菜单开合和刚读到的那份库清单。
 *
 * ## 与既有控件的对齐
 *
 * 药丸里的触发器逐字照抄 `ModelDropdown` 的 pill 分支（`composer-minipill-seg`
 * + `composer-lblwrap` 标签壳，后者负责在药丸变窄时把文字收掉）；菜单项与弹层
 * 照抄 `WorktreeModeChip`。两层布局（pill / row）与那两个控件同构：折叠宿主
 * （侧聊面板、手机壳）走 `layout="row"`。
 *
 * ⚠️ `.composer-minipill-seg` 是无 layer 的 CSS，会压过 Tailwind 的颜色类 ——
 * 非默认模式要高亮成强调色，只能走内联 `style`（`ModelDropdown` 同一个坑）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useNarrowViewport } from "@renderer/hooks/useNarrowViewport.js";
import { BUILTIN_WORKFLOW_IDS } from "@contracts/runtime";
import type { WorkflowListEntry } from "@contracts/workflow";
import {
  BUILTIN_WORKFLOW_HINT as HINT_KEY,
  BUILTIN_WORKFLOW_LABEL as LABEL_KEY,
  workflowDisplayDescription,
  workflowDisplayName,
  workflowIcon,
} from "@renderer/lib/workflowLabels.js";
import { IconCheck, IconChevronRight } from "@renderer/lib/icons.js";

export function WorkflowDropdown({ layout = "pill" }: { layout?: "pill" | "row" }) {
  const { t, locale } = useI18n();
  const stacked = layout === "row";
  const cascade = stacked && !useNarrowViewport();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);

  const currentId = useSessionStore((s) => s.workflowId);
  const setWorkflowId = useSessionStore((s) => s.setWorkflowId);

  /** 工作流库。**null = 没读到**(还没读 / 这个壳里没有这条 RPC)。那时退回内置六个 ——
   *  选择器不该因为读不到库而变空。 */
  const [library, setLibrary] = useState<WorkflowListEntry[] | null>(null);

  // 每次**打开菜单时**重新读一遍,而不是挂载时读一次:改完工作流回到对话里,下拉里
  // 应该是刚改过的那一份。挂载时读还得在"设置里新建了"之后靠别的事件去失效它。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.workflow.list();
        if (!cancelled) setLibrary(res.workflows);
      } catch {
        // 手机端的 web shim 里没有这个命名空间,而**访问未知命名空间是同步抛的**
        // (见 `lib/webApi.ts` 文件头)—— 所以这里必须是 try/catch,直接挂 `.then`
        // 会让 React 19 把整棵树卸载(输入框整个消失)。读不到就退回内置六个。
        if (!cancelled) setLibrary(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const options = useMemo(() => {
    if (library) {
      // **自动化不进这个选择器。** 它挑的是"这次对话按哪条流程走",而自动化不是一条
      // 跟着对话走的流程 —— 它等一个事件自己跑(见 `@contracts/workflow`)。列在这里
      // 会让人以为选中它就会在本轮跑起来,而那个触发条件在这次对话里根本不会发生。
      // 判据用 `trigger`(和库里分栏用的是同一个字段,见 `workflowView.purposeOf`)。
      return library
        .filter((entry) => !entry.trigger)
        .map((entry) => ({
          value: entry.id,
          label: workflowDisplayName(entry, locale),
          hint: workflowDisplayDescription(entry, locale),
        }));
    }
    return BUILTIN_WORKFLOW_IDS.map((value) => ({
      value,
      label: t(LABEL_KEY[value]),
      hint: t(HINT_KEY[value]),
    }));
  }, [library, locale, t]);

  // 认不出的 id(库读不到时的自建 id、或者刚被删掉的那个)显示它自己,不冒充「默认」。
  const current = options.find((o) => o.value === currentId) ?? {
    value: currentId,
    label: currentId,
    hint: "",
  };

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        className={cn(
          stacked
            ? "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100 text-content-muted hover:bg-surface-muted hover:text-content"
            : "composer-minipill-seg",
        )}
        // 非默认模式 = 这个会话正处在某个工作模式下，值得一眼看见。
        style={!stacked && currentId !== "default" ? { color: "rgb(var(--accent))" } : undefined}
        title={t("composer.mode.title")}
      >
        {stacked ? (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 opacity-80">{workflowIcon(currentId, 14)}</span>
              <span className="shrink-0 font-medium text-content">{t("composer.mode.rowLabel")}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1">
              <span
                className={cn(
                  "min-w-0 truncate text-xs",
                  currentId !== "default" ? "text-accent" : "text-content-muted",
                )}
              >
                {current.label}
              </span>
              <IconChevronRight size={12} className="shrink-0 opacity-60" />
            </span>
          </>
        ) : (
          <>
            <span className="shrink-0 opacity-80">{workflowIcon(currentId, 13)}</span>
            {/* composer-lblwrap 是药丸变窄时收掉标签的那个壳 —— 少了它，
                data-compact="1" 下会残留一个缺口（旧的检索开关就是这个毛病）。 */}
            <span className="composer-lblwrap">
              <span className="max-w-[72px] truncate">{current.label}</span>
            </span>
          </>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        {/* z-50 放在 Positioner 上：floating-ui 用 transform 定位，会在 Popup 那层
            造出新的层叠上下文，只给 Popup 加 z-50 会输给中央面板的 z-10。 */}
        <Menu.Positioner
          side={cascade ? "right" : "top"}
          align="start"
          sideOffset={cascade ? 6 : 4}
          className="z-50"
        >
          <Menu.Popup
            ref={popupRef}
            className={cn(
              "min-w-[260px] rounded-lg border border-edge bg-surface py-1 shadow-2xl",
              cascade ? "origin-top-left" : "origin-bottom-left",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            {options.map((opt) => {
              const active = opt.value === currentId;
              return (
                <Menu.Item
                  key={opt.value}
                  onClick={() => setWorkflowId(opt.value)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    active ? "text-accent" : "text-content-muted",
                  )}
                >
                  <span className="flex min-w-0 items-start gap-2">
                    <span className="mt-px shrink-0 opacity-90">{workflowIcon(opt.value, 13)}</span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] font-medium">{opt.label}</span>
                      <span className="text-[11px] leading-snug text-content-subtle">
                        {opt.hint}
                      </span>
                    </span>
                  </span>
                  {active && <IconCheck size={14} className="shrink-0" />}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

