import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openEscapeLayer, claimEscape } from "@renderer/lib/escapeLayer.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import {
  IconCopy,
  IconCheck,
  IconX,
  IconArrowsMaximize,
  IconLoader2,
  IconPhotoOff,
} from "@renderer/lib/icons.js";
import { isImageFile, type ContentTag } from "@renderer/lib/contentTag.js";
import { previewPosition } from "./previewGeometry.js";
import { visibleTagImage } from "./tagPreviewImageIdentity.js";

/**
 * Floating preview for a single content-tag chip. Shows the full pasted
 * content in a scrollable box with a Copy button.
 *
 * Anchored to the chip that opened it: positioned at the chip's TOP-RIGHT,
 * rising above the chip when there's room, or dropping below it when the
 * chip sits too close to the top of the viewport. Right-aligned to the
 * chip's right edge so the popover reads as growing out of the chip.
 *
 * Dismiss:
 *   - Click outside (mousedown on document)
 *   - ESC key
 *   - Clicking the chip body again (handled by parent — sets openTagId=null)
 *
 * The Copy button uses `navigator.clipboard.writeText` and shows a brief
 * "已复制" state on success. Falls back to selecting the text if the
 * clipboard API is unavailable (rare in Electron, but defensive).
 */
export function TagPopover({
  tag,
  anchorRect,
  onClose,
  onExpand,
}: {
  tag: ContentTag;
  /** Bounding box of the chip that opened this popover, in viewport
   *  coordinates (getBoundingClientRect). Drives the fixed positioning. */
  anchorRect: DOMRect;
  onClose: () => void;
  /** Expand the tag's content back into the composer as inline text, removing
   *  the chip. Only provided for paste tags — file/element tags are path
   *  references whose "content" is an @path string, not user text. */
  onExpand?: () => void;
}) {
  const { t } = useI18n();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyGenerationRef = useRef(0);
  useEffect(() => {
    copyGenerationRef.current++;
    setCopyState("idle");
    return () => { copyGenerationRef.current++; };
  }, [tag.id, tag.content]);
  // Actual measured preview geometry: a right-edge-only offset can push a
  // 28rem popover off-screen if a message/chip is near the left edge.
  const [position, setPosition] = useState({ left: 8, top: 8 });

  // Image preview state (file tags whose path is a previewable image). null =
  // loading, "" = error/unreadable, non-empty = valid data URL.
  const isImage = isImageFile(tag);
  const [naturalFor, setNaturalFor] = useState<string | null>(null);
  const natural = naturalFor === tag.filePath && !!tag.filePath;
  // Results are bound to the source file identity. State resetting in a
  // passive effect happens AFTER the next render, so unkeyed dataUrl briefly
  // showed the previous image when switching between two attachment chips.
  const [imageResult, setImageResult] = useState<{ path: string; url: string } | null>(null);
  const dataUrl = visibleTagImage(tag.filePath, imageResult);

  // Lazily load the image bytes as a data URL when the popover opens for an
  // image tag. Reuses the same IPC the IDE's image preview uses
  // (api.file.readBinary), which allows both project files and paste-temp
  // paths (the latter is explicitly whitelisted in main's readBinary handler).
  useEffect(() => {
    if (!isImage || !tag.filePath) return;
    let cancelled = false;
    setImageResult(null);
    setNaturalFor(null);
    api.file
      .readBinary({ filePath: tag.filePath })
      .then(({ dataUrl: url }) => {
        if (!cancelled) setImageResult({ path: tag.filePath!, url });
      })
      .catch(() => {
        if (!cancelled) setImageResult({ path: tag.filePath!, url: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [isImage, tag.filePath]);

  // The preview is portaled out of the virtualized chat list. Clamp its
  // *measured* width/height on every size change, not only top vs bottom.
  // ResizeObserver also catches image decode and font reflow without a window
  // resize; keep the callback idempotent to avoid observer-render loops.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const recompute = () => {
      const next = previewPosition(anchorRect, el.offsetWidth, el.offsetHeight,
        window.innerWidth, window.innerHeight);
      setPosition((old) => old.left === next.left && old.top === next.top ? old : next);
    };
    recompute();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(recompute);
    observer?.observe(el);
    window.addEventListener("resize", recompute);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [anchorRect.top, anchorRect.right, anchorRect.bottom, dataUrl, natural]);

  // Outside-click + ESC close. Mirrors ModelDropdown's pattern.
  useEffect(() => {
    // 【ARC-005 V2】Esc 关最内层：与其它弹层叠在一起时只有栈顶能关自己
    // （以前各弹层都直接 onClose，一次 Esc 会连关两层）。
    const closeEscapeLayer = openEscapeLayer("chat.tag-popover");
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The chip that opened us is OUTSIDE the popover; allow clicks on
      // chips to fall through to the parent's toggle handler instead of
      // swallowing them. We treat anything not inside the popover as
      // "outside" and close — the chip's own onClick will reopen.
      if (popoverRef.current && !popoverRef.current.contains(t)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
        if (!claimEscape("chat.tag-popover")) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // A scroll outside the preview moves the virtualized chip, invalidating
    // its captured rect. Close rather than leaving a detached floating box.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      closeEscapeLayer();
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  // Reset the "copied" pill after a moment so it doesn't linger.
  useEffect(() => {
    if (copyState === "idle") return;
    const t = setTimeout(() => setCopyState("idle"), 1200);
    return () => clearTimeout(t);
  }, [copyState]);

  const handleCopy = async () => {
    const generation = ++copyGenerationRef.current;
    try {
      await navigator.clipboard.writeText(tag.content);
      if (generation === copyGenerationRef.current) setCopyState("copied");
    } catch {
      if (generation === copyGenerationRef.current) setCopyState("failed");
    }
  };

  const style: React.CSSProperties = {
    position: "fixed",
    left: position.left,
    top: position.top,
  };

  // Image tags: pop up the bare image with no frame — no header bar, border,
  // or backdrop. Just the floating image anchored near the chip, plus a small
  // unobtrusive status pill while loading / on error. Closes on outside-click
  // / ESC (handled above); click the image to toggle zoom-to-fit / enlarged.
  if (isImage) {
    return (
      <div ref={popoverRef} style={style} role="region" aria-label={tag.preview} className="z-30">
        {dataUrl === null ? (
          <div className="flex items-center gap-1.5 rounded-[var(--radius-btn-xs)] bg-surface/95 px-2.5 py-1.5 text-[11px] text-content-subtle shadow-[var(--shadow-popover)]">
            <IconLoader2 size={12} className="animate-spin" /> {t("chat.tagPopover.loadingImage")}
          </div>
        ) : !dataUrl ? (
          <div className="flex flex-col items-center gap-1.5 rounded-[var(--radius-btn-xs)] bg-surface/95 px-4 py-3 text-center text-content-subtle shadow-[var(--shadow-popover)]">
            <IconPhotoOff size={24} className="opacity-70" />
            <p className="text-[11px]">{t("chat.tagPopover.imageFailed")}</p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setNaturalFor(natural ? null : tag.filePath ?? null)}
            aria-label={natural ? t("chat.tagPopover.shrink") : t("chat.tagPopover.enlarge")}
            aria-pressed={natural}
            className="rounded-[var(--radius-btn-xs)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <img
              src={dataUrl}
              alt={tag.preview}
              className={cn(
                "rounded-[var(--radius-btn-xs)] shadow-[var(--shadow-popover)]",
                natural ? "cursor-zoom-out" : "cursor-zoom-in",
              )}
              style={
                natural
                  ? { maxWidth: "calc(100vw - 16px)", maxHeight: "min(90vh, calc(100vh - 16px))" }
                  : { maxWidth: "min(32rem, calc(100vw - 16px))", maxHeight: "70vh" }
              }
            />
          </button>
        )}
      </div>
    );
  }

  // Paste / element tags: framed popover with header (char count + copy/close).
  return (
    <div
      ref={popoverRef}
      style={style}
      role="region"
      aria-label={tag.preview}
      className="z-30 flex max-h-[min(15rem,calc(100vh-16px))] w-[min(28rem,calc(100vw-16px))] flex-col overflow-hidden rounded-[var(--radius-btn-xs)] border border-edge bg-surface shadow-[var(--shadow-popover)]"
    >
      {/* Header: char count + copy/close */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-surface-muted px-2 py-1">
        <span className="text-[10px] text-content-muted">
          {t("chat.tagPopover.charCount", { n: tag.content.length.toLocaleString() })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="cds-hover-ghost flex min-h-8 items-center gap-0.5 rounded-[var(--radius-btn-xs)] px-2 py-0.5 text-[10px] text-content-muted transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title={t("chat.tagPopover.copyFull")}
            aria-label={copyState === "copied" ? t("common.copied") : copyState === "failed" ? t("chat.tagPopover.copyFailed") : t("chat.tagPopover.copyFull")}
          >
            {copyState === "copied" ? (
              <>
                <IconCheck size={11} /> {t("common.copied")}
              </>
            ) : copyState === "failed" ? (
              t("chat.tagPopover.copyFailed")
            ) : (
              <>
                <IconCopy size={11} /> {t("common.copy")}
              </>
            )}
          </button>
          {onExpand && (
            <button
              type="button"
              onClick={() => {
                onExpand();
                onClose();
              }}
              className="cds-hover-ghost flex min-h-8 items-center gap-0.5 rounded-[var(--radius-btn-xs)] px-2 py-0.5 text-[10px] text-content-muted transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              title={t("chat.tagPopover.expandTitle")}
              aria-label={t("chat.tagPopover.expandTitle")}
            >
              <IconArrowsMaximize size={11} /> {t("chat.tagPopover.expand")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="cds-hover-ghost flex size-8 items-center justify-center rounded-[var(--radius-btn-xs)] text-content-muted transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title={t("common.close")}
            aria-label={t("chat.tagPopover.closePreview")}
          >
            <IconX size={11} />
          </button>
        </div>
      </div>
      {/* Content: scrollable, preserves whitespace, monospace so code/log
          pastes keep their original column alignment. */}
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono [font-size:var(--chat-fs-xs)] leading-relaxed text-content">
        {tag.content}
      </pre>
    </div>
  );
}
