/**
 * 设置 → 资料库提示词 —— 给 AI 的**分级说明**(大类 / 小类 / 集合)。
 *
 * ## 管理与提示词分家
 *
 * 用户新的分工:类型与大类的**管理**(新建 / 删除 / 重命名)全部收进左栏右键,
 * 设置页里不再放任何编辑表单 —— 这里只剩一件事:**给 AI 写说明**。三个层级各一段,
 * 每行一个 textarea,不写就没有(清单里不注入这一层)。
 *
 * ## 保存模型:草稿 + 一次交回
 *
 * 打开时拉全三份数据,编辑只改内存里的草稿;点「保存」一次性落库:
 *   - 小类说明随整表 `typesSave` 走(类型表本来就存设置里,prompt 是其中一列);
 *   - 大类说明随整表 `groupsSave` 走 —— 大类同样有 `prompt` 字段(`LibraryGroupMeta`,
 *     `parseLibraryGroupsJson` 会 trim 并校验),不是多余字段;
 *   - 集合说明**只提交改过的**那些:逐条 `renameCollection({ id, prompt })`,
 *     失败逐条列出后端 error 原文,不中断其余的。
 *
 * 集合可能很多:按左栏的顺序(组 → 类型)排好,放在一个可滚动的列表里,
 * 每行标着「组名 › 类型名」说明它挂在哪一层。
 */
import { useEffect, useMemo, useState } from "react";
import type { LibraryGroupMeta, LibraryTypeMeta, LibrarySuppressRule } from "@contracts/libraryTypes";
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

/** 一行提示词:左侧名字(可选「未分组」一类的标注),下面一个 textarea。 */
function PromptRow({
  label,
  sub,
  badge,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  /** 行尾的归属说明(如「文档 › 论文」),集合列表用。 */
  sub?: string;
  /** 名字旁边的小标注(如「内置」)。 */
  badge?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-content">{label}</span>
        {badge && (
          <span className="shrink-0 rounded bg-surface-muted px-1 py-0.5 text-[0.7143em] text-content-subtle">
            {badge}
          </span>
        )}
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
      {/* 继承来的勾要标出来 —— 否则用户取消大类时会疑惑"这条怎么自己掉了" */}
      {inherited && <span className="shrink-0 text-[0.7143em] text-content-subtle">↖</span>}
    </label>
  );
}

