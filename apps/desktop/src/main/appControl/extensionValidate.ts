/**
 * T51: pre-install extension diagnosis. Validation never writes a manifest, grants
 * permission, or invokes an extension capability. Program evaluation is delegated to
 * the SAME isolated verifier used by ModuleHost.install, not an in-process eval.
 */
import { Script } from "node:vm";
import {
  ModuleManifestSchema, extensionCapabilityShortName,
  type ModuleManifest,
} from "@contracts/modules";
import { MODULE_PERMISSION_NAMES, APP_METHOD_PERMISSIONS } from "@contracts/appPermission";

export interface ExtensionValidation {
  installable: boolean;
  issues: string[];
  warnings: string[];
}
type Verifier = (source: string, capabilities: readonly string[], timeoutMs: number | undefined) =>
  Promise<{ ok: true } | { ok: false; reason: string }>;

/** No filesystem mutation. The verifier evaluates only the FACTORY in a permissioned child. */
export async function validateExtension(
  raw: unknown,
  sourceOverride?: string,
  verify: Verifier = async (source, caps, timeout) => {
    const { verifyPermissionedProgram } = await import("@main/modules/permissionedProcessRunner.js");
    return verifyPermissionedProgram(source, caps, timeout ?? 10_000);
  },
): Promise<ExtensionValidation> {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const perms = (raw as { permissions?: unknown }).permissions;
    if (Array.isArray(perms)) {
      for (const value of perms) {
        if (typeof value !== "string" || !(MODULE_PERMISSION_NAMES as readonly string[]).includes(value)) {
          issues.push(`权限 ${String(value)} 不存在`);
        }
      }
    }
  }
  const override = sourceOverride === undefined ? raw : (
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...raw, program: { ...((raw as {program?: object}).program ?? {}), source: sourceOverride } }
      : raw
  );
  const parsed = ModuleManifestSchema.safeParse(override);
  if (!parsed.success) {
    for (const error of parsed.error.issues) {
      const message = `${error.path.join(".") || "manifest"}: ${error.message}`;
      if (!issues.includes(message)) issues.push(message);
    }
    return { installable: false, issues, warnings };
  }
  const manifest: ModuleManifest = parsed.data;
  if (!manifest.id.startsWith("user.")) issues.push("扩展 id 必须以 user. 开头");
  if (!manifest.permissions.includes("resource.read") && !manifest.permissions.includes("files.read")) {
    issues.push("权限 resource.read 或 files.read 必须声明");
  }
  // Static hint only: computed method names and aliases cannot be proven by
  // regex. The T49 host RPC bridge checks permissions on every call.
  if (manifest.program) {
    for (const match of manifest.program.source.matchAll(/(?:mcode\.api\.call|app_api_call)\s*\(\s*["']([^"']+)["']/g)) {
      const method = match[1]!;
      const required = APP_METHOD_PERMISSIONS[method];
      if (required === undefined) {
        warnings.push(`API ${method} 不在权限映射中，请使用 app_api_list 核实`);
      } else if (required === null) {
        issues.push(`API ${method} 不可委托给扩展`);
      } else {
        for (const permission of required) {
          if (!manifest.permissions.includes(permission)) {
            warnings.push(`API ${method} 需要未声明权限 ${permission}`);
          }
        }
      }
    }
    try {
      // Compile only: no user code ever runs in this host process.
      new Script("(" + manifest.program.source + ")", { filename: "extension-program.js" });
    } catch (error) {
      issues.push("求值失败：" + (error instanceof Error ? error.message : String(error)));
    }
    if (issues.length === 0) {
      const caps = [...new Set(manifest.contributions
        .map(c => extensionCapabilityShortName(c.capability))
        .filter((cap): cap is string => cap !== undefined))];
      const verdict = await verify(manifest.program.source, caps, manifest.program.timeoutMs);
      if (!verdict.ok) issues.push("求值失败：" + verdict.reason);
    }
  }
  return { installable: issues.length === 0, issues, warnings };
}
