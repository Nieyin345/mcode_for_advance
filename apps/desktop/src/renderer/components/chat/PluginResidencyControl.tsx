import { useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconPuzzle } from "@renderer/lib/icons.js";
import { useNarrowViewport } from "@renderer/hooks/useNarrowViewport.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { PluginState } from "@contracts/plugin";

/**
 * Conversation-scoped plugin residency selector.
 *
 * `null` is the compatibility mode: every globally enabled plugin is eligible,
 * matching Mcode's historical behavior. Once the user picks one or more names,
 * that stable allowlist is persisted on the Session row and reused by every
 * later turn. Providers still re-resolve the names against the CURRENT global
 * enabled/install state, so a disabled or removed plugin is never resurrected.
 */
export function PluginResidencyControl({
  sessionId,
  layout = "pill",
}: {
  sessionId: string;
  layout?: "pill" | "row";
}) {
  const { t } = useI18n();
  const stacked = layout === "row";
  const cascade = stacked && !useNarrowViewport();
  const [open, setOpen] = useState(false);
  const [plugins, setPlugins] = useState<PluginState[]>([]);
  const [saving, setSaving] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);

  const persisted = useSessionStore((s) => {
    for (const list of Object.values(s.sessionsByProject)) {
      const hit = list?.find((session) => session.id === sessionId);
      if (hit) return hit.activePluginNames ?? null;
    }
    const pinned = s.pinnedSessions.find((session) => session.id === sessionId);
    if (pinned) return pinned.activePluginNames ?? null;
    for (const list of Object.values(s.sideChatsByParent)) {
      const hit = list?.find((session) => session.id === sessionId);
      if (hit) return hit.activePluginNames ?? null;
    }
    return null;
  });
  const [selected, setSelected] = useState<string[] | null>(persisted);

  useEffect(() => setSelected(persisted), [persisted, sessionId]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const { plugins: rows } = await api.plugins.list();
        if (!cancelled) setPlugins((rows ?? []).filter((plugin) => plugin.enabled));
      } catch {
        // Mobile/web shims may not expose the Plugins namespace at all. Keep
        // the composer usable instead of letting a synchronous namespace
        // lookup tear down the React tree.
        if (!cancelled) setPlugins([]);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const persist = async (next: string[] | null) => {
    const previous = selected;
    setSelected(next);
    setSaving(true);
    try {
      await api.session.updateSettings({ sessionId, activePluginNames: next });
    } catch (err) {
      console.error("session plugin residency update failed:", err);
      setSelected(previous);
    } finally {
      setSaving(false);
    }
  };

  const togglePlugin = (name: string, checked: boolean) => {
    // Picking a concrete plugin while in legacy/all mode intentionally enters
    // pinned mode with ONLY that plugin; subsequent checks add to the allowlist.
    const base = selected ?? [];
    const next = checked
      ? [...new Set([...base, name])]
      : base.filter((value) => value !== name);
    void persist(next.length > 0 ? next : null);
  };

  const label = selected === null
    ? t("chat.plugins.allEnabled")
    : selected.length === 1
      ? selected[0]
      : t("chat.plugins.activeCount", { count: selected.length });

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        className={cn(
          stacked
            ? "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100 text-content-muted hover:bg-surface-muted hover:text-content"
            : "composer-minipill-seg",
        )}
        style={!stacked && selected !== null ? { color: "rgb(var(--accent))" } : undefined}
        title={t("chat.plugins.title")}
      >
        {stacked ? (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <IconPuzzle size={14} className="shrink-0 opacity-80" />
              <span>{t("chat.plugins.rowLabel")}</span>
            </span>
            <span className="max-w-[150px] truncate text-content-subtle">{label}</span>
          </>
        ) : (
          <>
            <IconPuzzle size={13} className="shrink-0 opacity-80" />
            <span className="composer-lblwrap">
              <span className="max-w-[92px] truncate">{label}</span>
            </span>
          </>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side={cascade ? "right" : "top"}
          align="start"
          sideOffset={cascade ? 6 : 4}
          className="z-50"
        >
          <Menu.Popup
            ref={popupRef}
            className={cn(
              "min-w-[280px] max-w-[360px] rounded-lg border border-edge bg-surface py-1 shadow-2xl",
              cascade ? "origin-top-left" : "origin-bottom-left",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              disabled={saving}
              onClick={() => void persist(null)}
              className={cn(
                "flex w-full items-start justify-between gap-3 px-3 py-2 text-left outline-none select-none",
                "data-[highlighted]:bg-surface-muted",
                selected === null ? "text-accent" : "text-content-muted",
              )}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium">{t("chat.plugins.allEnabled")}</span>
                <span className="text-[11px] leading-snug text-content-subtle">
                  {t("chat.plugins.allEnabledHint")}
                </span>
              </span>
              {selected === null && <IconCheck size={14} className="mt-0.5 shrink-0" />}
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-edge" />
            {plugins.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-content-subtle">
                {t("chat.plugins.noneEnabled")}
              </div>
            ) : (
              plugins.map((plugin) => (
                <Menu.CheckboxItem
                  key={plugin.name}
                  checked={selected?.includes(plugin.name) ?? false}
                  disabled={saving}
                  closeOnClick={false}
                  onCheckedChange={(checked) => togglePlugin(plugin.name, checked === true)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    selected?.includes(plugin.name) ? "text-accent" : "text-content-muted",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-medium">{plugin.name}</span>
                    {plugin.description && (
                      <span className="line-clamp-2 text-[11px] leading-snug text-content-subtle">
                        {plugin.description}
                      </span>
                    )}
                  </span>
                  <Menu.CheckboxItemIndicator className="mt-0.5 shrink-0 text-accent">
                    <IconCheck size={14} />
                  </Menu.CheckboxItemIndicator>
                </Menu.CheckboxItem>
              ))
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
