import { cn } from "@renderer/lib/cn.js";
import {
  IconDeviceDesktop,
  IconDeviceMobile,
  IconChevronDown,
} from "@renderer/lib/icons.js";
import { PiArrowsClockwise } from "@renderer/lib/icons.js";
import { Select } from "@renderer/components/ui/index.js";
import {
  BROWSER_DEVICE_PRESETS,
  type BrowserDevicePreset,
  type BrowserOrientation,
} from "@contracts/ipc";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";

/** Localized overrides for presets whose contract label is Chinese
 * ("桌面端"/"自定义" in BROWSER_DEVICE_PRESETS). Product names (iPhone 14,
 * Pixel 7, …) pass through untranslated. */
const PRESET_LABEL_KEYS: Partial<Record<BrowserDevicePreset, MessageId>> = {
  desktop: "browser.desktopDevice",
  custom: "browser.customDevice",
};

/** 自定义宽高输入框里那个数:取整、抬到 ≥1、认不出的用默认值。
 *
 *  ⚠️ 契约那边是 `z.number().int().min(1)`(`BrowserSetBoundsSchema`)—— **整数**。
 *  所以 `1.5` 也会被拒,不只是负数和 0。`Number("") || 0` 那条老写法只挡得住空串
 *  和 0,手打进去的 `-5` / `1.5` 都是真值,会原样发出去被 zod 拒掉。
 *
 *  为什么不能省这道:被拒之后用户看到的是浏览器面板**正中间一屏 zod JSON**,
 *  还看不出是哪一项不对。既然边界是知道的,就发一个边界内的出去。
 *
 *  (那个 `min={1}` 属性管不住这个 —— HTML 的 min/max 只约束方向键微调和表单校验,
 *  手打的字照样进 onChange。) */
function clampViewportPx(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.round(n));
}

/**
 * Device toolbar — the browser panel's "Toggle device toolbar" equivalent
 * (Chrome DevTools-style). A single row under the address bar carrying the
 * device dropdown, custom width/height inputs and a rotate button. The row is
 * toggled by the 📱 button in BrowserToolbar; while it's open the view is
 * narrowed to the emulated device size and centered in the stage.
 *
 * IMPORTANT: the dropdown popup is a renderer-DOM surface, but the page behind
 * it is an OS-level WebContentsView that floats ABOVE the renderer DOM — no
 * z-index can stack the popup over it. So while the dropdown is open, the
 * parent hides the active view (onMenuOpenChange(true) → hide; false →
 * show+resync), exactly like the confirm-destroy dialog already does.
 */
