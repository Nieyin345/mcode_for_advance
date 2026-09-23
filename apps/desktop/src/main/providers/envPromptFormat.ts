/**
 * **环境块的纯格式化** —— 与查库那半分开,这样无头 smoke 能直接断言它(不会因为
 * 同一模块 import 了 db/electron 而整块进不去)。
 *
 * ⚠️ 这个文件**不许** import db / electron / 任何主进程目录 —— 那是它存在的全部理由。
 * 查库那半在 `envPrompt.ts`(它 import 了 `repositories`),两边共用 {@link EnvSnapshot}。
 */

/** 清单里最多列多少条库条目。库可能有几千条,全列会撑爆上下文。 */
export const MAX_LISTED_ITEMS = 50;

/** 构建环境块的**输入** —— 与 IO 分开,好让纯格式化那半能被无头 smoke 直接测。 */
export interface EnvSnapshot {
  currentProjectPath: string | null;
  projects: { name: string; path: string }[];
  /** 库根;空串表示库还不存在。 */
  libraryRoot: string;
  /** 清单里要列出的条目(已截断)。 */
  items: {
    title?: string;
    kind?: string;
    year?: number;
    venue?: string;
    pdfPath?: string;
    mdPath?: string;
  }[];
  /** 库里条目**总数**(可能大于 items.length)。 */
  totalItems: number;
}

/** 一条库条目在清单里的一行 —— 标题在前,路径垫后(agent 要读正文时用得着)。 */
function formatItem(item: EnvSnapshot["items"][number]): string {
  const bits = [
    item.title?.trim() || "(无标题)",
    item.kind ? `[${item.kind}]` : "",
    item.year ? String(item.year) : "",
    item.venue ? `· ${item.venue}` : "",
  ].filter(Boolean);
  // 优先给 markdown(可读文本),没有才给 pdf —— agent 读 md 比读 pdf 省事。
  const path = item.mdPath || item.pdfPath;
  return `- ${bits.join(" ")}${path ? `\n  文件: ${path}` : ""}`;
}

/**
 * 把一份快照拼成给模型的文本。**不碰 IO**,所以能直接断言。
 *
 * 返回 null = 没什么可说的(没项目、也没库),调用方跳过这一段。
 */
export function formatEnvSections(snap: EnvSnapshot): string | null {
  const sections: string[] = [];

  if (snap.projects.length > 0 || snap.currentProjectPath) {
    const lines = [
      `## 项目`,
      `当前项目:${snap.currentProjectPath ?? "(这个对话还没绑定项目)"}`,
    ];
    if (snap.projects.length > 0) {
      lines.push(`全部项目(${snap.projects.length} 个):`);
      for (const p of snap.projects) lines.push(`- ${p.name}\n  路径: ${p.path}`);
    }
    sections.push(lines.join("\n"));
  }

  if (snap.libraryRoot) {
    const lines = [`## 文档库`, `库根:${snap.libraryRoot}`];
    if (snap.totalItems === 0) {
      lines.push("(库是空的)");
    } else {
      lines.push(
        `共 ${snap.totalItems} 条${snap.totalItems > snap.items.length ? `,下面列前 ${snap.items.length} 条` : ""}:`,
      );
      for (const it of snap.items) lines.push(formatItem(it));
    }
    // 权限写清楚:库**只读**。agent 要改内容,得先复制进项目再改。
    lines.push(
      "",
      "⚠️ 文档库**只读** —— 可以读、可以复制进项目,但不要在库里新建/修改/删除任何东西。",
      "要改某份内容:先读出来(或复制到当前项目目录),在**项目里**改。",
    );
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}

/** 供测试与去重用的指纹 —— 内容没变就不必重复注入。 */
export function envPromptFingerprint(prompt: string | null): string {
  // 不引 crypto:这里只需要"变了没有",一个长度 + 首尾片段就够,且省一次 hash。
  if (!prompt) return "";
  return `${prompt.length}:${prompt.slice(0, 64)}:${prompt.slice(-64)}`;
}
