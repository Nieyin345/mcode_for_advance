import { z } from "zod";
import { ModulePermissionSchema, ModulePermissionListSchema, type ModuleManifest, type ModulePermission } from "./modules.js";
import { MODULE_HIGH_RISK_PERMISSIONS } from "./appPermission.js";

export const ModuleGrantedPermissionsSchema = z.array(ModulePermissionSchema)
  .max(64).refine(items => new Set(items).size === items.length, "Duplicate granted permission");
export const ModulePermissionRecordSchema = z.object({
  granted: ModuleGrantedPermissionsSchema,
  grantedAt: z.string().datetime(),
  manifestVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
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