export function LibraryTypesPanel() {
  const { t } = useI18n();
  /** 三份数据。null = 还没拉到(画占位)。 */
  const [types, setTypes] = useState<LibraryTypeMeta[] | null>(null);
  const [groups, setGroups] = useState<LibraryGroupMeta[] | null>(null);
  const [collections, setCollections] = useState<LibraryCollection[] | null>(null);
  /** 三层说明的草稿:key 是各层的 id,值是输入框里的原文(空串 = 不写)。 */
  const [typePrompts, setTypePrompts] = useState<Record<string, string>>({});
  const [groupPrompts, setGroupPrompts] = useState<Record<string, string>>({});
  const [collPrompts, setCollPrompts] = useState<Record<string, string>>({});
  /** 载入时集合说明的基线 —— 保存时只提交改过的集合,没动过的连 RPC 都不发。 */
  const [collBaseline, setCollBaseline] = useState<Record<string, string>>({});
  /** 屏蔽规则的草稿。与上面三份说明**同一个保存模型**:改内存,点保存一起交回。 */
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
        const [ty, gr, cols, sup] = await Promise.all([
          api.library.typesGet({}),
          api.library.groupsGet({}),
          api.library.listCollections(),
          api.library.suppressGet({}),
        ]);
        setTypes(ty.types);
        setGroups(gr.groups);
        setCollections(cols.collections);
        setSuppress(sup.rule);
        const tp: Record<string, string> = {};
        for (const row of ty.types) tp[row.id] = row.prompt ?? "";
        setTypePrompts(tp);
        const gp: Record<string, string> = {};
        for (const g of gr.groups) {
          gp[g.id] = g.prompt ?? "";
        }
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

  /** 集合行:按左栏的顺序(组 → 类型 → 名字)排好,并带上归属说明。 */
  const collRows = useMemo(() => {
    if (!collections || !groups || !types) return [];
    const kindOwner = new Map<string, LibraryGroupMeta>();
    for (const g of groups) for (const k of g.kinds) kindOwner.set(k, g);
    const typeName = new Map(types.map((ty) => [ty.id, ty.name]));
    const groupOrder = new Map(groups.map((g, i) => [g.id, i]));
    return [...collections]
      .sort((a, b) => {
        const ga = kindOwner.get(a.kind) ? groupOrder.get(kindOwner.get(a.kind)!.id) ?? 999 : 999;
        const gb = kindOwner.get(b.kind) ? groupOrder.get(kindOwner.get(b.kind)!.id) ?? 999 : 999;
        if (ga !== gb) return ga - gb;
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
        return a.name.localeCompare(b.name);
      })
      .map((c) => {
        const owner = kindOwner.get(c.kind);
        return {
          c,
          sub: `${owner?.name ?? t("settings.libraryTypes.ungroupedShort")} › ${typeName.get(c.kind) ?? c.kind}`,
        };
      });
  }, [collections, groups, types, t]);

  /** kind id → 显示名。注册表里有就用它的名字(用户改过也跟得上)。 */
  const kindName = (id: string): string => types?.find((x) => x.id === id)?.name ?? id;

  /**
   * 勾/取消一个屏蔽节点。
   *
   * **只动这一条**,不替用户"顺手"加上或去掉它下面的节点:向下继承是**判定时**算的
   * (主进程查祖先链,见 `main/library/suppress.ts`),不是存的时候展开的。这样做有
   * 两个好处 —— 存的是用户真正勾的那几个(他回头能看懂自己勾了什么),而且以后改了
   * 大类包含哪些类型,继承关系会自己跟上,不需要迁移存量规则。
   */
  const toggleNode = (key: string) => {
    setSaved(false);
    setSuppress((prev) => {
      if (!prev) return prev;
      const has = prev.nodes.includes(key);
      return { ...prev, nodes: has ? prev.nodes.filter((x) => x !== key) : [...prev.nodes, key] };
    });
  };

  /** 加一个扩展名。规范化走契约里那个纯函数(与主进程落库同一个)。 */
  const addExt = () => {
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

  const toggleExt = (ext: string) => {
    setSaved(false);
    setSuppress((prev) =>
      prev ? { ...prev, extensions: prev.extensions.filter((x) => x !== ext) } : prev,
    );
  };

  const save = async () => {
    if (!types || !groups) return;
    setBusy(true);
    setSaveError(null);
    try {
      // 小类:说明并进整表交回(空串 = 不写,主进程会规整成 undefined)
      const nextTypes = types.map((row) => ({
        ...row,
        prompt: typePrompts[row.id]?.trim() || undefined,
      }));
      const resTypes = await api.library.typesSave({ types: nextTypes });
      if (!resTypes.ok) {
        setSaveError(resTypes.error);
        return;
      }
      // 大类:prompt 是多带的字段(契约补上之前主进程先忽略它,见文件头)
      const nextGroups = groups.map((g) => ({
        ...g,
        prompt: groupPrompts[g.id]?.trim() || undefined,
      }));
      const resGroups = await api.library.groupsSave({ groups: nextGroups });
      if (!resGroups.ok) {
        setSaveError(resGroups.error);
        return;
      }
      // 屏蔽规则:整表替换(与上面两份同一个形状)。校正在主进程过
      // `parseSuppressJson` —— 它会把认不出的前缀丢掉而不是拒绝整份,
      // 所以这里拿到的一定是"保住绝大部分"的结果。
      if (suppress) {
        const resSup = await api.library.suppressSave({ rule: suppress });
        if (!resSup.ok) {
          setSaveError(resSup.error);
          return;
        }
      }
      // 集合:只提交改过的;失败逐条列出,不中断其余的。
      // (renameCollection 只回 ok 布尔,没有 error 原文可摆 —— 只改 prompt 时
      //  主进程恒成功,ok=false 只在改名撞重名时出现,这里到不了。)
      const failures: string[] = [];
      for (const c of collections ?? []) {
        const next = collPrompts[c.id]?.trim() ?? "";
        if (next === (collBaseline[c.id] ?? "")) continue;
        const res = await api.library.renameCollection({ id: c.id, prompt: next });
        if (!res.ok) {
          failures.push(t("settings.libraryTypes.collectionSaveFailed", { name: c.name }));
        }
      }
      // 重拉集合:把主进程落库后的说明(可能被 trim)对回来,顺带刷新基线
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
          <Button variant="outline" size="sm" disabled={busy || !types || !groups || !suppress} onClick={() => void save()}>
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

      {/* 面板头部的分工说明:管理在左栏,这里只写提示词 */}
      <p className="px-1 text-[0.7857em] leading-relaxed text-content-subtle">
        {t("settings.libraryTypes.desc")}
      </p>

      {saved && !saveError && (
        <div className="text-[0.7857em] text-emerald-600 dark:text-emerald-400">
          {t("settings.libraryTypes.saved")}
        </div>
      )}
      {/* 保存失败:显示 error 原文(后端原话;集合逐条的失败各占一行) */}
      {saveError && <div className="whitespace-pre-wrap break-all text-[0.7857em] text-red-500">{saveError}</div>}
      {loadError && (
        <div className="break-all text-[0.7857em] text-red-500">
          {t("settings.libraryTypes.loadFailed", { error: loadError })}
        </div>
      )}

      {/* ── 大类提示词:注入在段内所有类型的说明之前 ── */}
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

      {/* ── 小类提示词:每行一个类型(内置 / 自定义都行)── */}
      <SettingsSection title={t("settings.libraryTypes.section.type")}>
        {!types ? (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-content-muted">
            <IconLoader2 size={13} className="animate-spin" />
          </div>
        ) : (
          types.map((row) => (
            <PromptRow
              key={row.id}
              label={row.name}
              badge={row.builtin ? t("settings.libraryTypes.builtin") : undefined}
              value={typePrompts[row.id] ?? ""}
              onChange={(next) => {
                setSaved(false);
                setTypePrompts((prev) => ({ ...prev, [row.id]: next }));
              }}
              placeholder={t("settings.libraryTypes.promptPh")}
            />
          ))
        )}
      </SettingsSection>

      {/* ── 集合提示词:可能很多 —— 按左栏顺序排好,放进可滚动列表 ── */}
      <SettingsSection title={t("settings.libraryTypes.section.collection")}>
        {!collections ? (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-content-muted">
            <IconLoader2 size={13} className="animate-spin" />
          </div>
        ) : collRows.length === 0 ? (
          <div className="px-4 py-3 text-xs text-content-muted">{t("settings.libraryTypes.noCollections")}</div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {collRows.map(({ c, sub }) => (
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
          与上面三段提示词是同一类东西(「资料库对 AI 的行为」),所以住在同一页、
          共用同一个保存按钮。 */}
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

            {/* ── 按分类:三层勾选树 ── */}
            <div className="px-4 pt-3 text-[0.7857em] font-medium text-content-muted">
              {t("settings.libraryTypes.suppressNodes")}
            </div>
            <div className="max-h-80 overflow-y-auto px-2 py-1">
              {(groups ?? []).map((g) => {
                const gKey = suppressNodeKey("group", g.id);
                const gOn = suppress.nodes.includes(gKey);
                return (
                  <div key={g.id}>
                    <SuppressCheck
                      label={g.name}
                      checked={gOn}
                      onToggle={() => toggleNode(gKey)}
                    />
                    {g.kinds.map((kindId) => {
                      const tKey = suppressNodeKey("type", kindId);
                      const kindOn = gOn || suppress.nodes.includes(tKey);
                      return (
                        <div key={kindId}>
                          <SuppressCheck
                            label={kindName(kindId)}
                            depth={1}
                            checked={kindOn}
                            // 大类已经勾上时小类是被继承挡住的 —— 允许继续勾
                            // (再取消大类时它还在),但界面上标出"是继承来的"。
                            inherited={gOn}
                            onToggle={() => toggleNode(tKey)}
                          />
                          {(collections ?? [])
                            .filter((c) => c.kind === kindId)
                            .map((c) => {
                              const cKey = suppressNodeKey("collection", c.id);
                              return (
                                <SuppressCheck
                                  key={c.id}
                                  label={c.name}
                                  depth={2}
                                  checked={kindOn || suppress.nodes.includes(cKey)}
                                  inherited={kindOn}
                                  onToggle={() => toggleNode(cKey)}
                                />
                              );
                            })}
                        </div>
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
                    onClick={() => toggleExt(ext)}
                    title={t("settings.libraryTypes.delete")}
                    className="text-content-subtle hover:text-content"
                  >
                    <IconX size={10} />
                  </button>
                </span>
              ))}
              {/* 输入框 + 添加:回车与按钮走同一条路(各自算一遍,免得两处规则漂移)。
                  规范化用契约里那个纯函数 —— 与主进程落库时同一个,不会出现
                  "界面显示 .ZIP、实际存了 .zip 而判定对不上"这种静默失配。 */}
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
