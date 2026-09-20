/**
 * 档案怎么分类摆 —— 「同一种节点的档案归一组」这条规则的**唯一**一处实现。
 *
 * ## 为什么按节点类型分组
 *
 * 一份档案**没有自己的类型**(见 `@contracts/agentProfile` 文件头):它是"某个节点类型
 * 的一组参数"。所以"这份档案是干什么用的"这个问题的答案,就是它那个类型的名字 —— 按
 * 时间、按大小都答不了这个问题。节点类型多起来之后(用户的原话:「现在的节点类型也
 * 多了」),一个平铺的列表会让人分不出「读论文」和「读论文(快)」哪个是子 agent、
 * 哪个是对话节点。
 *
 * ## 分组次序
 *
 * 先按清单声明的 `category`(「通用」「自动化」…),再按类型名;认不出来的(清单没
 * 装、或那份清单没写分类)一律排在**最后** —— 认不出来的东西不该夹在认得出来的中间。
 *
 * 组内**保持传进来的次序**(主进程按 `updatedAt` 倒序给,最近改的在前),这里不重排:
 * 重排一次,列表里那份"我刚改完的"就会跑到别处去。
 *
 * ## 为什么是个纯函数
 *
 * 分类是这一页唯一有算术的部分(哪些组、谁前谁后、空组要不要留),而 SSR 下的渲染只
 * 能断言"第一批长什么样" —— 点不了、选不了。所以把这段算出来单独测:冒烟脚本直接喂
 * 数组断言次序,不必先渲染一棵树(同 `groupNodeTypes` 的做法)。
 */
import type { AgentProfile } from "@contracts/agentProfile";
import type { NodeTypeCatalog, NodeTypeManifest } from "@contracts/nodeType";

export interface AgentProfileGroup {
  /** 分组键:节点类型 id。 */
  typeId: string;
  /** 那个类型的清单。`null` = 这台机器上没装(不是错误,但它跑不了)。 */
  manifest: NodeTypeManifest | null;
  /** 组标题:清单名;没装时回落成类型 id 本身 —— 总得有个东西可读。 */
  title: string;
  /** 清单声明的分类。没装或没写就是空串(排在最后那一档)。 */
  category: string;
  /** 这一组里的档案,次序与传进来的一致。 */
  profiles: AgentProfile[];
}

/**
 * 把一批档案按节点类型归组并排好序。
 *
 * `catalog` 允许为 `null`(那一次 IPC 还没回来 / 拉不到):这时所有类型都查不到清单,
 * 于是退化成"一族一组、标题是类型 id"。这是**暂时**的样子,不该让页面空着 ——
 * 档案本身还在磁盘上,看得见比等清单更重要。
 */
export function groupProfiles(
  profiles: AgentProfile[],
  catalog: NodeTypeCatalog | null,
): AgentProfileGroup[] {
  const byId = new Map<string, AgentProfileGroup>();
  for (const profile of profiles) {
    const manifest = catalog?.entries.find((e) => e.id === profile.type)?.manifest ?? null;
    const existing = byId.get(profile.type);
    if (existing) {
      existing.profiles.push(profile);
      continue;
    }
    byId.set(profile.type, {
      typeId: profile.type,
      manifest,
      title: manifest?.name ?? profile.type,
      category: manifest?.category ?? "",
      profiles: [profile],
    });
  }
  // 排序键是**两个字段拼起来的**:只按分类排的话,同一类里的几组次序就看 Map 的插入
  // 次序(也就是磁盘给的次序)了 —— 那会随"最近改过哪一份"而变,列表每存一次就跳一下。
  return [...byId.values()].sort((a, b) => {
    if (a.category !== b.category) {
      // 空分类排最后:它是"没得说",不是"排在最前面"。
      if (a.category.length === 0) return 1;
      if (b.category.length === 0) return -1;
      return a.category.localeCompare(b.category);
    }
    return a.title.localeCompare(b.title);
  });
}
