/**
 * 「新建子对话」选择器 —— 挂在「+」菜单里那一项后面(见 `AttachMenuButton`)。
 *
 * ## 三档,不能多也不能少
 *
 *  - **空白** —— 什么角色都不是的普通对话。就是右侧问答页签那个「新对话」,只是从这里
 *    也能开(而且开在当前会话下面)。
 *  - **档案** —— 挑一份代理档案当这个对话的角色(指令 = 每轮都带的角色提示词)。
 *  - **档案 + 记忆** —— 同上,另外把记忆库的一份快照随第一轮带进去。
 *
 * ⚠️ **「空白」和「不带记忆的档案」是两件事**,别把它们合成一个:
 * 空白是**没有任何指令**;后者是**有指令、只是不注记忆**。前者没有档案可选,后者要挑。
 *
 * ## 为什么档案是"第二级"而不是平铺进菜单
 *
 * 档案会很多(用户的每一份子 agent 配置都是一份)。平铺进「+」菜单会把菜单撑爆,而
 * 「新建子对话」本身又不是一个高频动作 —— 两级正好:先选**哪一档**,只有在选了后两档时
 * 才展开档案列表。这与「文献库」那个入口同款(都是"菜单一行 → 打开一个选择器")。
 *
 * ## 形态照抄 LibraryPicker
 *
 * 同一个锚点定位(贴「+」按钮向上展开)、同一条键盘处理(捕获阶段,免得被编辑器的按键
 * 处理吃掉)、同一套"点外部关闭"。差别只有两处:这里是**单选**(挑一份就开始建),以及
 * 记忆是一个**开关**(勾上之后再点档案 = 「档案+记忆」那一档)。
 *
 * ## 失败的每一条路都要说出来
 *
 * 档案列表拉不到(手机端 `webApi.ts` 对这个命名空间是**同步抛错**的 —— 见下面 effect 里
 * 那段)、建会话失败(档案被删了、没填指令),两种都不是"界面里少了点什么",而是**用户
 * 点了一下没有任何反应**。所以两处都有各自的红字,而且互不吞并。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { isSessionAgentProfile, agentProfileInstruction } from "@contracts/agentProfile";
import type { AgentProfile } from "@contracts/agentProfile";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { IconCheck, IconLoader2, IconSearch, IconUserStar } from "@renderer/lib/icons.js";

/** 用户选出来的那一件事。`profile` 为 null = 「空白」那一档。 */
export interface SubChatChoice {
  profile: AgentProfile | null;
  memory: boolean;
}

/** 一档选项：一份档案 + 要不要它的记忆。「空白」用 `profile: null` 表示。 */
interface Option {
  key: string;
  profile: AgentProfile | null;
  memory: boolean;
}

interface Props {
  open: boolean;
  /** 「+」按钮的位置 —— 贴着它向上展开(与 LibraryPicker 同款)。 */
  anchorRect: DOMRect | null;
  /** 挑完了。调用方负责真的建那个会话(见 sessionStore 的 `createSubChat`)。 */
  onPick: (choice: SubChatChoice) => void;
  onClose: () => void;
}