export function DeviceToolbar({
  device,
  customWidth,
  customHeight,
  orientation,
  onViewportChange,
  onMenuOpenChange,
  onClose,
}: {
  device: BrowserDevicePreset;
  customWidth?: number;
  customHeight?: number;
  orientation?: BrowserOrientation;
  /** Switch the device/viewport: preset id + optional custom dims/orientation. */
  onViewportChange: (
    device: BrowserDevicePreset,
    opts?: { width?: number; height?: number; orientation?: BrowserOrientation },
  ) => void;
  /** Called when the dropdown opens/closes so the parent can hide/re-show the
   *  WebContentsView (see component comment). */
  onMenuOpenChange: (open: boolean) => void;
  /** Collapse the toolbar (same as clicking the 📱 toggle again). */
  onClose: () => void;
}) {
  const { t } = useI18n();
  const current = BROWSER_DEVICE_PRESETS.find((p) => p.id === device);
  const landscape = orientation === "landscape";
  // Localized preset label: PRESET_LABEL_KEYS covers the Chinese contract
  // labels; product names pass through.
  const presetLabel = (id: BrowserDevicePreset, fallback: string) => {
    const key = PRESET_LABEL_KEYS[id];
    return key ? t(key) : fallback;
  };
  const dimsLabel =
    device === "custom"
      ? `${customWidth ?? 390}×${customHeight ?? 844}`
      : device === "desktop"
        ? t("browser.fullWidth")
        : landscape
          ? `${current?.height ?? ""}×${current?.width ?? ""}`
          : `${current?.width ?? ""}×${current?.height ?? ""}`;
  // "desktop" is the no-emulation default; resolve a friendly label so the
  // trigger never shows the raw id.
  const displayLabel =
    device === "desktop" ? t("browser.desktopDevice") : presetLabel(device, current?.label ?? device);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-edge bg-surface-muted/60 px-2">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-content-subtle">
        {t("browser.device")}
      </span>

      {/* Device dropdown — every preset + 自定义. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <Select.Root
          value={device}
          onValueChange={(v) => onViewportChange(v as BrowserDevicePreset, { orientation })}
          onOpenChange={(open) => onMenuOpenChange(open)}
        >
          <Select.Trigger
            title={t("browser.deviceTitle", { label: displayLabel, dims: dimsLabel })}
            className="max-w-[10rem]"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {device === "desktop" ? (
                <IconDeviceDesktop size={14} className="shrink-0" />
              ) : (
                <IconDeviceMobile size={14} className="shrink-0" />
              )}
              <span className="truncate text-[11px] font-medium text-content">
                {displayLabel}
              </span>
              <span className="shrink-0 text-[10px] text-content-subtle">{dimsLabel}</span>
            </span>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner align="end">
              <Select.Popup>
                <Select.List>
                  {BROWSER_DEVICE_PRESETS.map((p) => (
                    <Select.Item key={p.id} value={p.id}>
                      <Select.ItemText>
                        <span className="flex items-center gap-1.5">
                          {p.id === "desktop" ? (
                            <IconDeviceDesktop size={14} className="shrink-0" />
                          ) : (
                            <IconDeviceMobile size={14} className="shrink-0" />
                          )}
                          <span>{presetLabel(p.id, p.label)}</span>
                          {p.id !== "desktop" && p.id !== "custom" && (
                            <span className="ml-auto pl-3 text-[10px] text-content-subtle">
                              {landscape
                                ? `${p.height}×${p.width}`
                                : `${p.width}×${p.height}`}
                            </span>
                          )}
                        </span>
                      </Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      </div>

      {/* Custom dims inputs — visible only when "custom" is selected. Changing
          them re-emits the viewport so main re-applies emulation live.

          ⚠️ `Number(...) || 默认值` **只挡得住 0 和 NaN**(空输入框),挡不住手打进去的
          负数和 1.5 —— `-5` 和 `1.5` 都是真值,会原样发出去。而契约那一侧是
          `z.number().int().min(1)`,于是这份入参直接被拒,用户看到的是浏览器面板
          **正中间糊着一屏 zod JSON**,还看不出是哪一项不对(见 `ipc/browser.ts` 的
          `describeInputError`)。

          下面 `min={1}` 那个属性管不住这个:HTML 的 min/max 只约束**方向键微调**和
          表单校验,手打的字照样进 onChange。要挡住的是**发出去的那个值**,所以在这里
          夹:先取整(`Math.round`),再抬到 ≥1。 */}
      {device === "custom" && (
        <div className="flex shrink-0 items-center gap-1">
          <input
            type="number"
            min={1}
            value={customWidth ?? 390}
            onChange={(e) => {
              const w = clampViewportPx(Number(e.target.value), 390);
              onViewportChange("custom", { width: w, height: customHeight ?? 844, orientation });
            }}
            title={t("browser.customWidthTitle")}
            aria-label={t("browser.customWidthAria")}
            className="h-6 w-14 rounded border border-edge bg-surface px-1 text-center text-[10px] text-content outline-none focus:border-accent"
          />
          <span className="text-[10px] text-content-subtle">×</span>
          <input
            type="number"
            min={1}
            value={customHeight ?? 844}
            onChange={(e) => {
              const h = clampViewportPx(Number(e.target.value), 844);
              onViewportChange("custom", { width: customWidth ?? 390, height: h, orientation });
            }}
            title={t("browser.customHeightTitle")}
            aria-label={t("browser.customHeightAria")}
            className="h-6 w-14 rounded border border-edge bg-surface px-1 text-center text-[10px] text-content outline-none focus:border-accent"
          />
          <span className="text-[10px] text-content-subtle">px</span>
        </div>
      )}

      {/* Rotate — swaps portrait/landscape. Only meaningful for mobile
          presets/custom (desktop has no emulation to rotate). */}
      {device !== "desktop" && (
        <button
          type="button"
          onClick={() =>
            onViewportChange(device, {
              width: customWidth,
              height: customHeight,
              orientation: landscape ? "portrait" : "landscape",
            })
          }
          title={landscape ? t("browser.rotateToPortrait") : t("browser.rotateToLandscape")}
          aria-label={landscape ? t("browser.rotateToPortrait") : t("browser.rotateToLandscape")}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors",
            landscape
              ? "bg-accent/20 text-accent"
              : "text-content-muted hover:bg-surface-hover hover:text-content",
          )}
        >
          <PiArrowsClockwise size={14} />
        </button>
      )}

      <div className="flex-1" />

      {/* Collapse the toolbar (same affordance as the 📱 toggle). */}
      <button
        type="button"
        onClick={onClose}
        title={t("browser.collapseDeviceToolbar")}
        aria-label={t("browser.collapseDeviceToolbar")}
        className="flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
      >
        <IconChevronDown size={13} className="rotate-180" />
        {t("browser.collapse")}
      </button>
    </div>
  );
}
