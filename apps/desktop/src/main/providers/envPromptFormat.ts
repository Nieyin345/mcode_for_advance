/**
 * **环境块的纯格式化** —— 与查库那半分开,这样无头 smoke 能直接断言它(不会因为
 * 同一模块 import 了 db/electron 而整块进不去)。
 *
 * ⚠️ 这个文件**不许** import db / electron / 任何主进程目录 —— 那是它存在的全部理由。
 * 查库那半在 `envPrompt.ts`(它 import 了 `repositories`),两边共用 {@link EnvSnapshot}。
 */

/** 清单里最多列多少条库条目。库可能有几千条,全列会撑爆上下文。 */
export const MAX_LISTED_ITEMS = 50;

/**
 * 从库条目里挑出**能列进系统提示词**的那些:去掉回收站里的,以及被屏蔽
 * (设置里"不给 AI 看")的。**纯函数**——屏蔽判定与回收站集合由调用方
 * (`envPrompt.ts`,它拿得到 repo)算好传进来,这样这里不碰 IO、无头可测。
 *
 * 为什么必须有这一步:环境块是**面向 AI** 的出口,必须和 `manifest.ts` 的
 * `dropSuppressed`、`libraryServer.ts`、`sandboxReadPolicy.ts` 用同一套可见性规则
 * ——否则用户屏蔽了一条,系统提示词里照样带着它的标题/年份/路径。
 */
export function selectVisibleItems<T extends { id: string }>(
  items: readonly T[],
  isTrashed: (id: string) => boolean,
  isSuppressed: (id: string) => boolean,
  limit: number = MAX_LISTED_ITEMS,
): T[] {
  return items.filter((i) => !isTrashed(i.id) && !isSuppressed(i.id)).slice(0, limit);
}

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
    const lines = [`## 资料库`, `库根:${snap.libraryRoot}`];
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
      "⚠️ 资料库**只读** —— 可以读、可以复制进项目,但不要在库里新建/修改/删除任何东西。",
      "要改某份内容:先读出来(或复制到当前项目目录),在**项目里**改。",
    );
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}

/** 供测试与去重用的指纹 —— 内容没变就不必重复注入。 */
export function envPromptFingerprint(prompt: string | null): string {
  if (!prompt) return "";
  // 只取 长度+首尾 会漏中段改动:库里换/挪一条、或改个同长度的标题,首尾与长度都不变,
  // 指纹就不变 → 环境块不会重新注入(而同一会话内只靠这指纹决定要不要重灌)。
  // 加一段中段采样,成本可忽略,却把这种"命中碰撞"的概率压到实用上可忽略。
  const mid = prompt.length > 128 ? prompt.slice(prompt.length / 2 - 32, prompt.length / 2 + 32) : "";
  return `${prompt.length}:${prompt.slice(0, 64)}:${mid}:${prompt.slice(-64)}`;
}
