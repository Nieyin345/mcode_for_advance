/**
 * 设置 → 文档管理 —— 资料库对 AI 的行为:**分级提示词**(大类 / 分类)、**屏蔽规则**
 * (哪些东西不进上下文)。转录界面不在设置页展示,后续由专用 UI 承接。
 *
 * ## 这一页 2026-09-26 重建
 *
 * 旧版围着 kind(小类)建:小类提示词整段、屏蔽树的中间一层、集合按 kind 归段。
 * kind 退役(bcd3a2e)时它被整页删掉 —— 但**屏蔽的编辑器、大类/分类提示词
 * 都只活在这一页上**,删掉之后后端照常判定,用户却没有任何地方能配它们:i18n 键、
 * preload 的 suppressGet/suppressSave、报错里那句「去设置改」全成了空指。这次按
 * 三级结构(大类 → 分类 → 条目)重建,小类那一段不再存在。
 *
 * ## 管理与提示词分家(沿旧规矩)
 *
 * 大类/分类的**管理**(新建 / 删除 / 重命名)全在左栏右键;这里只做两件事:
 * 给 AI 写说明、勾屏蔽。
 *
 * ## 保存模型:草稿 + 一次交回
 *
 * 打开时拉全三份数据,编辑只改内存草稿;点「保存」一次性落库:
 *   - 大类说明随整表 `groupsSave` 走(`LibraryGroupMeta.prompt`);
 *   - 分类说明**只提交改过的**:逐条 `renameCollection({ id, prompt })`,失败逐条
 *     列出,不中断其余的;
 *   - 屏蔽规则整表 `suppressSave`(校验在主进程 `parseSuppressJson`,认不出的
 *     前缀丢单条、不废整份)。
 *
 * ## 屏蔽树画的是「大类 → 分类(含嵌套)」
 *
 * 分类可以嵌套(`parentId`,左栏「移动到…」),勾父分类 = 连子分类里的条目一起挡
 * (判定在主进程 `suppressKeysOfItem`,2026-09-26 起沿父链收到顶)。所以树里子分类
 * 缩进画在父下,父勾上时子标成「继承来的」—— 与判定同一套语义,界面不另造一份。
 */
import { useEffect, useMemo, useState } from "react";
import type { LibraryGroupMeta, LibrarySuppressRule } from "@contracts/libraryTypes";
import { normalizeSuppressExt, suppressNodeKey } from "@contracts/libraryTypes";
import type { LibraryCollection } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { Button } from "@renderer/components/ui/index.js";
import { IconBook, IconLoader2, IconX } from "@renderer/lib/icons.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { PANEL_MAX_W } from "./panelWidth.js";

/** 一行提示词:左侧名字,行尾可选归属说明,下面一个 textarea。 */
function PromptRow({
  label,
  sub,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  /** 行尾的归属说明(如「文档 › 精读队列」),分类列表用。 */
  sub?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-content">{label}</span>
        {sub && <span className="ml-auto min-w-0 truncate text-[0.7857em] text-content-subtle">{sub}</span>}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="w-full resize-y rounded border border-edge bg-surface px-2 py-1 text-xs leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
      />
    </div>
  );
}

/** 屏蔽树里的一行勾选。`depth` 只影响缩进,`inherited` 画出"是被上层挡住的"。 */
function SuppressCheck({
  label,
  checked,
  inherited,
  depth = 0,
  onToggle,
}: {
  label: string;
  checked: boolean;
  /** 这个勾是**从上层继承**来的(自己没被单独勾上)。 */
  inherited?: boolean;
  depth?: number;
  onToggle: () => void;
}) {
  return (
    <label
      className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-surface-hover"
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-3 w-3 shrink-0 accent-accent"
      />
      <span className={cn("min-w-0 truncate", inherited ? "text-content-subtle" : "text-content")}>
        {label}
      </span>
      {/* 继承来的勾要标出来 —— 否则用户取消上层时会疑惑"这条怎么自己掉了" */}
      {inherited && <span className="shrink-0 text-[0.7143em] text-content-subtle">↖</span>}
    </label>
  );
}

