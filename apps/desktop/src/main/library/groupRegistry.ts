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
import { bumpLibraryChangeRevision } from "./changeRevision.js";
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

/**
 * 整表替换大类。校验失败原样交回说人话的错误。
 *
 * ⚠️ **写完必须让进程内缓存一致。** 这里是 `library.groups` 的正常写口;通用
 * `setting.set`(Agent / 自定义面板)是同一个键的第二个写者,它经
 * {@link invalidateLibraryGroupsCache} 接进来 —— 两个写者都要走同一份失效逻辑
 * (从前只有本函数刷 `groupsCache`,第二个写者落库后进程一直停在旧表上直到重启,
 * 而 `groupPromptOf` / `nodeTypes` 的「资料」候选都读这份缓存)。
 */
export function saveLibraryGroups(groups: unknown): { ok: true } | { ok: false; error: string } {
  const res = parseLibraryGroupsJson(groups);
  if (!res.ok) return res;
  SettingRepo.set(LIBRARY_GROUPS_SETTING_KEY, JSON.stringify(res.groups));
  groupsCache = res.groups;
  // 大类表也参与资料库归属判定(`suppressionReasonOfItem` 的 `group:` 键)与公网
  // 只读门的缓存,所以"表变了"这件事要 bump 到共享版本号上(见 `changeRevision.ts`)。
  bumpLibraryChangeRevision();
  return { ok: true };
}

/** 一个大类(id)的「给 AI 的说明」。组不存在、或组没写,都是 undefined。 */
export function groupPromptOf(groupId: string): string | undefined {
  return loadLibraryGroups().find((g) => g.id === groupId)?.prompt;
}

/**
 * 丢掉缓存,让下一次 `loadLibraryGroups()` 重新读 settings。
 *
 * 只给无头回归用(同 `suppress.ts` 的 `resetSuppressCacheForTest`):缓存是成品行为
 * (设置改动走 `saveLibraryGroups` 时同步刷新,见上),而"首次读就失败"与"缓存之后
 * 表被外部改坏"这两种状态,**只有在缓存为空时才观测得到** —— 不重置的话,测试里
 * 注入一次读失败会静默命中旧缓存,断言假绿。
 */
export function resetLibraryGroupsCacheForTest(): void {
  groupsCache = null;
}

/**
 * 设置键被**别的入口**改写后让本模块的缓存失效 —— 当前唯一的生产调用方是
 * `ipc/claude.ts` 的通用 `setting.set`。
 *
 * 与 `saveLibraryGroups` 里的同步刷新是同一条规矩的第二个写者:通用写落库后本进程
 * 的 `groupsCache` 不会自己知道,不失效就一直停在旧表上(读取面见 `groupPromptOf` /
 * `manifest.ts` / `nodeTypes.ts` 的「资料」候选)。
 */
export function invalidateLibraryGroupsCache(): void {
  groupsCache = null;
  bumpLibraryChangeRevision();
}
