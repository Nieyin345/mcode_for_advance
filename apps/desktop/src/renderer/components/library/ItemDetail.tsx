/**
 * 右栏:文献详情。
 *
 * 详情面板的第一职责不是展示元数据,而是回答**「这篇能不能读、不能读要做什么」**。
 * 所以 PDF 状态与对应动作(PDF 地址解析失败时的说明、登录过期时的「去登录」)
 * 放在最上方,元数据在下面。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryItem, LibraryLinkView, LibraryCollection } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";import { api } from "@renderer/lib/api.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconExternalLink,
  IconEyeOff,
  IconFolderOpen,
  IconLoader2,
  IconPlus,
  IconX,
} from "@renderer/lib/icons.js";
import { PdfBadge, fileStateOf } from "./ItemList.js";
import { ItemNotes } from "./ItemNotes.js";
import { LibraryPicker } from "@renderer/components/chat/LibraryPicker.js";

interface Props {
  item: LibraryItem | null;
  /** 条目被改过(比如刚挂上一份本地 Markdown)—— 让列表重新拉一次。 */
  onChanged?: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <div className="w-20 shrink-0 text-[0.7857em] text-content-subtle">{label}</div>
      <div className="min-w-0 flex-1 break-words text-xs text-content">{children}</div>
    </div>
  );
}

/**
 * 条目的基础字段表(来源地址 / 语言)。
 *
 * 学术那一栏(作者 / 年份 / 期刊 / 卷期页 / DOI / arXiv / 许可)与三种引用格式随
 * 2026-09-27 的清理一起退役 —— 那些是外部 MCP / 自动化的事。
 *
 * **导出**是因为左栏右键那个「条目信息」浮窗要复用同一份 —— 两处必须长得一样。
 */
export function ItemMetadata({ item }: { item: LibraryItem }) {
  const { t } = useI18n();
  const openUrlInBrowser = useSessionStore((s) => s.openUrlInBrowser);
  if (!item.url && !item.language) return null;
  return (
    <div>
    <div className="mb-2 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
      {t("library.detail.meta")}
    </div>
    <div className="divide-y divide-edge/40">
      {item.url && (
        <Field label={t("library.detail.url")}>
          <button
            onClick={() => openUrlInBrowser(item.url!)}
            className="inline-flex max-w-full items-center gap-1 text-accent hover:underline"
          >
            <span className="truncate">{item.url}</span>
            <IconExternalLink size={11} />
          </button>
        </Field>
      )}
      {item.language && <Field label={t("library.detail.language")}>{item.language}</Field>}
    </div>
    </div>
  );
}

/**
 * 「关联」区 —— 这一条和别的条目之间挂着的线。
 *
 * ## 双向展示,但存储只存一行
 *
 * 数据是一对多、单向存的(见 `contracts/library.ts` 的 `LibraryItemLink`)。这里两个
 * 方向都列:用户给 A 挂了 B,打开 B 的时候也该看到"它被 A 关联着" —— 否则他会在 B 上
 * 再挂一次 A,而那是同一条关系的另一头。主进程的 `viewsOf` 已经把"另一头是谁"算好了
 * (含方向),这里只管画。
 *
 * ## 被屏蔽的**照样显示**,只是灰掉并说明原因
 *
 * 用户明确要屏蔽是硬过滤(挂不上),但**看得见**是另一回事:一条关联从列表里凭空消失,
 * 用户会以为是关联丢了、回头再挂一次。所以这里把屏蔽原因摆出来 —— 「它存在,只是被
 * 挡了」比"什么都没有"好排查得多。
 */