/** 树里的一行:分类本体 + 缩进层级 + 祖先链(近→远,屏蔽的继承判定用)。 */
interface CollRow {
  c: LibraryCollection;
  depth: number;
  ancestors: string[];
  /** 行尾的归属说明(「大类」或「大类 › 父分类」)。 */
  sub: string;
}

/**
 * 把平的分类表折成「大类 → 分类森林」的有序行。三处共用(提示词列表、屏蔽树)。
 *
 * 挂着未知 groupId 的、以及没有 groupId 的,一律落到末尾的「未分组」段 ——
 * 数据不该因为组表变动而从这一页消失。`seen` 防父链成环(历史数据可能挪出环)。
 */
function buildSections(
  groups: readonly LibraryGroupMeta[],
  collections: readonly LibraryCollection[],
  ungroupedLabel: string,
): { groupId: string | null; label: string; rows: CollRow[] }[] {
  const groupIds = new Set(groups.map((g) => g.id));
  const buckets = new Map<string | null, LibraryCollection[]>();
  for (const c of collections) {
    const gid = c.groupId && groupIds.has(c.groupId) ? c.groupId : null;
    const arr = buckets.get(gid) ?? [];
    arr.push(c);
    buckets.set(gid, arr);
  }
  const orderOf = (a: LibraryCollection, b: LibraryCollection): number =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.name.localeCompare(b.name);
  const heads: { id: string | null; label: string }[] = [
    ...groups.map((g) => ({ id: g.id as string | null, label: g.name })),
    { id: null, label: ungroupedLabel },
  ];
  const out: { groupId: string | null; label: string; rows: CollRow[] }[] = [];
  for (const head of heads) {
    const list = (buckets.get(head.id) ?? []).slice().sort(orderOf);
    // 「未分组」段没内容就整段不画;真大类空着也要画(提示词还在那儿)
    if (head.id === null && list.length === 0) continue;
    const byId = new Map(list.map((c) => [c.id, c]));
    const childrenOf = new Map<string, LibraryCollection[]>();
    const roots: LibraryCollection[] = [];
    for (const c of list) {
      if (c.parentId && byId.has(c.parentId)) {
        const arr = childrenOf.get(c.parentId) ?? [];
        arr.push(c);
        childrenOf.set(c.parentId, arr);
      } else {
        roots.push(c);
      }
    }
    const rows: CollRow[] = [];
    const seen = new Set<string>();
    const walk = (c: LibraryCollection, depth: number, ancestors: string[]): void => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      const nearest = ancestors[0];
      const parentName = nearest ? byId.get(nearest)?.name : undefined;
      rows.push({
        c,
        depth,
        ancestors,
        sub: parentName ? `${head.label} › ${parentName}` : head.label,
      });
      for (const child of childrenOf.get(c.id) ?? []) walk(child, depth + 1, [c.id, ...ancestors]);
    };
    for (const r of roots) walk(r, 1, []);
    out.push({ groupId: head.id, label: head.label, rows });
  }
  return out;
}

