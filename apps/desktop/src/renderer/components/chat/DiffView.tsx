import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { lineDiff } from "@renderer/lib/lineDiff.js";

/**
 * Render a flat diff list as a monospace line column with per-op coloring.
 * Includes gutter line numbers for old/new so reviewers can correlate changes.
 *
 * Shared by the per-tool EditToolCard (inside the message stream) and the
 * turn-level TurnFilesCard (expanded per-file diff). Extracted from
 * MessageBlocks.tsx so both call sites render diffs identically.
 *
 * The diff input is the return type of `lineDiff()` — typed via `typeof` to
 * avoid a value import we don't need here (this component only renders).
 */
export function DiffView({
  diff,
  scrollClassName = "max-h-80",
}: {
  diff: ReturnType<typeof lineDiff>;
  /** Class controlling the scroll container's height. Overridable so
   *  full-screen consumers (the mobile viewer overlay) can fill the screen;
   *  defaults to the inline card height. */
  scrollClassName?: string;
}) {
  const { t } = useI18n();
  if (diff.length === 0) {
    return (
      <div className="rounded-[var(--radius-code)] bg-surface-muted/60 p-2 text-content-subtle [font-size:var(--chat-fs-xs)]">
        {t("chatStream.diff.noChanges")}
      </div>
    );
  }
  // Compute old/new line numbers in a single pass: an inserted line has
  // no old-side number; a deleted line has no new-side; equal lines have
  // both. Numbers give the user a stable "where am I" reference while
  // reviewing the patch.
  const rows = annotateDiffWithLineNumbers(diff);

  return (
    // 【ARC-005 V2】代码/Diff 圆角走 CDS 的 --radius-code（12px），与代码块一致。
    <div className={cn("overflow-auto rounded-[var(--radius-code)] bg-surface-muted/60 font-mono leading-relaxed [font-size:var(--chat-fs-xs)]", scrollClassName)}>
      {rows.map((d, i) => {
        // 【ARC-005】Diff 行色走 --diff-* token（styles.css 的 .diff-add /
        // .diff-del / .diff-context）：原先这里硬编码 `bg-red-500/15
        // text-red-600 dark:text-red-400`（green 同构），暗色变体写死在 class
        // 串里、不随 token 体系走。token 值仍取自这些 Tailwind 色阶，只是
        // 收进浅/深两套定义（含 forced-colors 的形状区分）。
        const opBg =
          d.op === "delete" ? "diff-del" : d.op === "insert" ? "diff-add" : "diff-context";
        return (
          <div key={i} className={cn("flex items-start whitespace-pre", opBg)}>
            <span className="w-10 shrink-0 select-none border-r border-edge/40 px-1.5 text-right text-content-subtle">
              {d.oldNo ?? ""}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-edge/40 px-1.5 text-right text-content-subtle">
              {d.newNo ?? ""}
            </span>
            <span className="w-3 shrink-0 select-none pl-1 text-content-subtle">
              {d.op === "delete" ? "−" : d.op === "insert" ? "+" : " "}
            </span>
            <span className="flex-1 pl-1 pr-2">{d.text || "\u00A0"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Build a per-line record with old/new line numbers. A single pass keeps
 *  the numbering correct regardless of which side contributes to each
 *  line. The accumulator is local so the function is safe to call from
 *  any render without stateful side effects. */
export function annotateDiffWithLineNumbers(
  diff: ReturnType<typeof lineDiff>,
): Array<ReturnType<typeof lineDiff>[number] & { oldNo: number | null; newNo: number | null }> {
  let oldNo = 0;
  let newNo = 0;
  return diff.map((d) => {
    const oldN = d.op === "insert" ? null : ++oldNo;
    const newN = d.op === "delete" ? null : ++newNo;
    return { ...d, oldNo: oldN, newNo: newN };
  });
}
