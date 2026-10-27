/**
 * 【T20】**扩展工坊**的共享形状 —— 渲染端与主进程共用的一份契约（纯模块）。
 *
 * ## 边界（为什么单独一个文件）
 *
 * 本文件的字段只是**草稿 / 状态 / 回执 / 安装交接**的声明式形状，不含任何权限或授权语义：
 *
 *  - `ExtensionWorkshopDraft` 装在 `ModuleManifestSchema` 外面，`manifest` 字段直接复用
 *    冻结的清单 schema（权限闭集、贡献形状、程序形状都由它保证）。
 *  - `ExtensionWorkshopState` 是**工坊自己的进度记录**（尝试次数 / 可回滚点 / 上次错误），
 *    **不是授权** —— ModuleHost 的任何判定都不读它（见 `extensionWorkshop.ts` 顶注）。
 *  - `ExtensionWorkshopReport` 是 `buildExtension` 的返回值：`ok` 只表示「可以拿去给用户
 *    确认了」，**不表示已安装**。
 *  - `ExtensionWorkshopInstallHandoff` 是给 AI 的**交接材料**：它只说明「下一步该调
 *    什么、带哪些字段」，`requiresUserApproval` 恒为 `true` —— 本契约里没有任何
 *    「已批准」字段，AI 拿不到也不可能构造出代签。
 *
 * ## ⚠️ 现状：本契约**已失去实现**（2026-10-27 核）
 *
 * 全仓唯一消费者是 `appControl/tools.ts` 的一行 `import type`（编译期擦除，**已删**）。
 * 原本的实现 `apps/desktop/src/main/modules/extensionWorkshop.ts`（887 行）**已从工作区删除**
 * （未提交，`git status` 显示 `D`）。`extension_build` / `extension_workshop_status` 两个工具
 * 从未注册。文件末尾的 `ExtensionWorkshopInstallHandoff` 还指着一个已删除的 RPC。
 * **改这里的形状之前先确认它到底还服务谁** —— 目前答案是没有。
 *
 * ## 明确不做
 *
 *  - 不新增权限名：权限列表就是 `MODULE_PERMISSION_NAMES`（schema 层拒未知值）。
 *  - 不做市场 / 签名 / VS Code 扩展生成：草稿只有一份 `program.source`，不打包、不签名。
 *  - **不新增 RpcMap**：新增一条会强制重生成 `apiCatalog.generated.ts` 与
 *    `appPermission.ts`，后者会把目录已前进、权限映射尚未归类的方法一次性收进委托面
 *    （放宽方向），那是其他卡/生成器的边界。
 */
import { z } from "zod";
import { ModuleManifestSchema } from "./modules.js";

/** 草稿文件在工坊目录里的名字（`<数据根>/extension-workshop/<模块 id>/` 下）。 */
export const WORKSHOP_DRAFT_FILE = "draft.json";
/** 状态文件在工坊目录里的名字（**不是授权**，见文件头）。 */
export const WORKSHOP_STATE_FILE = "state.json";
/** 入口文件的名字（清单本身；程序在 `manifest.program.source`）。 */
export const WORKSHOP_ENTRY_FILE = "extension.json";
/** 沙箱冒烟的样例文件前缀（真实文件名 = 前缀 + 清单贡献声明的第一个扩展名）。 */
export const WORKSHOP_SAMPLE_PREFIX = "sample";

/**
 * 【T20】修复重试的**硬上限** —— 达到后 `buildExtension` 一律被拒（`repair_exhausted`），
 * 必须由**用户**重新发起生成。这个数不是"再多试几次"的调参：修复循环没有上限就是
 * 一个能被模型驱动的（准）无限重试，而每次重试都在花用户的钱与时间。
 */
export const WORKSHOP_MAX_REPAIR_ATTEMPTS = 3;

/** 工坊里最多允许存在的模块目录数（草稿也是可写盘的东西，不能让 AI 无限铺）。 */
export const WORKSHOP_MAX_DRAFTS = 64;

/**
 * 一份扩展草稿：**声明式清单 + 给用户看的说明**。
 *
 * `manifest` 直接是冻结的 `ModuleManifest`（含 `program.source` 函数工厂）——
 * 这里不定义第二份清单形状，也不允许草稿里出现清单之外的字段。
 */
export const ExtensionWorkshopDraftSchema = z.object({
  manifest: ModuleManifestSchema,
  /** AI 对「这个扩展要干什么」的一句话说明（给用户卡片 / 回执用）。 */
  notes: z.string().max(2000).optional(),
}).strict();
export type ExtensionWorkshopDraft = z.infer<typeof ExtensionWorkshopDraftSchema>;

