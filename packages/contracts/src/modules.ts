import { z } from "zod";
import type { ModuleCapabilityDescriptor, ModuleWorkflowTarget } from "./moduleCapability.js";

/** v1 is a declarative, read-only extension surface, NOT a JavaScript sandbox.
 * Both bundled and imported manifests use this contract and the same host. */
const Id = z.string().min(3).max(100).regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/);
const LocalId = z.string().min(1).max(60).regex(/^[a-z][a-z0-9-]*$/);
export const LocalizedTextSchema = z.object({ zh: z.string().min(1).max(120), en: z.string().min(1).max(120) }).strict();
export const ResourceSchema = z.object({ projectPath: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }).strict();
export type ModuleResource = z.infer<typeof ResourceSchema>;
export const ResultSchema = z.record(z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= 32, "Too many result fields");
export type ModuleResult = z.infer<typeof ResultSchema>;
export const ModuleManifestSchema = z.object({
  apiVersion: z.literal(1),
  id: Id,
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
  title: LocalizedTextSchema,
  permissions: z.array(z.literal("resource.read")).max(1),
  contributions: z.array(z.object({
    id: LocalId,
    slot: z.literal("files.context"),
    title: LocalizedTextSchema,
    extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/).max(20)).max(20).optional(),
    capability: Id,
    view: z.object({
      title: LocalizedTextSchema,
      fields: z.array(z.object({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(60), title: LocalizedTextSchema }).strict()).min(1).max(20),
    }).strict(),
  }).strict()).min(1).max(12),
}).strict().refine(v => new Set(v.contributions.map(c => c.id)).size === v.contributions.length, "Duplicate contribution ID");
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;
export type ModuleContribution = ModuleManifest["contributions"][number];
export const ModuleInvokeSchema = z.object({ moduleId: Id, contributionId: LocalId, resource: ResourceSchema, requestId: z.string().min(1).max(100) }).strict();
export type ModuleInvoke = z.infer<typeof ModuleInvokeSchema>;
export const ModuleTaskRefSchema = z.object({ moduleId: Id, taskId: z.string().min(1).max(100) }).strict();
export type ModuleTaskRef = z.infer<typeof ModuleTaskRefSchema>;
export const ModuleWorkspaceSchema = z.object({ projectPath: z.string().min(1).max(4096) }).strict();
export const ModuleRemoveSchema = z.object({ moduleId: Id }).strict();
export interface ModuleTask {
  id: string;
  moduleId: string;
  contributionId: string;
  resource: ModuleResource;
  view: ModuleContribution["view"];
  status: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  createdAt: number;
  updatedAt: number;
  result?: ModuleResult;
  error?: string;
}
export type ModuleReply = { type: "result"; value: ModuleResult; view: ModuleContribution["view"] } | { type: "task"; task: ModuleTask };
export interface ModuleCatalog {
  modules: ModuleManifest[];
  capabilities: ModuleCapabilityDescriptor[];
  /** Host-derived read-only builtin targets. Missing means unavailable, not all modules. */
  workflowTargets?: ModuleWorkflowTarget[];
}

/** This example is used by the import editor, docs and tests; no executable code. */
export const EXAMPLE_MODULE: ModuleManifest = {
  apiVersion: 1, id: "user.file-report", version: "1.0.0",
  title: { zh: "我的文件报告", en: "My file report" }, permissions: ["resource.read"],
  contributions: [{ id: "inspect", slot: "files.context", title: { zh: "生成我的文件报告", en: "Create my file report" }, capability: "core.file.inspect",
    view: { title: { zh: "文件报告", en: "File report" }, fields: [
      { key: "bytes", title: { zh: "字节数", en: "Bytes" } },
      { key: "sha256", title: { zh: "SHA-256", en: "SHA-256" } },
    ] } }],
};
