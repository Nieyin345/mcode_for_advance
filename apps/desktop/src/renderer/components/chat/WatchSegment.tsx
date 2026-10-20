/**
 * 输入框工具栏上的「守望」段 —— 点开是一个起跑面板,把一条长命令绑到**当前会话**上。
 *
 * ## 它是什么
 *
 * 「长任务守望」是唯一一条**不在六个模式里**的内置工作流(它有 manual 触发器,所以
 * 也不进模式选择器,见 `WorkflowDropdown` 的过滤)。这里就是它唯一的日常入口:选一个
 * 命令模板(或现写一条)、可选给模型留一句话,起跑 —— 命令退出后,退出码与输出尾部
 * 会作为一次自动注入交回**这个会话**,由模型接着处理(见
 * `main/orchestration/automationRunner.ts` 的 `startWatch`)。
 *
 * ## 命令的两种来源
 *
 * 模板下拉(存过的)或现写输入框,不是二选一:现写的那条可以顺手「存为模板」,下次
 * 直接选。模板整体存成一个 setting(`automation.watch.templates`,见
 * `main/ipc/orchestration.ts` 的 `loadWatchTemplates`),**没有单独的设置页** ——
 * 它们只在起跑时有用,管理就该发生在用它的地方。
 *
 * ## 起跑时给了命令会怎样
 *
 * `startWatch` 会把这次的命令(与说明)**写回守望模板节点参数再存盘** —— 配置真相在
 * 工作流里,运行历史因此能对上号。所以面板里"命令留空"也是合法输入:意思是"沿用
 * 现存配置再跑一次"。同一个会话同时只有一个守望(`activeWatchOf`),还在跑时面板会
 * 说出来并把开始按钮按住。
 *
 * ## 为什么是自绘 portal 面板而不是 Menu
 *
 * 面板里有输入框 —— base-ui 的 Menu 是给"点一下就消失"的菜单项用的,表单得用
 * `ContextStatsPopover` 同一套:portal 到 body(composer 卡片的 overflow-hidden 会
 * 裁掉流内面板)+ 固定 backdrop 点外关闭 + 锚着触发段的矩形向上弹。
 *
 * ⚠️ **桌面专属**:手机端的 RPC 白名单没有 automation.watch,所以整段在
 * `ComposerToolbar` 里用 `isElectron` 门控 —— 按钮都不该出现在手机上,更别说点了。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { loadWatchPanelState, watchPanelLoadFailure } from "./watchPanelLoad.js";
import { createWatchTemplatesSync, type WatchTemplatesSync } from "./watchTemplatesSync.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { Input, Button, InfoHint, Select } from "@renderer/components/ui/index.js";
import type { WatchCommandTemplate } from "@contracts/ipc";
import { IconAlertTriangle, IconChevronRight, IconEye, IconTrash } from "@renderer/lib/icons.js";

/** 「不使用模板」那个选项的值。不用空串 —— 选择器原语对空串值的处理各家不一,不值得赌。 */
const NO_TEMPLATE = "none";