export function ItemLinks({ item, onChanged }: { item: LibraryItem; onChanged?: () => void }) {
  const { t } = useI18n();
  const [links, setLinks] = useState<LibraryLinkView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 选择器的开关与锚点 —— 复用「+ → 添加文献库到上下文」那个选择器。 */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const reloadRequest = useRef(0);
  const currentItemId = useRef(item.id);
  currentItemId.current = item.id;

  /** #11:「转录 md + 图床」与本条是一个整体 —— 在关联区把它说出来。 */
  const [mdBundle, setMdBundle] = useState<{ title: string; imageCount?: number } | null>(null);

  // 转录产物不在关联表里(它随条目一起走,没有单独的开关 —— 见 contracts 里
  // `LibraryDeletePreviewLink` 的 `transcript` 那一档),但用户在关联区看不到它,
  // 就会以为"图床不知道挂在哪"。这里**复用删除预览的口径**(同一份实现,不再自己
  // 算一遍),把它作为一行说明摆出来。拉不到就不显示:它只是补充说明,不该挡住
  // 关联列表本身。
  useEffect(() => {
    let cancelled = false;
    setMdBundle(null);
    void api.library
      .deletePreview({ ids: [item.id] })
      .then((res) => {
        if (cancelled) return;
        const transcript = (res.entries[0]?.links ?? []).find((l) => l.form === "transcript");
        if (transcript) {
          setMdBundle({
            title: transcript.title,
            ...(transcript.imageCount !== undefined ? { imageCount: transcript.imageCount } : {}),
          });
        }
      })
      .catch(() => {
        /* 只是补充说明,拉不到就不显示 —— 关联列表自己的错误另有一条通道 */
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  const reload = useCallback(async () => {
    // An earlier item's response (or an older refresh of this item) cannot
    // populate the newly selected item's detail pane.
    if (currentItemId.current !== item.id) return;
    const request = ++reloadRequest.current;
    try {
      const res = await api.library.linksOf({ itemId: item.id });
      if (request !== reloadRequest.current || currentItemId.current !== item.id) return;
      setLinks(res.links);
      setError(null);
    } catch (err) {
      if (request === reloadRequest.current && currentItemId.current === item.id) {
        setError((err as Error).message);
      }
    }
  }, [item.id]);

  useEffect(() => {
    setLinks(null);
    setError(null);
    void reload();
    return () => { ++reloadRequest.current; };
  }, [reload]);

  const remove = async (linkId: string) => {
    if (!window.confirm(t("library.links.removeConfirm"))) return;
    setBusy(true);
    try {
      await api.library.linkRemove({ linkId });
      await reload();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 选择器确认 —— 选中的可能是分类、也可能是单独一篇(键 `c:` / `i:`)。
   *
   * **只接 `i:`**:关联的目标必须是"另一条条目"。用户挑了个分类的话,那不是一个可以
   * 挂关联的对象(关联是条目对条目),所以这里逐个提示而不是静默丢掉 —— 他点了没反应
   * 会以为功能坏了。
   */
  const handlePick = async (picked: Array<{ key: string; name: string }>) => {
    setPickerOpen(false);
    setBusy(true);
    const failures: string[] = [];
    try {
      for (const p of picked) {
        if (!p.key.startsWith("i:")) {
          failures.push(t("library.links.addFailed"));
          continue;
        }
        const targetItemId = p.key.slice(2);
        if (targetItemId === item.id) continue; // 自己关联自己不算
        try {
          await api.library.linkAdd({ itemId: item.id, targetItemId });
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      await reload();
      onChanged?.();
      if (failures.length > 0) setError(failures.join("\n"));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 从磁盘挑一个文件/目录关联上来。
   *
   * ## 为什么先导入再关联,而不是直接存路径
   *
   * 用户的原话是「可以一个关联多个文件,不只是挂 md 文件」。库外的东西**先导入成
   * `linked` 条目**(只记绝对路径,文件原地不动),再关联到那个条目 —— 这样:
   *
   *   - 它在库里有了一个可查、可改名、可查看的条目(而不是一行裸路径);
   *   - 挂载时与库内条目走**完全同一条路**(见 `expandLinks`),chip 也只有一种形态;
   *   - 反正导入器按 `filePath` 去重,同一个文件选两次不会长出两条。
   *
   * `library.linkAdd` 那条吃 `targetPath` 的路留着,给绕过 UI 的调用(将来的 AI 工具)
   * —— 界面这条路不走它。
   */
  const addFromDisk = async () => {
    // 不传 filters = 列所有文件(用户要的是「任何文件」,不该替他预设类型)。
    // 原生框本来就是多选(`multiSelections`),一次挑几个一起关联。
    const picked = await api.pickFiles({});
    if (picked.paths.length === 0) return;
    setBusy(true);
    try {
      const res = await api.library.importGeneric({ paths: picked.paths, mode: "linked" });
      for (const it of res.items) {
        if (it.id === item.id) continue; // 选到了自己
        await api.library.linkAdd({ itemId: item.id, targetItemId: it.id });
      }
      if (res.errors.length > 0) {
        setError(res.errors.map((e) => `${e.path}:${e.error}`).join("\n"));
      }
      await reload();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 已经在列表里的条目不再进选择器 —— 与 composer 的 chip 去重同一个意思。 */
  const existingOut = (links ?? [])
    .filter((l) => l.direction === "out" && l.otherItemId)
    .map((l) => `i:${l.otherItemId}`);

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center gap-1">
        <span className="text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
          {t("library.links.title")}
        </span>
        <button
          ref={addBtnRef}
          onClick={() => {
            const rect = addBtnRef.current?.getBoundingClientRect();
            if (rect) setAnchor(rect);
            setPickerOpen(true);
          }}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          <IconPlus size={11} />
          {t("library.links.add")}
        </button>
        {/* 库里没有的东西 —— 从磁盘挑一个文件/目录。它会被导入成 linked 条目
            (文件原地不动),再关联上来:用户明确要「可以一个关联多个文件」。 */}
        <button
          onClick={() => void addFromDisk()}
          disabled={busy}
          title={t("library.links.addFromDiskHint")}
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          <IconFolderOpen size={11} />
          {t("library.links.addFromDisk")}
        </button>
      </div>

      <p className="mb-1.5 text-[0.7857em] leading-relaxed text-content-subtle">
        {t("library.links.hint")}
      </p>

      {/* #11:转录 md + 图床是本条的一部分 —— 不是一条可解除的关联,所以不进下面
          的列表,单独一行说明(没有删除按钮,它没有"单独删掉"这个操作)。 */}
      {mdBundle && (
        <div
          title={mdBundle.title}
          className="mb-1.5 rounded border border-edge bg-surface/40 px-2 py-1.5 text-[0.7857em] leading-relaxed text-content-subtle"
        >
          {mdBundle.imageCount !== undefined && mdBundle.imageCount > 0
            ? t("library.links.mdBundle", { count: String(mdBundle.imageCount) })
            : t("library.links.mdBundleNoImages")}
        </div>
      )}

      {error && (
        <div className="mb-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[0.7857em] text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!links ? (
        <div className="flex items-center gap-1.5 py-1.5 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={11} className="animate-spin" />
        </div>
      ) : links.length === 0 ? (
        <div className="py-1 text-[0.7857em] text-content-subtle">{t("library.links.empty")}</div>
      ) : (
        <div className="divide-y divide-edge/40 rounded border border-edge bg-surface/40">
          {links.map((l) => (
            <div key={l.id} className="group flex items-center gap-2 px-2 py-1.5">
              {/* 方向标注 —— 「关联到」/「被关联」。存储只有一行,但这两件事对用户
                  是不同的意思(我引用了它 / 它引用了我),所以分开标。 */}
              <span className="shrink-0 text-[0.7143em] text-content-subtle">
                {l.direction === "out" ? t("library.links.out") : t("library.links.in")}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  l.suppressedReason ? "text-content-subtle line-through" : "text-content",
                )}
                title={l.otherPath ?? l.title}
              >
                {l.title || l.otherPath || l.otherItemId || "?"}
              </span>
              {/* 被屏蔽的标出来并说清原因 —— 看得见"它存在,只是被挡了" */}
              {l.suppressedReason && (
                <span
                  title={t("library.links.suppressed", { reason: l.suppressedReason })}
                  className="inline-flex shrink-0 items-center gap-0.5 text-[0.7143em] text-amber-600 dark:text-amber-400"
                >
                  <IconEyeOff size={11} />
                  {l.suppressedReason}
                </span>
              )}
              <button
                onClick={() => void remove(l.id)}
                disabled={busy}
                title={t("library.links.remove")}
                aria-label={t("library.links.remove")}
                className="shrink-0 rounded p-0.5 text-content-subtle opacity-0 transition-opacity hover:text-content group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-strong disabled:opacity-50"
              >
                <IconX size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 选择器复用「+ → 添加文献库到上下文」那一个 —— 同一套搜索/展开/多选,
          用户不用学第二遍。已经关联过的不再列出来。 */}
      <LibraryPicker
        open={pickerOpen}
        anchorRect={anchor}
        // 关联**只能选条目**（分类不是可挂关联的对象），所以直接把分类展开、
        // 列出条目 —— 用户截图里那个"空的"选择器就是这个（见那个 prop 的说明）。
        autoExpandItems
        excludeCollectionIds={existingOut}
        onPick={(picked) => void handlePick(picked)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

export function ItemDetail({ item, onChanged }: Props) {
  const { t } = useI18n();

  // 转换动作的本地状态。hook 必须在下面那个 `if (!item)` 提前返回**之前**。
  const [converting, setConverting] = useState(false);
  const [convertMsg, setConvertMsg] = useState<string | null>(null);

  /**
   * 挂上用户**已经转录好的** Markdown,不重新转录。
   *
   * 为什么需要:重新转一遍既有成本、结果又未必更好 —— 他可能早就用自己的工具转过、
   * 或者拿的是别人给的高质量版本。硬转一遍还会**覆盖掉他更满意的那份**。正文里
   * 引用到的图会一起搬过来(按引用搬,不认目录名),免得预览里全是断图。
   */
  const adoptMarkdown = async () => {
    if (!item) return;
    const picked = await api.pickFiles({
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    const path = picked.paths[0];
    if (!path) return;
    setConverting(true);
    setConvertMsg(null);
    try {
      const res = await api.library.adoptMarkdown({ id: item.id, path });
      // 引用不到的配图要**说出来** —— 否则用户只会看到一张断图,软件一声不吭。
      // (MCP 那条同操作早就报了,两边口径必须一致。)
      const missLine =
        res.ok && res.missing.length > 0
          ? `\n${t("library.convert.adoptMissing", { n: res.missing.length })}`
          : "";
      setConvertMsg(
        res.ok
          ? t("library.convert.adoptDone", { n: res.imageCount }) + missLine
          : (res.error ?? t("library.convert.failed")),
      );
      if (res.ok) onChanged?.();
    } catch (err) {
      setConvertMsg((err as Error).message);
    } finally {
      setConverting(false);
    }
  };

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <span className="text-xs text-content-subtle">{t("library.detail.noSelection")}</span>
      </div>
    );
  }

  // kind 退役后的行为判据(按字段/扩展名,不再按条目类型):
  //   · 纯 md 条目 = 没有原文 PDF、本体就是 Markdown —— 不需要挂转录/记笔记
  const isMdOnly = !item.pdfPath && Boolean(item.mdPath?.endsWith(".md"));
  const fileState = fileStateOf(item);

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {/* 标题 */}
      <div className="mb-3 text-sm font-medium leading-snug text-content">{item.title}</div>

      {/* 文件状态 —— 放最上面,因为这是用户最关心的。下载不在这里:那是外部
          MCP / 自动化的事,核心只知道"文件在不在"。 */}
      <div className="mb-3 rounded border border-edge bg-surface/40 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <PdfBadge state={fileState} />
          {fileState === "ready" && (
            <button
              onClick={() => {
                // 同下面的 revealMd:失败必须报出来,否则点了像没反应。
                void api.library
                  .revealFile({ id: item.id, which: item.pdfPath ? "pdf" : undefined })
                  .then((res) => {
                    if (!res.ok) {
                      useToastStore.getState().push({
                        kind: "error",
                        title: t("library.revealFailed"),
                        body: res.error ?? "",
                      });
                    }
                  });
              }}
              className="inline-flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
            >
              <IconFolderOpen size={12} />
              {t("library.pdf.revealFile")}
            </button>
          )}
        </div>
      </div>

      {/* Markdown 转换 —— 这一段决定「AI 能不能读」,所以单独摆出来而不是塞进
          元数据列表里。软件自己只会本地抽纯文本;带图的那些是外部工具转完挂回来的。 */}
      <div className="mb-3 rounded border border-edge bg-surface/40 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.7857em] text-content-muted">
            {item.mdPath ? t("library.convert.ready") : t("library.convert.none")}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {item.mdPath && (
              <button
                onClick={() => {
                  // **失败要说出来。** `library.revealFile` 会带着原因回 `{ok:false}`
                  // (条目/文件不在了、还没转换产物),从前是 `void …` 一丢了事 —— 用户点了
                  // 那颗「在文件夹中显示」,屏幕上一个字都没有,像点了个死按钮。
                  void api.library.revealFile({ id: item.id, which: "md" }).then((res) => {
                    if (!res.ok) {
                      useToastStore.getState().push({
                        kind: "error",
                        title: t("library.revealFailed"),
                        body: res.error ?? "",
                      });
                    }
                  });
                }}
                title={t("library.convert.revealMd")}
                className="rounded border border-edge p-0.5 text-content-muted hover:bg-surface-hover hover:text-content"
              >
                <IconFolderOpen size={12} />
              </button>
            )}

            {/* 已经有转录好的 md?直接挂上,不用再花一次额度（纯 md 条目没有这一步） */}
            {!isMdOnly && (
              <button
                onClick={() => void adoptMarkdown()}
                disabled={converting}
                title={t("library.convert.adoptHint")}
                className="inline-flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
              >
                {t("library.convert.adopt")}
              </button>
            )}
          </div>
        </div>
        {convertMsg && (
          <div className="mt-1.5 border-t border-edge/60 pt-1.5 text-[0.7857em] leading-relaxed text-content-muted">
            {convertMsg}
          </div>
        )}
      </div>

      {/* 基础字段(来源地址 / 语言)。块本身抽在 ItemMetadata 里。 */}
      <ItemMetadata item={item} />

      {/* 摘要 */}
      {item.abstract && (
        <>
          <div className="mb-1 mt-4 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
            {t("library.detail.abstract")}
          </div>
          <div className="text-xs leading-relaxed text-content-muted">{item.abstract}</div>
        </>
      )}

      {/* 关联 —— 放在笔记之前:它是"这条和哪些东西是一组",比随手记的笔记更靠前。
          任何 kind 都有(笔记库的条目也能互相关联)。 */}
      <ItemLinks key={item.id} item={item} onChanged={onChanged} />

      {/* 读文献时随手记的笔记(挂在**这一条**上)。纯 Markdown 条目自己就是一篇
          笔记,不需要再挂"笔记",所以那里不显示这一块。 */}
      {!isMdOnly && (
        <div className="mt-4">
          <ItemNotes key={item.id} item={item} />
        </div>
      )}
    </div>
  );
}

/**
 * **关联管理对话框** —— 把 {@link ItemLinks} 那一块装进一个浮层（2026-09-21）。
 *
 * ## 为什么要有它
 *
 * 用户要把右栏那个 `library` tab 删掉，并要求关联的入口「**搬到左栏右键**」。
 * 关联天然是"某一条跟谁关联"，所以入口挂在条目行上是对的；但那一块里有选择器、
 * 列表、增删——塞进右键菜单不合适，用浮层。
 *
 * ⚠️ **内容用的是同一个 `ItemLinks`**，不是另写一份。两处（详情页 / 左栏右键）必须
 * 长得一样、行为一样，否则改了一边另一边不跟着动。
 */
export function ItemLinksDialog({
  item,
  onOpenChange,
  onChanged,
}: {
  /** 要管哪一条的关联。`null` = 关着。 */
  item: LibraryItem | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={item !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        {/*
          ⚠️ **必须 `transform-none`，光写 `translate-x-0` 没用**（2026-09-21）。

          `Dialog.Popup` 的原型是 `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`
          —— 它靠 **transform 居中**。而 CSS 规定：**一个带 `transform` 的元素会成为
          它后代里 `position: fixed` 的包含块**。

          这个 Dialog 里装着 `LibraryPicker`，那个是 `fixed` + 用**视口坐标**
          （`anchorRect`）定位的。于是它的 `fixed` 参照的不是窗口，而是这个居中盒子 ——
          表现就是用户截图里那个"选择器跑到右下角去了"。

          ⚠️ **我第一版修错了，写的是 `translate-x-0 translate-y-0`** —— 那**不解决
          问题**：`transform: translate(0,0)` 的计算值仍然**不是 `none`**，包含块照旧。
          必须显式 `transform-none`。

          居中改成**四边归零 + `m-auto`**。⚠️ 不能用 `inset-0`：tailwind-merge 里
          `inset` 与 `left`/`top` **不是同一组**，它顶不掉 `left-1/2`/`top-1/2`，
          两个值会同时留在 class 里、谁赢看样式表顺序。
        */}
        <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit w-[520px] max-w-[92vw] transform-none p-4">
          {/* ⚠️ **标题里不要拼整条标题**（2026-09-21）。用户发来的截图里它成了
              「关联 · Wavelength Selection for Satellite Quantum Key Distribution」——
              一条论文标题能长到把标题栏撑满，而真正要说的只有"这是哪一条的关联"。
              改成一个定宽可截断的副标题。 */}
          <Dialog.Title className="flex items-baseline gap-2">
            <span className="shrink-0">{t("library.links.title")}</span>
            {item && (
              <span className="min-w-0 flex-1 truncate text-[0.8571em] font-normal text-content-muted">
                {item.title}
              </span>
            )}
          </Dialog.Title>
          <div className="mt-2 max-h-[60vh] overflow-y-auto">
            {item && <ItemLinks key={item.id} item={item} onChanged={onChanged} />}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * **「分类信息」卡片** —— 分类行右键打开（2026-09-21）。
 *
 * 卡片里告诉用户**这个分类有多少条**。从前这里还有三个「导出引用」按钮
 * (BibTeX / GB-T 7714 / APA),随 2026-09-27 学术功能的清理一起退役 —— 引用导出
 * 由外部 MCP / 自动化承担。
 *
 * ## 为什么条目数在这里现拉一次
 *
 * `collection.items` 那类缓存可能是**上一屏的**（左栏按页拉，默认 200 条上限）。这里
 * 要的是"这个分类里到底有多少"，所以用同一个 `library.list` 问一次总数 —— 它回的
 * `total` 是全量计数，不受 `limit` 影响。
 */
export function CollectionInfoDialog({
  collection,
  onOpenChange,
}: {
  /** 要看哪个分类。`null` = 关着。 */
  collection: LibraryCollection | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [total, setTotal] = useState<number | null>(null);

  const id = collection?.id ?? null;
  useEffect(() => {
    setTotal(null);
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        // `limit: 1` —— 只要那个 `total`（它不受 limit 影响）。
        const res = await api.library.list({ collectionId: id, limit: 1 });
        if (!cancelled) setTotal(res.total);
      } catch {
        // 拉不到就不显示条数 —— 比显示一个错的数字好
        if (!cancelled) setTotal(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <Dialog.Root open={collection !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        {/* ⚠️ `transform-none` + 四边归零居中 —— 理由见 `ItemLinksDialog` 那段
            （`Dialog.Popup` 原型靠 transform 居中，而它会成为后代 `fixed` 的包含块）。 */}
        <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit w-[440px] max-w-[92vw] transform-none p-4">
          <Dialog.Title className="flex items-baseline gap-2">
            <span className="shrink-0">{t("library.collection.info")}</span>
            {collection && (
              <span className="min-w-0 flex-1 truncate text-[0.8571em] font-normal text-content-muted">
                {collection.name}
              </span>
            )}
          </Dialog.Title>

          <div className="mt-3">
            {/* 导之前先知道会导出多少 —— 比导完看 toast 好 */}
            {total !== null && (
              <div className="text-[0.7857em] text-content-subtle">
                {t("library.collection.itemCount", { n: total })}
              </div>
            )}

            {total === 0 && (
              <div className="mt-2 text-xs text-content-muted">
                {t("library.collection.empty")}
              </div>
            )}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * **文献信息浮窗** —— 元数据 + 引用 + 摘要（2026-09-21）。
 *
 * ## 它从哪来
 *
 * 用户的原话：「元数据表是**只有论文有**，**右键的时候会打开一个浮窗**显示，
 * 然后**引用啥的也都放在一起**」。
 *
 * 这几块原来都长在右栏详情页里。而右栏那个 `library` tab 是要删掉的（用户要把文献
 * 预览统一到中间栏），所以这些"就这一条本身"的信息得有新去处 —— 和「关联」一样，
 * 挂到左栏右键。
 *
 * ⚠️ 内容用的是**同一个** `ItemMetadata`，不是另写一份。学术那一栏(元数据表 +
 * 引用格式)随 2026-09-27 的清理退役。
 */
export function ItemInfoDialog({
  item,
  onOpenChange,
}: {
  /** 要看哪一条。`null` = 关着。 */
  item: LibraryItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={item !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        {/* ⚠️ `transform-none` + 四边归零居中 —— 理由见 `ItemLinksDialog` 那段
            （`Dialog.Popup` 原型靠 transform 居中，而它会成为后代 `fixed` 的包含块）。 */}
        <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit w-[520px] max-w-[92vw] transform-none p-4">
          <Dialog.Title className="flex items-baseline gap-2">
            <span className="shrink-0">{t("library.info.title")}</span>
            {item && (
              <span className="min-w-0 flex-1 truncate text-[0.8571em] font-normal text-content-muted">
                {item.title}
              </span>
            )}
          </Dialog.Title>
          <div className="mt-2 max-h-[65vh] overflow-y-auto">
            {item && (
              <div>
                <ItemMetadata item={item} />
                {item.abstract && (
                  <>
                    <div className="mb-1 mt-4 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
                      {t("library.detail.abstract")}
                    </div>
                    <div className="text-xs leading-relaxed text-content-muted">{item.abstract}</div>
                  </>
                )}
              </div>
            )}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
