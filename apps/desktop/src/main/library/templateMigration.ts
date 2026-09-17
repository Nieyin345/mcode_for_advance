/**
 * 模版 → 统一资料库的**一次性迁移**(M4)。
 *
 * ## 迁的是什么,不迁的是什么
 *
 * 旧模版库的五类目(ppt/latex/word/code/image)在统一资料库里有了对应的类型
 * (见 `@contracts/libraryTypes`:`ppt→slides`、`word→document`,其余原名)。每条
 * 模版在库里落一条 **linked 条目**:`entryMode: "linked"` + `filePath` 指向模版
 * 目录的绝对路径 —— 文件原地不动,"目录即条目"的形状原样保留(见 `fileImport.ts`
 * 文件头对 linked 的说明)。
 *
 * **模版目录与 `main/templates/` 一概不动**:磁盘是旧模版库的事实源,渲染端退役
 * 前还得照常读写它。迁移只是让同一些目录在资料库里也"有一条",两边读的是同一份
 * 文件,不存在第二份拷贝。
 *
 * ## 幂等
 *
 * 判据是 `entryMode === "linked" && filePath === 目录绝对路径`(与
 * `importGenericFiles` 的查重同一条):已有就跳过。所以重复跑不会翻倍;用户之后
 * 在资料库里把某条改了名/挪了库,也不影响"那条 linked 记录"继续算数 —— 迁移
 * 只负责把没进来的送进来。
 */
import { log } from "@main/lib/logger.js";
import type { LibraryKind } from "@contracts/library";
import type { TemplateKind } from "@contracts/templates";
import { LibraryRepo, SettingRepo } from "@main/store/repositories.js";
import { listTemplates } from "@main/templates/store.js";

/** 迁移完成标记(settings KV)。存在且为 "1" = 已经跑过,启动时不再扫。 */
export const TEMPLATES_MIGRATED_SETTING_KEY = "library.templatesMigrated";

/** 旧模版类目 → 注册表类型的映射(见 `@contracts/libraryTypes` 顶部的那句话)。 */
const TEMPLATE_KIND_TO_LIBRARY: Record<TemplateKind, LibraryKind> = {
  ppt: "slides",
  word: "document",
  latex: "latex",
  code: "code",
  image: "image",
};

/**
 * 把旧模版库的每条模版登记成资料库的 linked 条目。**幂等**,可重复调用。
 *
 * @returns 本次**新建**的条目数(跳过的不计 —— 调用方要报的是"迁了什么进去",
 *          不是"库里已有多少条模版")。
 */
export function migrateTemplatesToLibrary(): number {
  const entries = listTemplates();
  // 查重要对**全库**比 filePath。list 默认 200 条上限是给分页 UI 的,这里必须
  // 拿全量 —— 少查到一条,那次迁移就会多建一条重复的 linked 条目。
  const all = LibraryRepo.list({ limit: 1_000_000 }).items;
  let created = 0;
  for (const e of entries) {
    const exists = all.some((i) => i.entryMode === "linked" && i.filePath === e.path);
    if (exists) continue;
    LibraryRepo.upsert({
      kind: TEMPLATE_KIND_TO_LIBRARY[e.kind],
      title: e.dirName,
      entryMode: "linked",
      filePath: e.path,
    });
    created += 1;
  }
  SettingRepo.set(TEMPLATES_MIGRATED_SETTING_KEY, "1");
  return created;
}

/**
 * 启动时的入口:**没跑过才跑一次**,结果写进日志。跑坏了不拦启动 —— 迁移失败的
 * 代价只是"模版暂时不在资料库里"(旧模版库照常可用),把应用挡在启动画面外
 * 反而是更大的坏。
 */
export function migrateTemplatesToLibraryOnce(): void {
  if (SettingRepo.get(TEMPLATES_MIGRATED_SETTING_KEY) === "1") return;
  try {
    const created = migrateTemplatesToLibrary();
    log.info(`[library] 模版迁移完成:新建 ${created} 条 linked 条目(标记 ${TEMPLATES_MIGRATED_SETTING_KEY})`);
  } catch (err) {
    log.warn(`[library] 模版迁移失败(旧模版库不受影响,下次启动重试):${(err as Error).message}`);
  }
}
