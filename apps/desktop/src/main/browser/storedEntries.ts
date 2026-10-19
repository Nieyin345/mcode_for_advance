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
