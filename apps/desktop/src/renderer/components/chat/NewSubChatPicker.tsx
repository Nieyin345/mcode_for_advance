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
 * 才展开档案列表。这与「文献库」「模版」两个入口同款(都是"菜单一行 → 打开一个选择器")。
 *
 * ## 形态照抄 TemplatePicker
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

interface Props {
  open: boolean;
  /** 「+」按钮的位置 —— 贴着它向上展开(与 LibraryPicker / TemplatePicker 同款)。 */
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
  const [withMemory, setWithMemory] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即拉一次 + 聚焦搜索框。**不缓存**:档案是磁盘上的文件,用户刚存的那一份就该
  // 在列表里(与模版选择器同一个判断)。
  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    setActiveIdx(0);
    setError(null);
    setWithMemory(false);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
    );
  }, [profiles, query]);

  /** 键盘导航的可选项 = 「空白」+ 过滤后的档案。顺序就是屏幕上看到的顺序。
   *
   *  `withBlank = false` 时「空白」那一行**不渲染**(搜索词把用户带到了某一份档案上)——
   *  于是它也不该占一个 `activeIdx` 位,否则 ↓ 会先跳到一个看不见的行上。 */
  const withBlank = query.trim().length === 0;
  const optionCount = (withBlank ? 1 : 0) + filtered.length;

  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, optionCount - 1)));
  }, [optionCount]);

  /** 「空白」= 什么角色都不是。**勾了记忆时这一档关掉** —— 记忆是"注给某个角色"的
   *  背景说明,没有角色的对话不带它(stores 的 `createSubChat` 也是这么拼请求的:
   *  `choice.profile && choice.memory` 才发 memory)。
   *
   *  ⚠️ 与其让它"能按、按了悄悄把那个勾丢掉",不如**按不动并说明原因** —— 后者才是
   *  用户嘴里的「点了没反应」。键盘那条路(回车)也要挡住,所以拦在这个函数里而不是
   *  只写在按钮的 `disabled` 上。 */
  const pickBlank = () => {
    if (withMemory) return;
    onPick({ profile: null, memory: false });
    onClose();
  };

  const pickProfile = (profile: AgentProfile) => {
    onPick({ profile, memory: withMemory });
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
      // 记忆开关的快捷键。**与那一行上显示的提示一致** —— 提示里写什么键,这里就得响应
      // 什么键(不然那行字是在骗人)。Alt+M 而不是 Tab:Tab 在这个界面里是"跳到下一个
      // 可聚焦元素",抢掉它在无障碍上是负数,而这个面板本来就在捕获阶段收按键。
      if (e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        e.stopPropagation();
        setWithMemory((v) => !v);
        return;
      }
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
        const offset = withBlank ? 1 : 0;
        if (activeIdx < offset) {
          pickBlank();
          return;
        }
        const target = filtered[activeIdx - offset];
        if (target) pickProfile(target);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIdx, withBlank, filtered, optionCount, withMemory, onClose]);

  // 点外部关闭(与 LibraryPicker / TemplatePicker 同款:document mousedown + ref.contains)
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

  const left = anchorRect.left;
  const width = Math.min(Math.max(anchorRect.width, 300), 420);

  return (
    <div
      ref={rootRef}
      className="fixed z-[70] flex max-h-80 flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
      style={{
        left,
        width,
        top: Math.max(8, anchorRect.top - 8),
        // 从锚点向上生长 —— 与 LibraryPicker / TemplatePicker 一致(输入框在屏幕底部)
        transform: "translateY(-100%)",
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
        {/* 「空白」—— 与「档案」并列的第一档。**不参与搜索**:它是"什么都不要"的意思,
            用户打字说明他在找某一份档案,不是想找空白。
            勾了记忆时**关掉**(见 `pickBlank` 上那段)—— 文案换成那句解释,而不是让
            用户对着一个能按但不会有记忆的按钮猜。 */}
        {withBlank && (
          <button
            type="button"
            onMouseEnter={() => setActiveIdx(0)}
            onClick={pickBlank}
            disabled={withMemory}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors",
              withMemory
                ? "cursor-not-allowed text-content-subtle opacity-50"
                : activeIdx === 0
                  ? "bg-surface-muted text-content"
                  : "text-content-muted",
            )}
            title={
              withMemory ? t("chat.newSubChat.blankNoMemory") : t("chat.newSubChat.blankHint")
            }
          >
            <span className="w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">{t("chat.newSubChat.blank")}</span>
            <span className="shrink-0 text-[11px] text-content-subtle">
              {withMemory ? t("chat.newSubChat.blankNoMemory") : t("chat.newSubChat.blankHint")}
            </span>
          </button>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-1.5 px-3 py-4 text-[12px] text-content-subtle">
            <IconLoader2 size={12} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-center text-[12px] text-red-500">{error}</div>
        ) : filtered.length === 0 ? (
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
          <>
            <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-content-subtle">
              {t("settings.workflows.tabProfiles")}
            </div>
            {filtered.map((p, i) => {
              const idx = i + (withBlank ? 1 : 0);
              return (
                <button
                  key={p.id}
                  type="button"
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => pickProfile(p)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors",
                    idx === activeIdx ? "bg-surface-muted text-content" : "text-content-muted",
                  )}
                  title={p.description || p.name}
                >
                  <span className="w-3.5 shrink-0">
                    {withMemory && <IconCheck size={12} className="text-accent" />}
                  </span>
                  <IconUserStar size={13} className="shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {withMemory && (
                    <span className="shrink-0 text-[10px] text-accent">
                      {t("chat.newSubChat.withMemory")}
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* 记忆开关。**不随搜索隐藏**:它是对"接下来选的那一份档案"的修饰,不是列表的一部分。
          放在列表**下面**而不是上面:它修饰的是下一次点击,贴着那一列档案比盖在它们头上更顺。 */}
      <div className="border-t border-edge px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setWithMemory((v) => !v)}
          title={t("chat.newSubChat.memoryHint")}
          className="flex w-full items-center gap-2 text-left text-[11px] text-content-muted hover:text-content"
        >
          <span
            className={cn(
              "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border",
              withMemory ? "border-accent bg-accent text-surface" : "border-edge",
            )}
          >
            {withMemory && <IconCheck size={10} />}
          </span>
          <span className="min-w-0 flex-1 truncate">{t("chat.newSubChat.memoryOn")}</span>
          {/* 快捷键提示 —— 与上面 keydown 里响应的那个键**必须**是同一个。 */}
          <kbd className="shrink-0 rounded border border-edge px-1 text-[10px] tabular-nums opacity-60">
            {t("chat.newSubChat.memoryKey")}
          </kbd>
        </button>
      </div>
    </div>
  );
}
