/**
 * 资料库类型注册表的**主进程运行时** —— 设置表里那份 JSON 的读写与缓存。
 *
 * 契约层(`@contracts/libraryTypes`)只给纯校验;这里补上"住在主进程"的那一半:
 * 真身存 settings KV(键 `library.types`),读走缓存、写清缓存。**模块被 import 不碰
 * DB** —— 首次 `loadLibraryTypes()` 才读(那时 initDb 必已完成:调用方都是 IPC
 * handler 与运行时,都在 `awaitDb()` 之后),无头冒烟也因此能安全打包本模块。
 *
 * ## 为什么整表替换而不是增删改
 *
 * 注册表是一份**有顺序**的小表(界面按序展示),用户的编辑动作(加一类、改个名、
 * 调个顺序)在 UI 上就是编辑一张列表,保存时把整份列表交回来。逐条增删改的 RPC
 * 要把"顺序"也建模成参数,而那正是 UI 里已经现成的东西 —— 让界面直接交最终态。
 */

import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";
import {
  BUILTIN_LIBRARY_TYPES,
  DEFAULT_LIBRARY_GROUPS,
  LIBRARY_GROUPS_SETTING_KEY,
  LIBRARY_TYPES_SETTING_KEY,
  parseLibraryGroupsJson,
  parseLibraryTypesJson,
  type LibraryGroupMeta,
  type LibraryTypeMeta,
  type LibraryTypePurpose,
} from "@contracts/libraryTypes";

let cache: LibraryTypeMeta[] | null = null;
let groupsCache: LibraryGroupMeta[] | null = null;

/** 出厂表的一份可变副本 —— 调用方拿到手改也不污染常量。 */
function builtinCopy(): LibraryTypeMeta[] {
  return BUILTIN_LIBRARY_TYPES.map((t) => ({ ...t }));
}

/** 当前生效的类型表(内置 8 类 + 用户自建,按保存顺序)。首次调用后走缓存。 */
export function loadLibraryTypes(): LibraryTypeMeta[] {
  if (cache) return cache;
  const raw = SettingRepo.get(LIBRARY_TYPES_SETTING_KEY);
  if (raw === null) {
    // 没存过 = 用户没动过类型。返回出厂表,老用户的行为与统一前逐字一致。
    cache = builtinCopy();
    return cache;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`[library] 类型注册表不是合法 JSON,退回出厂表(键 ${LIBRARY_TYPES_SETTING_KEY})`);
    cache = builtinCopy();
    return cache;
  }
  const res = parseLibraryTypesJson(parsed);
  if (!res.ok) {
    // 存坏了(手工改库 / 旧版本残留)**不能炸启动** —— 退回出厂表,问题在日志里说清。
    // 也不顺手覆写坏数据:那可能是用户刚编辑到一半的,等他下次保存时自然被校验拦住。
    log.warn(`[library] 类型注册表校验失败(${res.error}),暂用出厂表`);
    cache = builtinCopy();
    return cache;
  }
  cache = res.types;
  return cache;
}

/** 某个类型的定义。没注册返回 undefined。 */
export function kindMeta(id: string): LibraryTypeMeta | undefined {
  return loadLibraryTypes().find((t) => t.id === id);
}

/** 这个 kind 现在是不是注册表认得的。收 `unknown`,同 `isLibraryKind` 的旧约定。 */
export function isRegisteredKind(value: unknown): boolean {
  return typeof value === "string" && kindMeta(value) !== undefined;
}

/** 一类的用途(material=给 AI 读的资料 / format=让 AI 照着写的格式)。 */
export function kindPurposeOf(id: string): LibraryTypePurpose {
  return kindMeta(id)?.purpose ?? "material";
}

/** 一类的显示名:注册表有就用;没有(kind 未注册/手工写进库的)退回 id 本身 ——
 *  显示一个原始 id 也比显示 undefined 强。 */
export function kindDisplayName(id: string): string {
  return kindMeta(id)?.name ?? id;
}

/**
 * 整表替换。校验通过才落库;失败返回**说人话的错误**(parse 的原文),调用方直接
 * 显示给用户。落库成功后缓存立即更新 —— 同一进程里的下一次 load 不用再等 DB。
 */
export function saveLibraryTypes(types: unknown): { ok: true } | { ok: false; error: string } {
  const res = parseLibraryTypesJson(types);
  if (!res.ok) return res;
  SettingRepo.set(LIBRARY_TYPES_SETTING_KEY, JSON.stringify(res.types));
  cache = res.types;
  return { ok: true };
}

/** 只给无头冒烟用:测试之间要能回到"没存过"的状态。生产代码不要调。 */
export function resetLibraryTypesCacheForTest(): void {
  cache = null;
  groupsCache = null;
}

/* ── 大类(左栏分组) ── */

/**
 * 当前生效的大类表。**合并校验**:组里引用的类型 id 若已不在类型注册表里(被删了),
 * 从组里**过滤掉**而不是拒绝保存 —— 删类型不该被"还有组在引用它"挡住,过滤后左栏
 * 少一个 tab 是准确的现实。没存过 = 出厂两组。
 */
export function loadLibraryGroups(): LibraryGroupMeta[] {
  if (groupsCache) return groupsCache;
  const known = new Set(loadLibraryTypes().map((t) => t.id));
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
  const merged = (groups ?? DEFAULT_LIBRARY_GROUPS.map((g) => ({ ...g, kinds: [...g.kinds] })))
    .map((g) => ({ ...g, kinds: g.kinds.filter((k) => known.has(k)) }))
    .filter((g) => g.kinds.length > 0);
  groupsCache = merged;
  return merged;
}

/** 整表替换大类。校验同类型表:失败原样交回说人话的错误。 */
export function saveLibraryGroups(groups: unknown): { ok: true } | { ok: false; error: string } {
  const res = parseLibraryGroupsJson(groups);
  if (!res.ok) return res;
  SettingRepo.set(LIBRARY_GROUPS_SETTING_KEY, JSON.stringify(res.groups));
  groupsCache = res.groups;
  return { ok: true };
}

/** 一个类型所属大类的「给 AI 的说明」。类型没进任何组、或组没写,都是 undefined。 */
export function kindGroupPromptOf(kind: string): string | undefined {
  return loadLibraryGroups().find((g) => g.kinds.includes(kind))?.prompt;
}
