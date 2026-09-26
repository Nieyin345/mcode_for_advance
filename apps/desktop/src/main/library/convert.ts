/** Read-only transcript inspection. Transcription belongs to configured workflows, not core imports. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import type { LibraryConversionRow, LibraryItem } from "@contracts/library";
import { fromLibraryRelative } from "@main/library/paths.js";
import { LibraryRepo } from "@main/store/repositories.js";

export type ConvertSource = "mineru";

export type ConvertOutcome =
  | {
      ok: true;
      source: ConvertSource;
      mdRelPath: string;
      chars: number;
      alreadyDone?: boolean;
      /** 跳过的原因是"这份是用户采纳进来的" —— 与 `alreadyDone`(已经有 md 了)分开,
       *  调用方据此才能对用户说清是哪一种跳过。 */
      skipped?: boolean;
    }
  | { ok: false; error: string };

/** 解析该条目引用的源文件；attached 路径随库根解析，linked 保持原绝对路径。 */
function sourcePathOf(item: LibraryItem): { path: string; rel: string } | null {
  const raw = item.filePath || item.pdfPath;
  if (!raw) return null;
  const abs = isAbsolute(raw) ? raw : fromLibraryRelative(raw);
  return { path: abs, rel: raw };
}

const AUTOMATION_REQUIRED = "软件核心不执行转录或清理转录产物。请通过已配置的自动化在线转录，再采纳生成的 Markdown。";

/** @deprecated Compatibility only: never uploads, extracts, overwrites or deletes files. */
export async function convertItemToMarkdown(
  _item: LibraryItem,
  _opts: { force?: boolean } = {},
): Promise<ConvertOutcome> {
  return { ok: false, error: AUTOMATION_REQUIRED };
}

/** @deprecated Fail closed; existing documents and associations remain untouched. */
export async function repairCollectionMarkdown(collectionId: string): Promise<{
  converted: number; cleaned: number; failed: Array<{ id: string; error: string }>;
}> {
  return { converted: 0, cleaned: 0, failed: [{ id: collectionId, error: AUTOMATION_REQUIRED }] };
}

export function conversionReport(selectedItems?: LibraryItem[]): LibraryConversionRow[] {
  const items = selectedItems ?? LibraryRepo.list({ limit: 100_000 }).items;
  return items.map((item) => {
    // 右侧旧字段名 hasPdf 仍为 IPC 兼容而保留；这里表示 MinerU 可尝试的源文件是否存在。
    const sourceFile = sourcePathOf(item);
    const hasPdf = Boolean(sourceFile && existsSync(sourceFile.path) && statSync(sourceFile.path).isFile());
    const mdAbs = item.mdPath ? fromLibraryRelative(item.mdPath) : null;
    const hasMd = Boolean(mdAbs) && existsSync(mdAbs!);

    let imageRefs = 0;
    let assetsOk = true;
    if (hasMd && mdAbs) {
      try {
        const md = readFileSync(mdAbs, "utf8");
        const dir = dirname(mdAbs);
        // 只认相对引用 —— http(s): 和 data: 是外链,不在我们的库里
        for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
          const ref = m[1].trim();
          if (/^(https?:|data:)/i.test(ref)) continue;
          imageRefs += 1;
          // 图片路径可能带 %20 之类,解码后再查
          const rel = decodeURIComponent(ref.split(/[?#]/)[0]);
          if (!existsSync(join(dir, ...rel.split("/")))) assetsOk = false;
        }
      } catch {
        // 读不了就当资源不齐 —— 这正是需要用户重转的情况
        assetsOk = false;
      }
    }

    // 产物形态:本地抽取落的是平铺的 `<sha>.md`;而在 `markdown/imported/<id>/`
    // 下面那种(外部工具转好之后挂进来的)是**目录**形态。两者都算已转。
    const source: "local" | "imported" | "none" = !hasMd
      ? "none"
      : item.mdPath!.includes("/imported/")
        ? "imported"
        : "local";

    return {
      id: item.id,
      title: item.title,
      hasPdf,
      hasMd,
      assetsOk,
      imageRefs,
      complete: hasMd && assetsOk,
      source,
    };
  });
}