export function LibraryTypesPanel() {
  const { t } = useI18n();
  /** 三份数据。null = 还没拉到(画占位)。 */
  const [groups, setGroups] = useState<LibraryGroupMeta[] | null>(null);
  const [collections, setCollections] = useState<LibraryCollection[] | null>(null);
  /** 两层说明的草稿:key 是各层的 id,值是输入框里的原文(空串 = 不写)。 */
  const [groupPrompts, setGroupPrompts] = useState<Record<string, string>>({});
  const [collPrompts, setCollPrompts] = useState<Record<string, string>>({});
  /** 载入时分类说明的基线 —— 保存时只提交改过的,没动过的连 RPC 都不发。 */
  const [collBaseline, setCollBaseline] = useState<Record<string, string>>({});
  /** 屏蔽规则的草稿。与说明**同一个保存模型**:改内存,点保存一起交回。 */
  const [suppress, setSuppress] = useState<LibrarySuppressRule | null>(null);
  /** 扩展名输入框里的半成品(回车/点添加才进 `suppress.extensions`)。 */
  const [extDraft, setExtDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [gr, cols, sup] = await Promise.all([
          api.library.groupsGet({}),
          api.library.listCollections(),
          api.library.suppressGet({}),
        ]);
        setGroups(gr.groups);
        setCollections(cols.collections);
        setSuppress(sup.rule);
        const gp: Record<string, string> = {};
        for (const g of gr.groups) gp[g.id] = g.prompt ?? "";
        setGroupPrompts(gp);
        const cp: Record<string, string> = {};
        for (const c of cols.collections) cp[c.id] = c.prompt ?? "";
        setCollPrompts(cp);
        setCollBaseline(cp);
      } catch (err) {
        setLoadError((err as Error).message);
      }
    })();
  }, []);

  /** 大类 → 分类森林(有序行)。提示词列表与屏蔽树共用同一份结构。 */
  const sections = useMemo(
    () => buildSections(groups ?? [], collections ?? [], t("settings.libraryTypes.ungroupedShort")),
    [groups, collections, t],
  );

  /** 提示词列表:回收站不给写说明(它是动作的落点,不是给 AI 的分组)。 */
  const promptRows = useMemo(
    () => sections.flatMap((s) => s.rows).filter((r) => !r.c.isTrash),
    [sections],
  );

  /**
   * 勾/取消一个屏蔽节点。**只动这一条**,不替用户"顺手"展开它下面的节点:
   * 向下继承是**判定时**算的(主进程查祖先链,见 `main/library/suppress.ts`),
   * 不是存的时候展开的 —— 存的是用户真正勾的那几个,层级以后怎么挪,继承自己跟上。
   */
  const toggleNode = (key: string): void => {
    setSaved(false);
    setSuppress((prev) => {
      if (!prev) return prev;
      const has = prev.nodes.includes(key);
      return { ...prev, nodes: has ? prev.nodes.filter((x) => x !== key) : [...prev.nodes, key] };
    });
  };

  /** 加一个扩展名。规范化走契约里那个纯函数(与主进程落库同一个)。 */
  const addExt = (): void => {
    const norm = normalizeSuppressExt(extDraft);
    if (!norm) return;
    setSaved(false);
    setSuppress((prev) =>
      prev && !prev.extensions.includes(norm)
        ? { ...prev, extensions: [...prev.extensions, norm] }
        : prev,
    );
    setExtDraft("");
  };

  const removeExt = (ext: string): void => {
    setSaved(false);
    setSuppress((prev) =>
      prev ? { ...prev, extensions: prev.extensions.filter((x) => x !== ext) } : prev,
    );
  };

  const save = async (): Promise<void> => {
    if (!groups) return;
    setBusy(true);
    setSaveError(null);
    try {
      // 大类:说明并进整表交回(空串 = 不写,校验函数会 trim 并收敛成"没有")
      const nextGroups = groups.map((g) => ({
        ...g,
        prompt: groupPrompts[g.id]?.trim() || undefined,
      }));
      const resGroups = await api.library.groupsSave({ groups: nextGroups });
      if (!resGroups.ok) {
        setSaveError(resGroups.error);
        return;
      }
      // 屏蔽规则:整表替换。校验在主进程过 `parseSuppressJson` —— 它把认不出的
      // 前缀丢掉而不是拒绝整份,所以这里拿到的一定是"保住绝大部分"的结果。
      if (suppress) {
        const resSup = await api.library.suppressSave({ rule: suppress });
        if (!resSup.ok) {
          setSaveError(resSup.error);
          return;
        }
      }
      // 分类:只提交改过的;失败逐条列出,不中断其余的。
      const failures: string[] = [];
      for (const c of collections ?? []) {
        const next = collPrompts[c.id]?.trim() ?? "";
        if (next === (collBaseline[c.id] ?? "")) continue;
        const res = await api.library.renameCollection({ id: c.id, prompt: next });
        if (!res.ok) {
          failures.push(t("settings.libraryTypes.collectionSaveFailed", { name: c.name }));
        }
      }
      // 重拉分类:把主进程落库后的说明(可能被 trim)对回来,顺带刷新基线
      const cols = await api.library.listCollections();
      setCollections(cols.collections);
      const cp: Record<string, string> = {};
      for (const c of cols.collections) cp[c.id] = c.prompt ?? "";
      setCollPrompts(cp);
      setCollBaseline(cp);
      if (failures.length > 0) {
        setSaveError(failures.join("\n"));
      } else {
        setSaved(true);
      }
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader
        title={t("settings.libraryTypes.title")}
        icon={IconBook}
        action={
          <Button variant="outline" size="sm" disabled={busy || !groups || !suppress} onClick={() => void save()}>
            {busy ? (
              <>
                <IconLoader2 size={12} className="animate-spin" />
                {t("settings.libraryTypes.saving")}
              </>
            ) : (
              t("settings.libraryTypes.save")
            )}
          </Button>
        }
      />

      {/* 面板头部的分工说明:管理在左栏,这里只写提示词、勾屏蔽 */}
      <p className="px-1 text-[0.7857em] leading-relaxed text-content-subtle">
        {t("settings.libraryTypes.desc")}
      </p>

      {saved && !saveError && (
        <div className="text-[0.7857em] text-emerald-600 dark:text-emerald-400">
          {t("settings.libraryTypes.saved")}
        </div>
      )}
      {/* 保存失败:显示 error 原文(后端原话;分类逐条的失败各占一行) */}
      {saveError && <div className="whitespace-pre-wrap break-all text-[0.7857em] text-red-500">{saveError}</div>}
      {loadError && (
        <div className="break-all text-[0.7857em] text-red-500">
          {t("settings.libraryTypes.loadFailed", { error: loadError })}
        </div>
      )}

      {/* ── 大类提示词:注入在该大类清单的最前面 ── */}
      <SettingsSection title={t("settings.libraryTypes.section.group")}>
        {!groups ? (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-content-muted">
            <IconLoader2 size={13} className="animate-spin" />
          </div>
        ) : (
          groups.map((g) => (
            <PromptRow
              key={g.id}
              label={g.name}
              value={groupPrompts[g.id] ?? ""}
              onChange={(next) => {
                setSaved(false);
                setGroupPrompts((prev) => ({ ...prev, [g.id]: next }));
              }}
              placeholder={t("settings.libraryTypes.promptPh")}
            />
          ))
        )}
      </SettingsSection>

      {/* ── 分类提示词:可能很多 —— 按左栏顺序(大类 → 树序)排好,放进可滚动列表 ── */}
      <SettingsSection title={t("settings.libraryTypes.section.collection")}>
        {!collections ? (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-content-muted">
            <IconLoader2 size={13} className="animate-spin" />
          </div>
        ) : promptRows.length === 0 ? (
          <div className="px-4 py-3 text-xs text-content-muted">{t("settings.libraryTypes.noCollections")}</div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {promptRows.map(({ c, sub }) => (
              <PromptRow
                key={c.id}
                label={c.name}
                sub={sub}
                value={collPrompts[c.id] ?? ""}
                onChange={(next) => {
                  setSaved(false);
                  setCollPrompts((prev) => ({ ...prev, [c.id]: next }));
                }}
                placeholder={t("settings.libraryTypes.promptPh")}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {/* ── 屏蔽:哪些东西**不进**上下文 ──
          与提示词是同一类东西(「资料库对 AI 的行为」),所以住同一页、共用保存按钮。 */}
      <SettingsSection title={t("settings.libraryTypes.section.suppress")}>
        {!suppress ? (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-content-muted">
            <IconLoader2 size={13} className="animate-spin" />
          </div>
        ) : (
          <>
            <p className="px-4 pt-3 text-[0.7857em] leading-relaxed text-content-subtle">
              {t("settings.libraryTypes.suppressHint")}
            </p>

            {/* ── 按分类:大类 → 分类(含嵌套)的勾选树 ── */}
            <div className="px-4 pt-3 text-[0.7857em] font-medium text-content-muted">
              {t("settings.libraryTypes.suppressNodes")}
            </div>
            <div className="max-h-80 overflow-y-auto px-2 py-1">
              {sections.map((s) => {
                const gKey = s.groupId ? suppressNodeKey("group", s.groupId) : null;
                const gOn = gKey ? suppress.nodes.includes(gKey) : false;
                return (
                  <div key={s.groupId ?? "__ungrouped"}>
                    {gKey ? (
                      <SuppressCheck label={s.label} checked={gOn} onToggle={() => toggleNode(gKey)} />
                    ) : (
                      // 「未分组」不是一个可勾的节点(它不存在于规则的键空间里),
                      // 只当标题画出来 —— 免得下面的行看着像悬空的。
                      <div className="px-2 py-1 text-[0.7857em] text-content-subtle">{s.label}</div>
                    )}
                    {s.rows.map((r) => {
                      const cKey = suppressNodeKey("collection", r.c.id);
                      const inherited =
                        gOn ||
                        r.ancestors.some((a) => suppress.nodes.includes(suppressNodeKey("collection", a)));
                      return (
                        <SuppressCheck
                          key={r.c.id}
                          label={r.c.name}
                          depth={r.depth}
                          checked={inherited || suppress.nodes.includes(cKey)}
                          // 上层已勾时这行是被继承挡住的 —— 允许继续勾(取消上层时它还在),
                          // 但界面上标出"是继承来的"。
                          inherited={inherited}
                          onToggle={() => toggleNode(cKey)}
                        />
                      );
                    })}
                  </div>
                );
              })}
              {suppress.nodes.length === 0 && (
                <div className="px-2 py-1.5 text-[0.7857em] text-content-subtle">
                  {t("settings.libraryTypes.suppressNone")}
                </div>
              )}
            </div>

            {/* ── 按文件类型 ── */}
            <div className="mt-2 border-t border-edge/60 px-4 pt-3 text-[0.7857em] font-medium text-content-muted">
              {t("settings.libraryTypes.suppressExts")}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-2">
              {suppress.extensions.map((ext) => (
                <span
                  key={ext}
                  className="inline-flex items-center gap-1 rounded bg-surface-muted px-1.5 py-0.5 text-[0.7857em] text-content"
                >
                  {ext}
                  <button
                    onClick={() => removeExt(ext)}
                    title={t("settings.libraryTypes.delete")}
                    className="text-content-subtle hover:text-content"
                  >
                    <IconX size={10} />
                  </button>
                </span>
              ))}
              {/* 输入框 + 添加:回车与按钮走同一条路。规范化用契约里那个纯函数 ——
                  与主进程落库时同一个,不会出现"界面显示 .ZIP、实际存了 .zip"的失配。 */}
              <input
                value={extDraft}
                onChange={(e) => setExtDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExt();
                  }
                }}
                placeholder={t("settings.libraryTypes.suppressExtPh")}
                className="w-40 rounded border border-edge bg-surface px-2 py-0.5 text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
              />
              <Button variant="outline" size="sm" onClick={addExt} disabled={extDraft.trim().length === 0}>
                {t("settings.libraryTypes.suppressExtAdd")}
              </Button>
            </div>
            <p className="px-4 pb-3 text-[0.7857em] leading-relaxed text-content-subtle">
              {t("settings.libraryTypes.suppressExtHint")}
            </p>
          </>
        )}
      </SettingsSection>
    </section>
  );
}

