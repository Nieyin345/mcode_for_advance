/**
 * 大类表（左栏分组）的主进程运行时 —— settings 里那份 JSON 的读写与缓存。
 *
 * 原身是 `kindRegistry.ts`（类型注册表 + 大类表）；kind 退役后（2026-09-24）只留
 * 大类这一半 —— 分类经 `library_collections.group_id` 直接挂大类，不再经过类型层。
 *
 * **模块被 import 不碰 DB** —— 首次 `loadLibraryGroups()` 才读（那时 initDb 必已完成），
 * 无头冒烟因此能安全打包本模块。
 */

import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";
import {
  DEFAULT_LIBRARY_GROUPS,
  LIBRARY_GROUPS_SETTING_KEY,
  parseLibraryGroupsJson,
  type LibraryGroupMeta,
} from "@contracts/libraryTypes";

let groupsCache: LibraryGroupMeta[] | null = null;

/**
 * 当前生效的大类表。没存过 = 出厂两组。
 */
export function loadLibraryGroups(): LibraryGroupMeta[] {
  if (groupsCache) return groupsCache;
  const raw = SettingRepo.get(LIBRARY_GROUPS_SETTING_KEY);
  let parsed: unknown = null;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn(`[library] 大类表不是合法 JSON,退回出厂分组(键 ${LIBRARY_GROUPS_SETTING_KEY})`);
    }
  }
  let groups: LibraryGroupMeta[] | null = null;
  if (parsed !== null) {
    const res = parseLibraryGroupsJson(parsed);
    if (res.ok) groups = res.groups;
    else log.warn(`[library] 大类表校验失败(${res.error}),暂用出厂分组`);
  }
  groupsCache = groups ?? DEFAULT_LIBRARY_GROUPS.map((g) => ({ ...g }));
  return groupsCache;
}

/** 整表替换大类。校验失败原样交回说人话的错误。 */
export function saveLibraryGroups(groups: unknown): { ok: true } | { ok: false; error: string } {
  const res = parseLibraryGroupsJson(groups);
  if (!res.ok) return res;
  SettingRepo.set(LIBRARY_GROUPS_SETTING_KEY, JSON.stringify(res.groups));
  groupsCache = res.groups;
  return { ok: true };
}

/** 一个大类(id)的「给 AI 的说明」。组不存在、或组没写,都是 undefined。 */
export function groupPromptOf(groupId: string): string | undefined {
  return loadLibraryGroups().find((g) => g.id === groupId)?.prompt;
}
