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
 *   - 大类说明随整表 `groupsSave` 走 —— 大类目前**还没有 prompt 字段**,这里把
 *     prompt 多带在 groups 对象里交上去(主进程的 parseLibraryGroupsJson 会忽略
 *     多余字段,不会报错);契约补上该字段之前,这一层先这样交,UI 不用再改;
 *   - 集合说明**只提交改过的**那些:逐条 `renameCollection({ id, prompt })`,
 *     失败逐条列出后端 error 原文,不中断其余的。
 *
 * 集合可能很多:按左栏的顺序(组 → 类型)排好,放在一个可滚动的列表里,
 * 每行标着「组名 › 类型名」说明它挂在哪一层。
 */
import { useEffect, useMemo, useState } from "react";
import type { LibraryGroupMeta, LibraryTypeMeta } from "@contracts/libraryTypes";
import type { LibraryCollection } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { Button } from "@renderer/components/ui/index.js";
import { IconBook, IconLoader2 } from "@renderer/lib/icons.js";
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [ty, gr, cols] = await Promise.all([
          api.library.typesGet({}),
          api.library.groupsGet({}),
          api.library.listCollections(),
        ]);
        setTypes(ty.types);
        setGroups(gr.groups);
        setCollections(cols.collections);
        const tp: Record<string, string> = {};
        for (const row of ty.types) tp[row.id] = row.prompt ?? "";
        setTypePrompts(tp);
        const gp: Record<string, string> = {};
        for (const g of gr.groups) {
          // 大类的 prompt 字段契约里还没有(见文件头):先按"可能有"读,没有就空着
          gp[g.id] = (g as LibraryGroupMeta & { prompt?: string }).prompt ?? "";
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
          <Button variant="outline" size="sm" disabled={busy || !types || !groups} onClick={() => void save()}>
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
    </section>
  );
}
