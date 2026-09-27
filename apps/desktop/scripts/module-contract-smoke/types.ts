import type { z } from "zod";
import type { ModuleCatalog } from "@contracts/modules";
import type { NodeRunInput } from "@contracts/runtime";
import type { NodeRunner } from "@contracts/nodeType";
import type { ModuleWorkflowCall, ModuleWorkflowExecutionInput, ModuleCatalogSchema } from "@contracts/moduleCapability";
const params: ModuleWorkflowCall = { moduleId: "core.file-report", contributionId: "inspect", path: "readme.md" };
const execution: ModuleWorkflowExecutionInput = { ...params, requestId: "wf:host-generated-attempt" };
const base: NodeRunInput = { prompt: "", data: { userInput: "", upstreamText: "", upstreamOutputs: {}, upstreamArtifacts: [] }, skills: [], mcpServerNames: [], pluginNames: [], returnMode: "result" };
const withCall: NodeRunInput = { ...base, moduleCall: execution };
const runner: NodeRunner = { kind: "module-capability" };
const legacy: ModuleCatalog = { modules: [], capabilities: [{ id: "core.file.inspect", kind: "task" }] };
const parsedShape: z.infer<typeof ModuleCatalogSchema> = legacy;
const publicShape: ModuleCatalog = parsedShape;
// @ts-expect-error A host dispatch cannot omit its request identity.
const missingIdentity: ModuleWorkflowExecutionInput = params;
// @ts-expect-error The editor's three-field params cannot carry host request identity.
const editorIdentity: ModuleWorkflowCall = { ...params, requestId: "forged" };
// @ts-expect-error Workspace comes from trusted ExecutionContext.cwd.
const workspace: ModuleWorkflowCall = { ...params, projectPath: "C:/other" };
// @ts-expect-error Closed runner shape has no arbitrary executable entry.
const scriptRunner: NodeRunner = { kind: "module-capability", entry: "script.js" };
// @ts-expect-error runtime input carries the strict host execution shape.
const invalidRun: NodeRunInput = { ...base, moduleCall: params };
void [withCall, runner, publicShape, missingIdentity, editorIdentity, workspace, scriptRunner, invalidRun];
