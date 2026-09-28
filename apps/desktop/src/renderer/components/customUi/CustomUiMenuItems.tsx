/**
 * 右键菜单里**可配置的那一段** + 末尾的「自定义 UI…」。
 *
 * 各处菜单(资料库四级、Files 文件右键)只负责两件事:在自己的位置放下
 * `<CustomUiMenuEntries>`,并把内置项「点了做什么」递进来(`builtins`)。显示哪些、
 * 排第几、自定义项做什么,全按设置页存下的配置来(`useCustomUiStore`)。
 *
 * 用的是 `Menu.Item`:base-ui 的 ContextMenu 各部件就是 Menu 的部件,所以资料库那几个
 * `Menu.Root` 菜单与 FileTree 的 `ContextMenu.Root` 菜单都能直接用这一份。
 */
import { Fragment, useMemo, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  arrangeSlotEntries,
  builtinKey,
  customKey,
  customUiLabel,
  matchesWhen,
  type CustomUiItem,
  type CustomUiSlot,
  type CustomUiTarget,
} from "@contracts/customUi";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconAdjustmentsHorizontal } from "@renderer/lib/icons.js";
import { openCustomUiSettings, useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { BUILTINS, CUSTOM_ICONS, DEFAULT_ACTION_ICON, type BuiltinMeta, type IconComponent } from "./registry.js";
import { runCustomItem } from "./runCustomItem.js";

/** 内置项的运行时:点了做什么。**不给 = 这一刻不显示**(比如没有文件的条目上的「采纳 MD」)。 */
export interface BuiltinRuntime {
  run: () => void;
  disabled?: boolean;
  /** 覆盖默认名字(「查看转录文本（还没转换）」这种随状态变的)。 */
  label?: string;
}

/** 模块项(只在 `files.context`):键 `module:<模块>:<贡献>`,由 FileTree 按扩展名筛好递进来。 */
export interface ModuleEntryRuntime {
  key: string;
  label: string;
  disabled?: boolean;
  run: () => void;
}

type Resolved =
  | { key: string; kind: "builtin"; meta: BuiltinMeta; runtime: BuiltinRuntime }
  | { key: string; kind: "module"; entry: ModuleEntryRuntime }
  | { key: string; kind: "custom"; item: CustomUiItem };

/**
 * 算出这个挂载位此刻要画的条目(已排序、已去掉隐藏的和条件不满足的)。
 * 单独导出给冒烟与设置页的「预览」用。
 */
export function resolveSlotEntries(
  slot: CustomUiSlot,
  target: CustomUiTarget,
  items: readonly CustomUiItem[],
  layout: Parameters<typeof arrangeSlotEntries>[1],
  builtins: Readonly<Record<string, BuiltinRuntime | undefined>>,
  modules: readonly ModuleEntryRuntime[],
): Resolved[] {
  const byKey = new Map<string, Resolved>();
  for (const meta of BUILTINS[slot]) {
    const runtime = builtins[meta.id];
    if (runtime) byKey.set(builtinKey(meta.id), { key: builtinKey(meta.id), kind: "builtin", meta, runtime });
  }
  for (const entry of modules) byKey.set(entry.key, { key: entry.key, kind: "module", entry });
  for (const item of items) {
    if (item.slot !== slot || !matchesWhen(item.when, target)) continue;
    byKey.set(customKey(item.id), { key: customKey(item.id), kind: "custom", item });
  }
  return arrangeSlotEntries([...byKey.keys()], layout).flatMap((k) => {
    const r = byKey.get(k);
    return r ? [r] : [];
  });
}

export function CustomUiMenuEntries({
  slot,
  target,
  builtins,
  modules,
  itemClass,
  onClose,
  before,
  after,
}: {
  slot: CustomUiSlot;
  /** 右键的目标;`null` = 菜单正在关(退场动画期间),什么都不画。 */
  target: CustomUiTarget | null;
  builtins?: Readonly<Record<string, BuiltinRuntime | undefined>>;
  modules?: readonly ModuleEntryRuntime[];
  itemClass: string;
  /** 受控菜单(资料库那几个)要自己关;ContextMenu 点了会自己关,可不传。 */
  onClose?: () => void;
  /** 这一段**非空时**才画的前后分隔(空段不留两条挨着的分隔线)。 */
  before?: ReactNode;
  after?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const items = useCustomUiStore((s) => s.config.items);
  const layout = useCustomUiStore((s) => s.config.layout[slot]);
  const entries = useMemo(
    () => (target ? resolveSlotEntries(slot, target, items, layout, builtins ?? {}, modules ?? []) : []),
    [slot, target, items, layout, builtins, modules],
  );
  if (!target || entries.length === 0) return null;

  const renderIcon = (Icon: IconComponent) => <Icon size={12} className="shrink-0" />;

  return (
    <>
      {before}
      {entries.map((e) => {
        if (e.kind === "builtin") {
          return (
            <Menu.Item
              key={e.key}
              disabled={e.runtime.disabled}
              onClick={() => {
                e.runtime.run();
                onClose?.();
              }}
              className={cn(itemClass, "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40")}
            >
              {renderIcon(e.meta.icon)}
              {e.runtime.label ?? t(e.meta.labelKey)}
            </Menu.Item>
          );
        }
        if (e.kind === "module") {
          return (
            <Menu.Item
              key={e.key}
              disabled={e.entry.disabled}
              onClick={() => {
                e.entry.run();
                onClose?.();
              }}
              className={cn(itemClass, "data-[disabled]:opacity-50")}
            >
              {renderIcon(DEFAULT_ACTION_ICON.view)}
              <span className="truncate">{e.entry.label}</span>
            </Menu.Item>
          );
        }
        const Icon = e.item.icon ? CUSTOM_ICONS[e.item.icon] : DEFAULT_ACTION_ICON[e.item.action.type];
        return (
          <Menu.Item
            key={e.key}
            onClick={() => {
              void runCustomItem(e.item, target);
              onClose?.();
            }}
            className={itemClass}
          >
            {renderIcon(Icon)}
            <span className="truncate">{customUiLabel(e.item.label, locale)}</span>
          </Menu.Item>
        );
      })}
      {after}
    </>
  );
}

/** 菜单最末那一项:进设置页的「自定义 UI」,并选中这个挂载位。 */
export function CustomUiCustomizeItem({
  slot,
  itemClass,
  onClose,
  before,
}: {
  slot: CustomUiSlot;
  itemClass: string;
  onClose?: () => void;
  before?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Fragment>
      {before}
      <Menu.Item
        onClick={() => {
          onClose?.();
          openCustomUiSettings(slot);
        }}
        className={cn(itemClass, "text-content-subtle")}
      >
        <IconAdjustmentsHorizontal size={12} className="shrink-0" />
        {t("customUi.menu.customize")}
      </Menu.Item>
    </Fragment>
  );
}