export function WatchSegment({
  sessionId,
  layout = "pill",
}: {
  sessionId: string;
  layout?: "pill" | "row";
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  /** 触发段的矩形,面板按它锚定。**点开那一刻**取,不跟随窗口缩放(面板关了就没了)。 */
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const openPanel = (e: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorRect(e.currentTarget.getBoundingClientRect());
    setOpen(true);
  };
  const close = () => setOpen(false);

  if (layout === "row") {
    return (
      <>
        <button
          type="button"
          onClick={openPanel}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100 text-content-muted hover:bg-surface-muted hover:text-content"
        >
          <span className="flex min-w-0 items-center gap-2">
            <IconEye size={14} className="shrink-0 opacity-80" />
            <span className="shrink-0 font-medium text-content">{t("composer.watch.title")}</span>
          </span>
          <IconChevronRight size={12} className="shrink-0 opacity-60" />
        </button>
        {open && anchorRect && (
          <WatchPanel sessionId={sessionId} anchorRect={anchorRect} onClose={close} />
        )}
      </>
    );
  }

  // 药丸段:逐字对齐 WorkflowDropdown 的 pill 触发器(composer-minipill-seg +
  // composer-lblwrap 标签壳 —— 药丸变窄时把文字收掉,只留眼睛图标)。
  return (
    <>
      <span className="composer-minipill-mid" aria-hidden />
      <button
        type="button"
        onClick={openPanel}
        className="composer-minipill-seg"
        title={t("composer.watch.title")}
      >
        <span className="shrink-0 opacity-80">
          <IconEye size={13} />
        </span>
        <span className="composer-lblwrap">
          <span className="max-w-[72px] truncate">{t("composer.watch.rowLabel")}</span>
        </span>
      </button>
      {open && anchorRect && (
        <WatchPanel sessionId={sessionId} anchorRect={anchorRect} onClose={close} />
      )}
    </>
  );
}

/* ───────── 起跑面板 ───────── */
function WatchPanel({
  sessionId,
  anchorRect,
  onClose,
}: {
  sessionId: string;
  anchorRect: DOMRect;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserViewForPanel(panelRef);

  const [templates, setTemplates] = useState<WatchCommandTemplate[]>([]);
  const [templateId, setTemplateId] = useState(NO_TEMPLATE);
  /** 【MC-054】设置完整性状态与逐条问题 —— 「一条都没有」与「有几条读不出来」分开说。 */
  const [tplHealth, setTplHealth] = useState<"absent" | "valid" | "partial" | "corrupt" | "read_error">("valid");
  /** 【MC-048】增删模板共用的事务围栏(串行队列 + 共同基准 + CAS + 冲突重载 + 关闭取消)。
   *  revision 由它保管(读时拿到、保存时带回),组件不再自己记。 */
  const syncRef = useRef<WatchTemplatesSync | null>(null);
  const [tplPending, setTplPending] = useState(false);
  const [tplProblems, setTplProblems] = useState<string[]>([]);
  const [rebuilding, setRebuilding] = useState(false);
  const [tplBackupKey, setTplBackupKey] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [message, setMessage] = useState("");
  /** 「存为模板」的名字输入。 */
  const [tplName, setTplName] = useState("");
  /** 这个会话是不是已经有一个守望在跑(主进程 `activeWatchOf`)。 */
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 打开时读一次:命令模板 + 活跃状态。**读失败与"没有模板"必须分得开**(MC-048):
  // 从前 `catch { setTemplates([]) }` 让读失败与空表长得一模一样 —— 面板照常能用,
  // 但健康态仍是 `valid`、红条不出现,用户看到的是一个"没有模板"的正常面板,
  // 而真实设置可能坏着/读不动。现在失败显式落到 `tplHealth = "read_error"` 并带原因,
  // 面板的红条(M574 起就有)照常给出诊断与「备份并重建」入口。
  useEffect(() => {
    let cancelled = false;
    // 【MC-048】单一事务围栏:所有模板变更经它排队;它把权威状态投影回组件状态。
    const sync = createWatchTemplatesSync({
      read: () => api.automation.watchTemplates(),
      save: (input) => api.automation.saveWatchTemplates(input),
      onChange: (snapshot, notice) => {
        if (cancelled) return;
        setTemplates(snapshot.templates);
        setTplHealth(snapshot.health);
        setTplProblems(snapshot.problems);
        setTplPending(snapshot.pending);
        if (notice !== null) setNotice(notice);
      },
    });
    syncRef.current = sync;
    void (async () => {
      try {
        const loaded = await loadWatchPanelState({
          templates: () => api.automation.watchTemplates(),
          status: () => api.automation.watchStatus({ sessionId }),
        });
        if (cancelled) return;
        // 读口仍由 loadWatchPanelState 负责(它区分"读失败"与"没有模板"并带上原因),
        // 但**权威状态进入围栏**:先喂给它,后续变更才有共同基准。
        setTemplates(loaded.templates);
        setTplHealth(loaded.health);
        setTplProblems(loaded.problems);
        setActive(loaded.active);
        await sync.load();
      } catch (e) {
        if (cancelled) return;
        const failed = watchPanelLoadFailure(e);
        setTemplates(failed.templates);
        // 【MC-048】读失败不再伪装成"空表":显式标记并带上原因(红条据此显示)。
        setTplHealth(failed.health);
        setTplProblems(failed.problems);
      }
    })();
    return () => {
      cancelled = true;
      // 面板关闭:排队作废、在飞结果忽略 —— 不能事后把已关面板的状态改回去。
      sync.close();
      syncRef.current = null;
    };
  }, [sessionId]);

  // Esc 关闭。这个面板不是 base-ui 的 Popup,键盘关闭得自己接。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 位置:锚在触发段上方(输入区在屏幕底部),下方放不下才翻到下面;portal 到 body,
  // composer 卡片的 overflow-hidden 裁不到。与 ContextStatsPopover 同一套。
  const [placeAbove, setPlaceAbove] = useState(true);
  useLayoutEffect(() => {
    const recompute = () => {
      const el = panelRef.current;
      if (!el) return;
      setPlaceAbove(anchorRect.top - 4 - el.offsetHeight >= 0);
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [anchorRect.top]);

  const right = window.innerWidth - anchorRect.right;
  const style: React.CSSProperties = {
    position: "fixed",
    right: Math.max(right, 8),
    ...(right < 8 ? { left: 8, right: "auto" as const } : {}),
    ...(placeAbove
      ? { bottom: window.innerHeight - anchorRect.top + 4 }
      : { top: anchorRect.bottom + 4 }),
  };

  const selectTemplate = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find((x) => x.id === id);
    if (tpl) setCommand(tpl.command);
  };

  /**
   * 【MC-048】一次模板变更 = 交给**事务围栏**的变换(不是此刻快照)。
   *
   * 围栏保证:共同基准(在上一条确认后的列表上算)、同一时刻只有一笔在飞、保存确认后
   * 才更新界面、带原值 revision、冲突时重载并重放一次、失败时连同排队一起如实作废、
   * 面板关闭后不再回写。从前删除与新增各写一份"先乐观改、失败回滚"的 catch —— 两笔
   * 并发时后完成的覆盖先完成的,界面与盘上分岔(第十六轮 E1)。
   */
  const runMutation = async (
    transform: (current: readonly WatchCommandTemplate[]) => WatchCommandTemplate[],
  ): Promise<boolean> => {
    const sync = syncRef.current;
    if (sync === null) return false;
    return (await sync.mutate(transform)).ok;
  };

  const removeTemplate = async (): Promise<void> => {
    if (templateId === NO_TEMPLATE) return;
    const targetId = templateId;
    // 变换按 id 删 —— 即使排队期间列表因前一条变换变了,删的仍是用户点的那条。
    const ok = await runMutation((current) => current.filter((x) => x.id !== targetId));
    // 成功:选择清空;失败:选择退回原来那条(列表已由围栏给权威态 + 提示语)。
    setTemplateId(ok ? NO_TEMPLATE : targetId);
  };

  const saveTemplate = async (): Promise<void> => {
    const cmd = command.trim();
    const name = tplName.trim();
    if (!cmd || !name) return;
    const tpl: WatchCommandTemplate = { id: `watchtpl_${Date.now()}`, name, command: cmd };
    const ok = await runMutation((current) => [...current, tpl]);
    if (ok) {
      setTemplateId(tpl.id);
      setTplName("");
    } else {
      setTplName(name); // 名字还给用户,别让他重打
    }
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const cmd = command.trim();
      const note = message.trim();
      // 命令/说明留空就不带字段 —— startWatch 对空值"不写模板",即沿用现存配置。
      const res = await api.automation.watch({
        sessionId,
        ...(cmd ? { command: cmd } : {}),
        ...(note ? { message: note } : {}),
      });
      if (res.ok) {
        onClose();
        return;
      }
      setNotice(res.error ? t("composer.watch.failed", { error: res.error }) : t("composer.watch.failedGeneric"));
    } catch (e) {
      setNotice(t("composer.watch.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  /** 【MC-054】显式「备份损坏原值 → 校验 → 重建」。省略 templates = 把当前读得出的
   *  好条目原样保住重写(部分损坏的常用法;主进程那边读得出什么就保什么)。 */
  const rebuildTemplates = async (): Promise<void> => {
    setRebuilding(true);
    setNotice(null);
    try {
      const res = await api.automation.rebuildWatchTemplates({});
      if (!res.ok) {
        setNotice(res.error ?? t("composer.watch.tplRebuildFailed"));
        return;
      }
      // 重建成功:重读一遍(健康态翻回正常、红条消失),把备份键告诉用户。
      // 重建改的是盘上原值:让围栏重读权威状态(它保管 revision,后续变更基于新基准)。
      const sync = syncRef.current;
      if (sync !== null) await sync.load();
      setTemplateId(NO_TEMPLATE);
      if (res.backupKey !== undefined) setTplBackupKey(res.backupKey);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setRebuilding(false);
    }
  };

  return createPortal(
    <>
      {/* 全屏透明 backdrop:点外关闭。z-40 垫在面板(z-50)下面。 */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={panelRef}
        style={style}
        className="z-50 w-[340px] max-w-[calc(100vw-16px)] rounded-[var(--radius-btn-xs)] border border-edge bg-surface p-3 shadow-[var(--shadow-popover)]"
        // 点面板别落到 backdrop 上。
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-content">
          <IconEye size={14} className="text-accent" />
          {t("composer.watch.title")}
          <InfoHint>{t("composer.watch.intro")}</InfoHint>
        </div>

        {/* 【MC-054】设置损坏:普通保存会被主进程拒绝(保住原值),这里显式说清 + 给重建入口。 */}
        {(tplHealth === "corrupt" || tplHealth === "read_error" || tplHealth === "partial") && (
          <div className="mt-2 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] leading-relaxed text-danger">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {t(tplHealth === "partial" ? "composer.watch.tplPartial" : "composer.watch.tplCorrupt")}
                {tplProblems.length > 0 && (
                  <div className="mt-0.5 text-danger/80">{tplProblems.join(" / ")}</div>
                )}
              </div>
              <button
                type="button"
                disabled={rebuilding}
                onClick={() => void rebuildTemplates()}
                className="shrink-0 rounded border border-danger/40 px-1.5 py-0.5 hover:bg-danger/10 disabled:opacity-50"
              >
                {rebuilding ? t("composer.watch.tplRebuilding") : t("composer.watch.tplRebuild")}
              </button>
            </div>
            {tplBackupKey !== null && (
              <div className="mt-0.5 text-danger/80">{t("composer.watch.tplRebuiltBackup", { key: tplBackupKey })}</div>
            )}
          </div>
        )}

        {/* 命令模板:选中的直接填进下面的命令框;旁边那把回收站只对"已选中"生效。 */}
        <label className="mt-2.5 mb-1 block text-[11px] font-medium text-content-muted">
          {t("composer.watch.templateLabel")}
        </label>
        <div className="flex items-center gap-1.5">
          <Select.Root value={templateId} onValueChange={(v) => selectTemplate(String(v))}>
            <Select.Trigger className="min-w-0 flex-1">
              <span className="min-w-0 flex-1 truncate text-left">
                {templateId !== NO_TEMPLATE
                  ? (templates.find((x) => x.id === templateId)?.name ??
                    t("composer.watch.noTemplate"))
                  : t("composer.watch.noTemplate")}
              </span>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner side="top" align="start" sideOffset={4}>
                <Select.Popup className="max-h-56 w-[320px] overflow-y-auto">
                  <Select.List>
                    <Select.Item value={NO_TEMPLATE}>
                      <Select.ItemText>{t("composer.watch.noTemplate")}</Select.ItemText>
                    </Select.Item>
                    {templates.map((tpl) => (
                      <Select.Item key={tpl.id} value={tpl.id} title={tpl.command}>
                        <Select.ItemText>{tpl.name}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
          <Button
            variant="ghost"
            size="icon"
            title={t("composer.watch.deleteTemplate")}
            disabled={templateId === NO_TEMPLATE || tplPending}
            onClick={() => void removeTemplate()}
          >
            <IconTrash size={13} />
          </Button>
        </div>

        <label className="mt-2.5 mb-1 block text-[11px] font-medium text-content-muted">
          {t("composer.watch.commandLabel")}
        </label>
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={t("composer.watch.commandPlaceholder")}
        />

        {/* 现写的这条顺手可存成模板 —— 名字与命令都有才亮。 */}
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
            placeholder={t("composer.watch.templateNamePlaceholder")}
            disabled={command.trim().length === 0}
            className="flex-1"
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={command.trim().length === 0 || tplName.trim().length === 0 || busy || tplPending}
            onClick={() => void saveTemplate()}
          >
            {t("composer.watch.saveTemplate")}
          </Button>
        </div>

        <label className="mt-2.5 mb-1 block text-[11px] font-medium text-content-muted">
          {t("composer.watch.messageLabel")}
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder={t("composer.watch.messagePlaceholder")}
          className={cn(
            "min-w-0 w-full resize-none rounded border border-edge bg-surface px-2.5 py-1.5 text-xs text-content",
            "placeholder:text-content-subtle outline-none transition-colors focus:border-accent",
          )}
        />

        {active && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
            <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
            {t("composer.watch.activeHint")}
          </p>
        )}
        {notice !== null && (
          <p className="mt-2 text-[11px] leading-relaxed text-danger">{notice}</p>
        )}

        <Button
          variant="primary"
          className="mt-2.5 w-full"
          disabled={busy || active}
          onClick={() => void start()}
        >
          {busy ? t("composer.watch.starting") : t("composer.watch.start")}
        </Button>
      </div>
    </>,
    document.body,
  );
}

/** `useSuppressBrowserView` 的面板版包装:只在面板真的挂出来时压住 BrowserView。
 *  单独一个函数是为了把这个 hook 调用放在 WatchPanel 顶层 —— WatchSegment 自己不
 *  挂面板(条件挂载的组件里不再有 hook 顺序问题)。 */
function useSuppressBrowserViewForPanel(ref: React.RefObject<HTMLDivElement | null>) {
  useSuppressBrowserView(true, ref);
}
