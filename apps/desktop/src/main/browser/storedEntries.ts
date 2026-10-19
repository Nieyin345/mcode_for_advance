/**
 * Browser bookmarks and address history share one durable read contract.
 *
 * A missing setting row is an empty list; an existing but corrupt row is NOT.
 * Treating an unreadable JSON array (or dropping malformed members) as []
 * would let any subsequent add/remove/clear overwrite the only copy of a
 * user's bookmarks/history. Callers must surface this error and preserve bytes.
 *
 * Both collections have exactly one main-process writer via SettingRepo.
 * This decoder deliberately doesn't write or auto-repair user data.
 */
import { SettingRepo } from "@main/store/repositories.js";

export type BrowserEntryTimeField = "addedAt" | "at";

/**
 * A scheme prefix alone is not a navigable address: "http:javascript" and
 * "file:../../private" passed the old regex and were persisted as bookmarks.
 * Use the same strict predicate for bookmarks and main-frame history writes.
 * Do not normalize the input: keeping the exact visited URL is important
 * for bookmark removal/deduplication, so reject ambiguous spelling instead.
 */
export function isStorableBrowserUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() !== url || /[\u0000-\u0020\u007f]/.test(url)) return false;
  if (!/^(https?:\/\/|file:\/\/)/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.hostname.length > 0;
    }
    if (parsed.protocol === "file:") {
      return parsed.pathname.length > 1;
    }
    return false;
  } catch {
    return false;
  }
}

function isStoredBrowserEntry(
  value: unknown,
  timeField: BrowserEntryTimeField,
): value is { url: string; title: string; addedAt: number; at: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.url === "string" &&
    row.url.length > 0 &&
    typeof row.title === "string" &&
    typeof row[timeField] === "number" &&
    Number.isFinite(row[timeField]) &&
    (row[timeField] as number) >= 0;
}

/** Read all records or throw. No partial successful list is ever writable. */
export function readStoredBrowserEntries<T>(
  settingKey: string,
  timeField: BrowserEntryTimeField,
): T[] {
  const raw = SettingRepo.get(settingKey); // SQL read failures remain errors
  if (raw === null) return []; // missing setting is the only empty default

  const corrupt = (cause: string): never => {
    // Never include raw persisted JSON in an error message (user history/URLs).
    throw new Error(`${settingKey} 存档损坏（${cause}）；已拒绝覆盖原始记录，请先备份后修复。`);
  };
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return corrupt("JSON 解析失败");
  }
  if (!Array.isArray(entries)) return corrupt("不是记录数组");
  const invalidIndex = entries.findIndex((entry) => !isStoredBrowserEntry(entry, timeField));
  if (invalidIndex !== -1) return corrupt(`第 ${invalidIndex + 1} 条记录结构不合法`);
  return entries as T[];
}
