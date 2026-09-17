/**
 * 输入框上方的「输入选项」下拉框 —— 主代理节点参数里那张条目表在聊天侧的出口。
 *
 * ## 它是什么
 *
 * 用一张图聊天时,输入框上方会出现这一行(**文献检索的固定条件条**同一个位置):
 * 点开是主代理节点「输入选项」参数里配的那些条目。选中一项,**内容**插进输入框
 * 光标处(和内容标签展开是同一个 `insertText`),**解释**随这次运行进提示词
 * (主进程在起运行时读,见 `orchestration/runner.ts`)。
 *
 * ## 数据从哪来
 *
 * 选项表长在**这份工作流文档**的主代理节点参数上(`workflow.get` 拉全文 —— 列表
 * 接口不带 nodes),选中项存在 settings 表(`WORKFLOW_NODE_OPTION_SETTING_PREFIX`
 * + workflowId,按工作流分键)。工作流一换就重读一遍:改完设置回到对话,这里该是
 * 刚改过的那一份;没有有名选项(内置六个全是提示词型,没有图)整行不渲染。
 *
 * ⚠️ 读不到就当没有,**绝不让它把输入框区域弄挂**:web shim 里没有这些命名空间,
 * 而访问未知命名空间是**同步抛**的(见 `lib/webApi.ts` 文件头)—— try/catch 不能省。
 */
import { useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { MAIN_NODE_TYPE_ID, NODE_OPTIONS_PARAM_KEY } from "@contracts/nodeType";
import { WORKFLOW_NODE_OPTION_SETTING_PREFIX } from "@contracts/ipc";
import type { WorkflowDoc } from "@contracts/workflow";
import { IconCheck, IconChevronDown, IconCircleOff, IconListCheck } from "@renderer/lib/icons.js";

/** 选项在聊天侧的一行。主行显示 `name`,副行显示 `note` —— 解释本是给模型的,
 *  给用户看是"选它会发生什么"的预告,不是多余的装饰。 */
interface OptionRow {
  name: string;
  content: string;
  note: string;
}

/** 从文档的主代理节点参数袋里读出选项表。与 `ParamField` 的 `optionRows` 同一条
 *  读法(容忍半行),但菜单只显示**有名**的 —— 名字是这一项在菜单上的存在本身。 */
function optionRows(doc: WorkflowDoc | null): OptionRow[] {
  const main = doc?.nodes.find((node) => node.type === MAIN_NODE_TYPE_ID);
  const raw = main?.params[NODE_OPTIONS_PARAM_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): OptionRow => {
      const row = (typeof item === "object" && item !== null ? item : {}) as {
        name?: unknown;
        content?: unknown;
        note?: unknown;
      };
      return {
        name: typeof row.name === "string" ? row.name : "",
        content: typeof row.content === "string" ? row.content : "",
        note: typeof row.note === "string" ? row.note : "",
      };
    })
    .filter((row) => row.name.length > 0);
}

export function NodeOptionsDropdown({
  workflowId,
  onPick,
}: {
  workflowId: string;
  /** 选中一项后把它的内容插进输入框光标处 —— 插入是 ChatPane 的事(它才有编辑器)。 */
  onPick: (content: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);

  /** 主代理的选项表;`null` = 还没读到。空表整行不渲染。 */
  const [rows, setRows] = useState<OptionRow[] | null>(null);
  /** 当前选中的选项名("" = 没选)。读自 / 写向 settings 表,按 workflowId 分键。 */
  const [selected, setSelected] = useState("");

  useEffect(() => {
    let cancelled = false;
    // 先清掉旧工作流的显示:新文档还没到,带着旧选项站一会儿是"界面在说假话"。
    setRows(null);
    setSelected("");
    void (async () => {
      try {
        const [docRes, selRes] = await Promise.all([
          api.workflow.get({ id: workflowId }),
          api.setting.get({ key: WORKFLOW_NODE_OPTION_SETTING_PREFIX + workflowId }),
        ]);
        if (cancelled) return;
        setRows(optionRows(docRes.workflow));
        try {
          const parsed = JSON.parse(selRes.value ?? "") as { name?: unknown };
          if (parsed && typeof parsed.name === "string") setSelected(parsed.name);
        } catch {
          // 坏值/空串 = 没选,保持初值。
        }
      } catch {
        // 手机端 web shim:没有这些命名空间,访问即同步抛(见文件头)。当没有可选项。
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  /** 选中一项(null = 清除)。设置先落、内容后插 —— 主进程在**每次运行起跑那刻**
   *  读这个键,把解释拼进运行最初那条提示词(一次,之后不再重复;见
   *  `orchestration/runner.ts`)。这里只负责把选择落盘,没有别的账要记。 */
  const pick = (row: OptionRow | null): void => {
    setSelected(row?.name ?? "");
    void api.setting
      .set({
        key: WORKFLOW_NODE_OPTION_SETTING_PREFIX + workflowId,
        value: row ? JSON.stringify({ name: row.name, note: row.note }) : "",
      })
      .catch(() => {
        // web shim 存不了;插入照常,只是下次打开不记得。
      });
    if (row) onPick(row.content);
  };

  if (!rows || rows.length === 0) return null;
  const current = rows.find((row) => row.name === selected);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-edge px-2.5 pt-1.5">
      <span className="flex shrink-0 items-center gap-1 text-[0.7857em] text-content-subtle">
        <IconListCheck size={12} />
        {t("chat.nodeOptions.title")}
      </span>
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          // 样式对齐旁边那条检索条件条的原生 select(同一行里的两个控件该长得像)。
          className="flex items-center gap-1 rounded border border-edge bg-surface/40 px-1.5 py-0.5 text-[0.7857em] text-content-muted outline-none hover:text-content focus:border-accent"
          title={current ? `${current.name}${current.note ? ` — ${current.note}` : ""}` : undefined}
        >
          <span className="max-w-[200px] truncate">
            {current ? current.name : t("chat.nodeOptions.none")}
          </span>
          <IconChevronDown size={11} className="shrink-0 opacity-60" />
        </Menu.Trigger>
        <Menu.Portal>
          {/* z-50 放 Positioner 上 —— 理由见 WorkflowDropdown 的同一段注释。 */}
          <Menu.Positioner side="top" align="start" sideOffset={4} className="z-50">
            <Menu.Popup
              ref={popupRef}
              className="min-w-[220px] rounded-lg border border-edge bg-surface py-1 shadow-2xl origin-bottom-left data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 transition-[transform,opacity] duration-100"
            >
              {rows.map((row) => {
                const active = row.name === selected;
                return (
                  <Menu.Item
                    key={row.name}
                    onClick={() => pick(row)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left outline-none select-none data-[highlighted]:bg-surface-muted"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] font-medium">{row.name}</span>
                      {row.note && (
                        <span className="text-[11px] leading-snug text-content-subtle">
                          {row.note}
                        </span>
                      )}
                    </span>
                    {active && <IconCheck size={14} className="shrink-0 text-accent" />}
                  </Menu.Item>
                );
              })}
              {/* 「清除选择」独立成项、带分隔线:它和上面那些不是一类 —— 上面是
                  "选哪个",它是"回到没选"。没选时点了是无害的空操作。 */}
              <Menu.Separator className="my-1 h-px bg-edge" />
              <Menu.Item
                onClick={() => pick(null)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
              >
                <IconCircleOff size={13} className="shrink-0 opacity-70" />
                {t("chat.nodeOptions.clear")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
