/**
 * Claude Desktop attachment tile, adapted from
 * open-claude-ui/code-examples/AttachmentCard.tsx (MIT).
 *
 * Unlike a content-tag chip, this renders only non-text attachments (file
 * references and staged images). Caller retains the existing send/preview/
 * remove semantics; presentation must never change the prompt payload.
 */
import { forwardRef } from "react";
import { cn } from "@renderer/lib/cn.js";
import { IconFile, IconX } from "@renderer/lib/icons.js";
import { Badge } from "@renderer/components/ui/badge.js";

/** Upstream mid-truncation: preserve the extension in a separate unshrinking span. */
export function truncateFileName(fileName: string, maxLen = 18): { head: string; ext: string } {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === 0) {
    if (fileName.length <= maxLen) return { head: fileName, ext: "" };
    return { head: fileName.slice(0, maxLen - 1) + "…", ext: "" };
  }
  const ext = fileName.slice(dotIndex);
  const stem = fileName.slice(0, dotIndex);
  if (fileName.length <= maxLen) return { head: stem, ext };
  const availableStemLen = Math.max(4, maxLen - ext.length - 1);
  return { head: stem.slice(0, availableStemLen) + "…", ext };
}

/** A compact uppercase badge, matching the upstream TS/PY/PDF/CSV mapping. */
export function attachmentBadge(name: string, isImage = false): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toUpperCase();
  if (!name.includes(".") || name.endsWith(".")) return isImage ? "IMG" : "FILE";
  return ext.slice(0, 4) || "FILE";
}

interface Props {
  name: string;
  imageSrc?: string;
  detail?: string;
  open?: boolean;
  onToggle?: () => void;
  onRemove: () => void;
  removeLabel: string;
  className?: string;
}

export const AttachmentTile = forwardRef<HTMLSpanElement, Props>(function AttachmentTile(
  { name, imageSrc, detail, open = false, onToggle, onRemove, removeLabel, className }, ref,
) {
  const truncated = truncateFileName(name, 14);
  return (
    <span
      ref={ref}
      data-cds="MessageAttachmentsFile"
      data-layout="tile"
      className={cn(
        "composer-tag-in group/tile relative isolate inline-flex size-[calc(7.5rem*var(--cds-rem-scale,1))] shrink-0 flex-col justify-between rounded-[var(--radius-card)] border border-edge bg-surface p-3 text-content transition-[border-color,box-shadow] focus-within:border-accent",
        open ? "border-accent" : "hover:border-content-subtle/40",
        className,
      )}
      style={{ boxShadow: "0 1px 3px rgb(0 0 0 / 0.08), 0 6px 16px rgb(0 0 0 / 0.08)" }}
      title={name}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
        className="flex h-full min-w-0 flex-col justify-between rounded-[var(--radius-btn-xs)] text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        aria-label={name}
        aria-expanded={onToggle ? open : undefined}
      >
        {imageSrc ? (
          <span className="relative min-h-0 w-full flex-1 overflow-hidden rounded-[calc(var(--radius-card)-4px)]">
            <img src={imageSrc} alt={name} className="h-full w-full object-cover" />
            <Badge variant="neutral" className="absolute bottom-1 left-1 rounded bg-surface/90 px-1.5 font-mono text-[10px] font-bold uppercase">
              {attachmentBadge(name, true)}
            </Badge>
          </span>
        ) : (
          <span className="flex items-start justify-between gap-1">
            <Badge variant="neutral" className="rounded px-1.5 font-mono text-[10px] font-bold uppercase tracking-wider">
              {attachmentBadge(name)}
            </Badge>
            <IconFile size={18} className="shrink-0 text-content-subtle" />
          </span>
        )}
        <span className="mt-1 flex min-w-0 max-w-full items-center text-[11px] leading-tight">
          <span className="min-w-0 truncate">{truncated.head}</span>
          <span className="shrink-0">{truncated.ext}</span>
        </span>
        {detail && <span className="mt-0.5 truncate font-mono text-[10px] text-content-subtle">{detail}</span>}
      </button>
      <button
        type="button"
        data-cds-attachment-remove=""
        onClick={onRemove}
        aria-label={removeLabel}
        title={removeLabel}
        className="absolute -end-2 -top-2 z-10 flex size-7 items-center justify-center rounded-full border border-edge bg-surface-muted text-content-subtle shadow-[var(--shadow-popover)] transition-colors hover:border-danger/50 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <IconX size={12} />
      </button>
    </span>
  );
});
