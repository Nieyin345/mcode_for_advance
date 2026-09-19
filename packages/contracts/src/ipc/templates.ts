/**
 * 模版库:列表 / 新建 / 改名 / 回收站 / 预览 / 清单的 RPC 入参 + 根目录设置键。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";
import { TEMPLATE_KINDS } from "../templates.js";

/* ── 模版库 ── */

export const TemplateKindSchema = z.enum(TEMPLATE_KINDS);

/** 不传 kind = 列全部类目。 */
export const TemplateListSchema = z.object({ kind: TemplateKindSchema.optional() });
export type TemplateListInput = z.infer<typeof TemplateListSchema>;

export const TemplateAddSchema = z.object({
  kind: TemplateKindSchema,
  name: z.string().min(1),
  /** 要收进这个模版的文件 / 文件夹(绝对路径)。**文件夹会被整包复制** ——
   *  LaTeX 模版往往是 .cls + .tex + 图片的一整套。 */
  sourcePaths: z.array(z.string().min(1)).min(1).max(200),
});
export type TemplateAddInput = z.infer<typeof TemplateAddSchema>;

/** 指向某一条模版:类目 + 目录名(目录名就是显示名)。 */
export const TemplateEntryRefSchema = z.object({
  kind: TemplateKindSchema,
  dirName: z.string().min(1),
});
export type TemplateEntryRefInput = z.infer<typeof TemplateEntryRefSchema>;

/**
 * 给一条模版改名。
 *
 * 模版库是文件系统即事实源、目录名即显示名,所以"改名"就是**把那个目录改名** ——
 * 与文献库那边改一个分类的名字是同一件事的两个形态(那边改的是数据库里一行,
 * 这边改的是磁盘上一个目录)。渲染端只给新名字,净化与重名检查都在主进程做。
 */
export const TemplateRenameSchema = z.object({
  kind: TemplateKindSchema,
  /** 现在叫什么(定位用)。 */
  dirName: z.string().min(1),
  /** 要改成什么。会被 `sanitizeTemplateName` 净化,净化后为空则拒绝。 */
  name: z.string().min(1),
});
export type TemplateRenameInput = z.infer<typeof TemplateRenameSchema>;

/**
 * 把一条模版挂到某次对话的输入框上 —— 左栏右键「添加到当前对话」。
 *
 * `sessionId` 要显式给:消息要发给**指定会话**的输入框,而左栏与那个输入框不是同一棵
 * 组件树。主进程生成清单(每次重写)后用既有的 `composer:attach` 广播回去,那个会话
 * 的 ChatPane 自己认领 —— 与「+ → 模版」和文献库那条路是同一条,所以两边效果必然一致。
 */
export const TemplatesAttachToChatSchema = z.object({
  sessionId: z.string().min(1),
  kind: TemplateKindSchema,
  /** 省略 = 挂**整个类目**(「全部 LaTeX 模版」那一行),清单里列全这个类目的每一条。 */
  dirName: z.string().min(1).optional(),
});
export type TemplatesAttachToChatInput = z.infer<typeof TemplatesAttachToChatSchema>;

/**
 * 指向某一条模版里的**一个文件**:类目 + 目录名 + 相对条目目录的路径。
 *
 * `relPath` 的写法与 `TemplateFile.relPath` 逐字一致(正斜杠分隔,可能带子目录)——
 * 界面上的文件行拿到的就是它,原样传回来。**主进程必须把它当不可信输入**:解析出的
 * 绝对路径要落在条目目录内部,而且必须是扫描时列出来的那些文件之一,否则一段构造过的
 * 请求就能把机器上任意文件读成预览内容。
 */
export const TemplateFileRefSchema = z.object({
  kind: TemplateKindSchema,
  dirName: z.string().min(1),
  relPath: z.string().min(1),
});
export type TemplateFileRefInput = z.infer<typeof TemplateFileRefSchema>;