export function NewSubChatPicker({ open, anchorRect, onPick, onClose }: Props) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(false);
  /** 拉列表失败 —— 必须说出来。空列表和"读不到"在界面上长得一样,不能混。 */
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即拉一次 + 聚焦搜索框。**不缓存**:档案是磁盘上的文件,用户刚存的那一份就该
  // 在列表里(与模版选择器同一个判断)。
  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    setActiveIdx(0);
    setError(null);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    let cancelled = false;
    setLoading(true);
    // 包在 async IIFE 里而不是直接挂 `.then` —— 手机端的 web shim 对没有映射的命名空间是
    // **同步抛错**的(`webApi.ts` 的 unsupportedNamespace),而这个组件在手机端也够得到
    // (共用组件树,见 AppMobile → ChatPane)。直接 `.then` 会让异常逃出 effect,React 19
    // 会因此整棵卸载。try/catch 把它变成一条能看见的错误文案。
    void (async () => {
      try {
        const res = await api.workflow.agentProfiles();
        // 只留**能给对话当角色**的那些:类型对(见 `isSessionAgentProfile`)+ 真的有指令。
        // 没填指令的档案会列在这儿但点了建不出来,那种"点了没反应"最不该出现 —— 直接不列。
        if (!cancelled) {
          setProfiles(
            res.profiles.filter((p) => isSessionAgentProfile(p) && agentProfileInstruction(p).length > 0),
          );
        }
      } catch {
        if (!cancelled) setError(t("chat.newSubChat.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // t 不进依赖:locale 变了重拉一次列表是无意义的写(它只取文案)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * **选项 = 档案 × 有没有记忆**（2026-09-21 改）。
   *
   * ★ 用户：「这个记忆**不是勾选，而且选择**，同一个档案会有**不同的记忆的代理**」。
   *
   * 从前是"选档案 + 底下勾一个『带上长期记忆』"两个维度 —— 于是同一份档案只有**一条**
   * 选项，它在"带记忆 / 不带记忆"之间靠那个勾切换。用户要的是**两条平铺的选项**：
   * 「档案甲」和「档案甲（带记忆）」各占一行，**直接选，不勾**。
   *
   * 这也顺掉了底下那个开关（连同它的 Alt+M）—— 一维的东西不该有两个控件去表达。
   */
  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? profiles.filter(
          (p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
        )
      : profiles;
    const out: Option[] = [];
    // 「空白」—— 与档案并列的第一档，**只在没搜索词时给**（用户打字说明他在找某一份
    // 档案，不是想找空白）。它**没有"带记忆"那一档**：记忆是注给某个角色的背景说明，
    // 没有角色的对话不带它（`createSubChat` 也拦这一条）。
    if (!q) out.push({ key: "__blank__", profile: null, memory: false });
    for (const p of matched) {
      out.push({ key: `${p.id}:0`, profile: p, memory: false });
      out.push({ key: `${p.id}:1`, profile: p, memory: true });
    }
    return out;
  }, [profiles, query]);

  /** 可选项就是 `options` —— **顺序就是屏幕上看到的顺序**（那正是 `activeIdx` 的判据）。 */
  const optionCount = options.length;

  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, optionCount - 1)));
  }, [optionCount]);

  /**
   * 选一档。**只有这一个入口**（2026-09-21 改）。
   *
   * 从前有两个（`pickBlank` / `pickProfile`），因为「空白」的可用性要看那个记忆开关 ——
   * 现在记忆是**选项自己的一部分**（「空白」那档天然不带记忆），那个条件没有了，
   * 两条路收成一条。
   */
  const pickOption = (opt: Option) => {
    onPick({ profile: opt.profile, memory: opt.memory });
    onClose();
  };

  // 键盘:↑↓ 导航、回车选、Esc 关、Alt+M 切记忆开关。捕获阶段,免得被编辑器的按键处理吃掉。
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // （原来这里有个 Alt+M「切记忆开关」的快捷键。2026-09-21 连同那个开关一起去掉了
      //   —— 记忆现在是**平铺的一档选项**，直接选它就行，不需要一个修饰键去切。）
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.min(i + 1, optionCount - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const target = options[activeIdx];
        if (target) pickOption(target);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIdx, options, optionCount, onClose]);

  // 点外部关闭(与 LibraryPicker 同款:document mousedown + ref.contains)
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  /**
   * ⚠️ **左右都要夹一下**（2026-09-21）。
   *
   * 从前是 `left = anchorRect.left` —— 直接跟着锚点往右铺开。在**输入框上方**那个
   * 「+」那里没事（它在屏幕中间），但**右栏那个「+」贴着屏幕右缘**：一个 300~420 宽的
   * 面板从那儿往右展开，**一大半跑到屏幕外**，用户的原话是「弹出的框也页面外面看不到」。
   *
   * 夹取规则与同仓库别处一致（见 `ContextStatsPopover` / `SelectionQuoteMenu` 的
   * `left` 那两行）：两边各留 8px，窗口比面板窄时**以左边为准**（宁可右边溢出一点，
   * 也别让面板左边缘跑出屏幕 —— 用户从左边开始读）。
   */
  const width = Math.min(Math.max(anchorRect.width, 300), 420);
  const left = Math.min(
    Math.max(anchorRect.left, 8),
    Math.max(window.innerWidth - width - 8, 8),
  );

  /**
   * **向上生长，但撞到窗口顶上就改成向下**（2026-09-21）。
   *
   * ★ 用户报：「默认模式的时候，**还是会超出**，因为没有流程图，所以**太靠上面了**」。
   *
   * 从前是死死地"向上生长"（`translateY(-100%)`）—— 锚点在屏幕下半部时没问题，
   * 而**右栏那个「+」在默认模式下位置很靠上**（没有流程图那块把它顶下去），
   * 面板从那儿往上长就直接**越过了窗口顶**，内容看不见。
   *
   * 现在按可用空间择向：上面放得下就向上（贴着锚点），放不下就向下。
   * 高度上限也跟着可用空间走 —— 不然向下那一档可能又超出底部。
   */
  const PANEL_MAX_H = 320;
  const spaceAbove = anchorRect.top - 8;
  const spaceBelow = window.innerHeight - anchorRect.bottom - 8;
  const openUp = spaceAbove >= Math.min(PANEL_MAX_H, spaceBelow);
  const maxH = Math.max(120, Math.min(PANEL_MAX_H, openUp ? spaceAbove : spaceBelow));

  return (
    <div
      ref={rootRef}
      className="fixed z-[70] flex flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
      style={{
        left,
        width,
        maxHeight: maxH,
        // 向上：面板底边贴着锚点顶（`translateY(-100%)`）；向下：顶边贴着锚点底。
        ...(openUp
          ? { top: anchorRect.top - 8, transform: "translateY(-100%)" }
          : { top: anchorRect.bottom + 8 }),
      }}
    >
      <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1">
        <IconSearch size={12} className="shrink-0 text-content-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("chat.newSubChat.searchPlaceholder")}
          className="h-6 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content-subtle"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {/* 一列平铺的选项：**每份档案占两行**（不带记忆 / 带记忆），外加最上面那档
            「空白」。见 `options` 那段注释 —— 记忆从"一个勾"变成了"选项自己的一部分"。 */}
        {loading ? (
          <div className="flex items-center justify-center gap-1.5 px-3 py-4 text-[12px] text-content-subtle">
            <IconLoader2 size={12} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-center text-[12px] text-red-500">{error}</div>
        ) : options.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-content-subtle">
            {profiles.length === 0 ? (
              <>
                <div>{t("chat.newSubChat.noProfiles")}</div>
                {/* 空的时候告诉用户去哪儿加 —— 否则这里就是一条死路 */}
                <div className="mt-1 text-[11px] opacity-80">{t("chat.newSubChat.noProfilesHint")}</div>
              </>
            ) : (
              t("chat.newSubChat.noMatch")
            )}
          </div>
        ) : (
          options.map((opt, idx) => {
            const isBlank = opt.profile === null;
            const active = idx === activeIdx;
            return (
              <button
                key={opt.key}
                type="button"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pickOption(opt)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  active ? "bg-surface-muted text-content" : "text-content-muted",
                )}
                title={
                  isBlank
                    ? t("chat.newSubChat.blankHint")
                    : opt.memory
                      ? `${opt.profile?.description || opt.profile?.name} · ${t("chat.newSubChat.memoryHint")}`
                      : (opt.profile?.description || opt.profile?.name)
                }
              >
                {/* 图标记：空白用「什么都没有」，档案用那颗星。 */}
                {isBlank ? (
                  <span className="w-3.5 shrink-0" />
                ) : (
                  <IconUserStar size={13} className="shrink-0 opacity-80" />
                )}
                <span className={cn("min-w-0 flex-1 truncate", isBlank && "font-medium")}>
                  {isBlank ? t("chat.newSubChat.blank") : opt.profile?.name}
                </span>
                {/* **记忆是这一行自己的事**（不是上面一个勾）—— 带记忆的那一档把
                    标签亮出来，不带的那一档什么都不写（它是默认态）。 */}
                {opt.memory && (
                  <span className="shrink-0 text-[10px] text-accent">
                    {t("chat.newSubChat.withMemory")}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
