import { z } from "zod";
import { ModulePermissionSchema, ModulePermissionListSchema, type ModuleManifest, type ModulePermission } from "./modules.js";
import { MODULE_HIGH_RISK_PERMISSIONS } from "./appPermission.js";

export const ModuleGrantedPermissionsSchema = z.array(ModulePermissionSchema)
  .max(64).refine(items => new Set(items).size === items.length, "Duplicate granted permission");

/** 【T18】一次安装授权的**时效**。
 *
 *  - `persistent`（始终允许）—— 跨重启有效；仍绑定模块版本 + 执行指纹，
 *    清单/权限集/程序/贡献任一变化都会让旧决策失效并强制重新询问。
 *  - `session`（允许一次）—— 只对**这一次安装与这一次运行**有效。记录里带
 *    `bootId`（本次进程启动的随机身份）；下次启动读到的是别的 bootId，
 *    `ModuleHost.effectiveGrants` 判定其失效 → 重新询问。
 *
 *  旧存档没有这个字段 = `persistent`（向后兼容：那时只有持久授予）。 */
export const MODULE_PERMISSION_DURATIONS = ["persistent", "session"] as const;
export const ModulePermissionDurationSchema = z.enum(MODULE_PERMISSION_DURATIONS);
export type ModulePermissionDuration = z.infer<typeof ModulePermissionDurationSchema>;

export const ModulePermissionRecordSchema = z.object({
  granted: ModuleGrantedPermissionsSchema,
  grantedAt: z.string().datetime(),
  manifestVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** 缺省 = `persistent`（旧存档）。 */
  duration: ModulePermissionDurationSchema.optional(),
  /** `duration === "session"` 时的进程启动身份；其他情况不写。 */
  bootId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/).optional(),
}).strict();
export const ModulePermissionArchiveSchema = z.object({
  version: z.literal(1),
  modules: z.record(ModulePermissionRecordSchema),
}).strict();
export type ModulePermissionArchive = z.infer<typeof ModulePermissionArchiveSchema>;
export type ModulePermissionRecord = z.infer<typeof ModulePermissionRecordSchema>;
export const EMPTY_MODULE_PERMISSION_ARCHIVE: ModulePermissionArchive = {version:1,modules:{}};
export const ModulePermissionUpdateSchema = z.object({
  moduleId: z.string().min(3).max(100),
  grantedPermissions: ModuleGrantedPermissionsSchema,
}).strict();
export type ModulePermissionUpdateInput = z.infer<typeof ModulePermissionUpdateSchema>;
/** Installation defaults: explicit consent is always needed, high risk is never pre-checked. */
export function defaultModuleGrants(manifest: ModuleManifest): ModulePermission[] {
  return manifest.permissions.filter(permission => !MODULE_HIGH_RISK_PERMISSIONS.has(permission));
}
export function assertModuleGrants(manifest: ModuleManifest, granted: readonly ModulePermission[]): void {
  ModulePermissionListSchema.parse(manifest.permissions);
  ModuleGrantedPermissionsSchema.parse(granted);
  for (const permission of granted) {
    if (!manifest.permissions.includes(permission)) throw Error(`扩展未声明 ${permission} 权限，不得授予`);
  }
}
