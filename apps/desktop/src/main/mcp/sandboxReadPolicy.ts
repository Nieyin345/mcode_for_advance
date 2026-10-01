/**
 * **公网那条通路的「沙箱外只读」名单** —— 资料库与技能库。
 *
 * ## 为什么要有
 *
 * 公网 MCP(ChatGPT 直连)的文件工具被锁在「这条链接对应的项目目录」里(见
 * `agentTools.ts` 的 `resolveAgainstCwd`)。可资料库在 `<数据根>/library`、技能在
 * `~/.mcode/skills`,都不在项目里 —— 于是 `agent_context` 报出来的库文件路径一读就
 * 「路径越界」,技能里提到的脚本/附属文件也读不了。用户要的恰恰是「远程的 AI 能看我的
 * 资料库、能用本地的技能」。
 *
 * 所以这里给沙箱开**只读**的两扇门(写工具仍然只认项目目录,一行没放宽):
 *   - **技能库**:整棵树可读、可列、可搜(里面只有用户装的技能)。
 *   - **资料库**:可读,但**守屏蔽规则**(设置 → 资料库类型):
 *       · 属于被屏蔽条目的文件(整条挡)→ 拒;
 *       · 按文件类型屏蔽的扩展名 → 拒;
 *       · 设了任何屏蔽规则时,不许在库里**全文搜索**(grep 会把被挡的内容带出来)——
 *         改用 `library_search` 找条目,再读它给的路径。
 *     库外「关联进来的」文件(条目的 `file_path` 指向用户别处的文件/目录)也算库里的
 *     东西,同样只读、同样守屏蔽。
 *
 * 判定只在「路径在沙箱外」时才被问到;沙箱内的照旧放行,桌面本机会话(没有沙箱)根本
 * 不走这里。
 */
import path from "node:path";
import { defaultSkillsRoot } from "@main/lib/skillEngines.js";
import { libraryRoot, markdownArtifact } from "@main/library/paths.js";
import { aiVisibleFilesOf, readableFilesOf } from "@main/library/fileImport.js";
import { isFileSuppressed, loadSuppress, suppressionReasonOfItem } from "@main/library/suppress.js";
import { LibraryRepo } from "@main/store/repositories.js";

/** 读一份文件 / 列目录(含 glob)/ 全文搜索(grep、后台搜索)。 */
export type SandboxReadKind = "read" | "list" | "search";

/**
 * - `null` = 放行;
 * - 字符串 = 拒绝,原话给模型;
 * - `undefined` = 不归这里管(既不在库里也不在技能里)→ 调用方报原来那句「路径越界」。
 */
export type SandboxReadCheck = (abs: string, kind: SandboxReadKind) => string | null | undefined;

/** `agent_context` 里一条资料库条目(给 AI 看的那份)。 */
export interface AiLibraryEntry {
  title?: string;
  kind?: string;
  year?: number;
  venue?: string;
  /** 绝对路径;转录优先,其次原件;被按类型屏蔽的那份不给。 */
  path: string | null;
}

/** 前 `limit` 条里给 AI 看的那些 + 被屏蔽挡掉了几条。读不到库时返回 null。 */
export type LibraryForAi = (limit: number) => { items: AiLibraryEntry[]; hidden: number } | null;

function within(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

interface OwnedRoot {
  /** 条目的一份文件,或它那一包(转录目录、目录型条目)。 */
  root: string;
  /** 这条被整条屏蔽的原因;null = 没挡。 */
  reason: string | null;
}

/** 条目 → 它在磁盘上占的那几处。几秒内复用 —— 一次 `agent_read_files` 会连问好几回。 */
let cache: { at: number; roots: OwnedRoot[] } | null = null;
const CACHE_MS = 3_000;
const MAX_ITEMS = 100_000;

function ownedRoots(): OwnedRoot[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.roots;
  const rule = loadSuppress();
  const anyNodeRule = rule.nodes.length > 0 || rule.extensions.length > 0;
  const roots: OwnedRoot[] = [];
  for (const item of LibraryRepo.list({ limit: MAX_ITEMS }).items) {
    const reason = anyNodeRule ? suppressionReasonOfItem(item.id) : null;
    const files = readableFilesOf(item);
    if (files.markdown) roots.push({ root: markdownArtifact(files.markdown).path, reason });
    if (files.original) roots.push({ root: files.original, reason });
  }
  cache = { at: now, roots };
  return roots;
}

/** 测试 / 库变更后想立刻生效时用。 */
export function resetSandboxReadCacheForTest(): void {
  cache = null;
}

export const sandboxReadCheck: SandboxReadCheck = (abs, kind) => {
  let skills: string | null = null;
  try {
    skills = defaultSkillsRoot();
  } catch {
    skills = null;
  }
  if (skills && within(skills, abs)) return null;

  let lib: string;
  let owners: OwnedRoot[];
  try {
    lib = libraryRoot();
    owners = ownedRoots().filter((o) => within(o.root, abs));
  } catch {
    return undefined;
  }
  const inLibrary = within(lib, abs);
  if (!inLibrary && owners.length === 0) return undefined;

  const blocked = owners.find((o) => o.reason);
  if (blocked) {
    return (
      `这份文件属于资料库里被屏蔽的条目(${blocked.reason}被屏蔽了,设置 → 资料库类型),不能读。` +
      `如实告诉用户"被屏蔽了",不要当不存在,也不要凭空引用。`
    );
  }
  if (kind === "read" && isFileSuppressed(abs)) {
    return `${path.extname(abs).toLowerCase()} 文件在资料库里被屏蔽了(设置 → 资料库类型),不能读。如实告诉用户。`;
  }
  if (kind === "search") {
    const rule = loadSuppress();
    if (rule.nodes.length > 0 || rule.extensions.length > 0) {
      return (
        "资料库设了屏蔽规则,不能在库里全文搜索(会把被屏蔽的内容带出来)。" +
        "请用 library_search 按关键词找条目,再用 agent_read_file 读它给出的路径。"
      );
    }
  }
  return null;
};

/**
 * `agent_context` 的资料库清单 —— 与 `library_search` 同一口径:整条被屏蔽的不列
 * (`suppressionReasonOfItem`),按文件类型屏蔽的那份不给路径(`aiVisibleFilesOf`)。
 * 路径是**绝对路径**(库里存的是相对库根的;原样给出去,公网那条路会按项目目录解析)。
 */
export const libraryForAi: LibraryForAi = (limit) => {
  try {
    const items: AiLibraryEntry[] = [];
    let hidden = 0;
    for (const it of LibraryRepo.list({ limit }).items) {
      if (suppressionReasonOfItem(it.id)) {
        hidden += 1;
        continue;
      }
      const files = aiVisibleFilesOf(it);
      items.push({ title: it.title, path: files.markdown || files.original || null });
    }
    return { items, hidden };
  } catch {
    return null;
  }
};
