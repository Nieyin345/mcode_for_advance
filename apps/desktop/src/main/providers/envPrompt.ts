/**
 * **环境背景** —— 让 agent 一开局就知道"我在什么机器上、有哪些项目和文档"。
 *
 * ## 它解决什么
 *
 * 本地三个引擎(claude / pi / codex)拿到的上下文里,原先只有记忆、角色、工作流三段,
 * **没有"环境"这一段** —— agent 不知道用户有哪些项目、项目在哪、文档库在哪、库里有什么。
 * 用户问"我有哪些项目"时,它只能去 `ls` 猜,或者干脆不知道。
 *
 * ## 为什么是**现查**而不是写一份快照
 *
 * 环境会变:用户新建了项目、删了某个文档、把库搬到别处。写死的快照过一会儿就是假的。
 * 所以这里每次都现读 repo —— 用户删了某个文档,下次构建出来的清单里就没有它了。
 *
 * ⚠️ **但"下次"指的是新会话,不是下一轮。** 主对话的上下文在提供方自己的会话记录里
 * (靠 `resume` 续),注入过的那份就留在历史里了,同一会话内刷新不了。理由是架构的,
 * 不是这里能绕过的 —— 详见 `@contracts/provider` 的 `envPrompt` 那段注释。
 *
 * ## 为什么库里给**标题**而不是文件名
 *
 * 库里的文件是**内容寻址**的(`papers/ab/cd/<sha256>.pdf`,见 `library/paths.ts` 文件头)。
 * 只给路径的话,agent 看到一屏哈希文件名,完全不知道哪篇是哪篇 —— 那这份清单就没用了。
 * 元数据(标题/类型/年份/期刊)在数据库里,这里从 `LibraryRepo` 取。
 *
 * ## 容错:拿不到就不注入
 *
 * 项目为空、库为空、查询抛异常 —— 一律返回 `null`,调用方跳过这一段。环境信息不该
 * 拦住一次对话(与 `webUpstream.ts` 的 `webEnvBlockFor` 同款取舍)。
 *
 * ## 为什么格式化那半不在这里
 *
 * 这个文件 import 了 `repositories`(→ db → electron),于是**整块都被拉出无头 smoke**。
 * 拼字符串那半本来是可以直接断言的,被连累得测不到 —— 所以它在 `envPromptFormat.ts`
 * (纯的、不 import 任何主进程目录)。这里只做"查库 → 交给格式化"。
 */
import { ProjectRepo, LibraryRepo } from "@main/store/repositories.js";
import { libraryRoot } from "@main/library/paths.js";
import { suppressionReasonOfItem } from "@main/library/suppress.js";
import { trashedItemIds } from "@main/library/trash.js";
import { log } from "@main/lib/logger.js";
import { MAX_LISTED_ITEMS, formatEnvSections, selectVisibleItems, type EnvSnapshot } from "./envPromptFormat.js";

// 纯的那半从这里转出,调用方(与测试)不必知道文件是怎么拆的。
export {
  MAX_LISTED_ITEMS,
  formatEnvSections,
  selectVisibleItems,
  envPromptFingerprint,
  type EnvSnapshot,
} from "./envPromptFormat.js";

/**
 * **取**当前环境（项目 + 库），不做格式化。`agent_context` 工具与
 * {@link buildEnvPrompt} 共用这一份 —— 两处各查一遍会漂（硬规矩 2）。
 *
 * 拿不到就返回 null（库还没建 / 数据库没就绪）—— 调用方各自决定怎么办。
 */
export function readEnvSnapshot(currentProjectPath: string | null, options: { includeLibrary?: boolean } = {}): EnvSnapshot | null {
  try {
    const projects = ProjectRepo.list()
      .filter((p) => !p.archived)
      .map((p) => ({ name: p.name, path: p.path }));
    const root = options.includeLibrary ? libraryRoot() : "";
    let items: EnvSnapshot["items"] = [];
    let total = 0;
    if (options.includeLibrary) {
      // 与所有其它面向 AI 的资料库出口(`manifest.ts` 的 dropSuppressed、
      // `libraryServer.ts`、`sandboxReadPolicy.ts`)一致:被屏蔽(设置里"不给 AI 看")
      // 与回收站里的条目**不列进系统提示词**——否则模型会看到标题/年份/路径,用户
      // 以为屏蔽生效了其实没有。宽容量 + 再筛,避免筛完凑不满一页。
      const trashed = trashedItemIds();
      const overFetch = Math.max(MAX_LISTED_ITEMS * 2, MAX_LISTED_ITEMS + 50);
      const listed = LibraryRepo.list({ limit: overFetch });
      items = selectVisibleItems(
        listed.items,
        (id) => trashed.has(id),
        (id) => suppressionReasonOfItem(id) !== null,
        MAX_LISTED_ITEMS,
      );
      total = listed.total;
    }
    return {
      currentProjectPath,
      projects,
      libraryRoot: root,
      items,
      totalItems: total,
    };
  } catch (err) {
    log.warn(`env: 查询环境失败: ${(err as Error).message}`);
    return null;
  }
}

/**
 * 构建环境块。`currentProjectPath` 是**当前会话所属项目**的路径(可以是 null —— 会话
 * 可能还没绑到项目上)。
 *
 * 返回 null 表示"没什么可说的"(一个项目都没有、库也空)—— 调用方跳过后就不注入,
 * 而不是塞一段空标题进去。
 */
export function buildEnvPrompt(currentProjectPath: string | null): string | null {
  // Desktop provider context is unchanged; public agent_context opts in separately.
  const snap = readEnvSnapshot(currentProjectPath, { includeLibrary: true });
  if (!snap) return null;
  return formatEnvSections(snap);
}