/** 工坊会话状态。**不是授权** —— 只有进度、可回滚点与上次错误。 */
export const WORKSHOP_STATUSES = ["drafting", "installed", "rolledBack", "repair_exhausted"] as const;
export const ExtensionWorkshopStatusSchema = z.enum(WORKSHOP_STATUSES);
export type ExtensionWorkshopStatus = z.infer<typeof ExtensionWorkshopStatusSchema>;

/** 装机后的可回滚点（记录用）。
 *  ⚠️ 原文写「真正的回滚走 `modules.remove` 的既有事务」—— **`modules.remove` 已删除**
 *  （2026-10-27 核）。现在卸载走 `modules.theiaInstalled({op:...})`，且只有用户能操作。 */
export const ExtensionWorkshopInstalledSchema = z.object({
  version: z.string(),
  /** 装机前的版本（同 id 升级）。`null` = 全新安装。 */
  previousVersion: z.string().nullable(),
  installedAt: z.string(),
  /** 草稿目录（回滚时清理；可能为 null —— 例如清单是用户从别处粘来的）。 */
  workspaceDir: z.string().nullable(),
  rolledBackAt: z.string().optional(),
}).strict();

export const ExtensionWorkshopStateSchema = z.object({
  version: z.literal(1),
  moduleId: z.string().min(3).max(100),
  /** 已经失败的修复次数（`buildExtension` 失败 +1；一次成功生成归零）。 */
  attempts: z.number().int().min(0),
  status: ExtensionWorkshopStatusSchema,
  installed: ExtensionWorkshopInstalledSchema.nullable(),
  lastError: z.string().max(2000).nullable(),
  updatedAt: z.string(),
}).strict();
export type ExtensionWorkshopState = z.infer<typeof ExtensionWorkshopStateSchema>;

/**
 * 静态校验里被拒的"危险方法"（blocked 或不可委托）。给 AI 回执里点名用。
 */
export interface ExtensionWorkshopForbiddenMethod {
  method: string;
  reason: string;
}

/** 静态校验结果（`diagnoseExtensionDraft` 的返回）。 */
export interface ExtensionWorkshopDiagnosis {
  ok: boolean;
  issues: string[];
  warnings: string[];
  forbidden: ExtensionWorkshopForbiddenMethod[];
}

/** `buildExtension` 走到的最后一步（失败时告诉 AI 该修哪里）。 */
export const WORKSHOP_STAGES = ["static", "write", "sandbox", "budget"] as const;
export type ExtensionWorkshopStage = (typeof WORKSHOP_STAGES)[number];

/**
 * 一次生成的完整回执。
 *
 * - `ok:true` ⇒ `draft` 非空，`stage:"sandbox"`（已过静态校验与真沙箱冒烟），
 *   **仍然需要用户确认**。回执里带 `manifest` 全文，交接给用户在设置页安装。
 * - `ok:false` ⇒ `issues` 是可以照抄给用户的错误；`stage` 说明卡在哪一步。
 */
export interface ExtensionWorkshopReport {
  ok: boolean;
  stage: ExtensionWorkshopStage;
  issues: string[];
  warnings: string[];
  /** 「要什么权限」的一行行说明（安装卡上的同一条事实）。 */
  permissions: string[];
  draft: {
    manifest: z.infer<typeof ModuleManifestSchema>;
    workspaceDir: string;
    entryFile: string;
    sandboxCapability: string;
  } | null;
}

/**
 * 【T20】给 AI 的**安装交接材料** —— 只描述下一步，不构成授权。
 *
 * ## ⚠️ 这个契约目前**没有任何实现**，且它描述的安装通道已不存在
 *
 * 两处都已过期，读它之前先看这里：
 *
 *  1. **`modules.install` 这个 RPC 已经删了。** ModuleHost 那一代整体移除后，
 *     `RpcMap` 里只剩 `modules.theiaInstalled` / `modules.theiaPreview` 两条，
 *     且**都在 `BLOCKED` 档** —— 安装 .vsix 要用户本人在设置页操作，`theiaPreview`
 *     还要一枚只能由用户发起的一次性 ticket。**Agent 够不到任何安装入口。**
 *  2. **工坊实现已删除。** `apps/desktop/src/main/modules/extensionWorkshop.ts`（887 行）
 *     已从工作区移除；`extension_build` / `extension_workshop_status` 从未注册。
 *
 * 保留契约本身是因为它记录了当时的设计意图；**别把它当成"现在能这么做"的说明**。
 * 要做扩展，走 `app_api_tutorial({query:"扩展"})` 里那条真实路径：准备好清单 →
 * `extension_validate` → 交给用户装。
 */
export interface ExtensionWorkshopInstallHandoff {
  /** @deprecated 这个 RPC 已不存在。真实入口是 `modules.theiaInstalled`（BLOCKED，仅用户可操作）。 */
  method: "modules.install";
  /** 原样交给 `app_api_call({method, input})` 的入参。 */
  input: Record<string, unknown>;
  requiresUserApproval: true;
  instructions: string[];
}
