import { z } from "zod";
import { ModuleManifestSchema } from "../modules.js";
export { ModuleInvokeSchema, ModuleRemoveSchema, ModuleTaskRefSchema, ModuleWorkspaceSchema } from "../modules.js";
export const ModuleInstallSchema = z.object({manifest:ModuleManifestSchema,confirmReadAccess:z.literal(true)}).strict();
export type ModuleInstallInput = z.infer<typeof ModuleInstallSchema>;
