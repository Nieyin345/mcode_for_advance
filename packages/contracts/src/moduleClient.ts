import type { ModuleInvoke, ModuleReply, ModuleResource, ModuleTask, ModuleTaskRef } from "./modules.js";

/** Transport-neutral client: desktop uses preload, trusted host integrations may
 * inject a local adapter. Binding an ID is convenience, NOT authentication.
 * v1 external manifests contain no executable JS; future untrusted transports
 * must derive principal/permissions from the host connection, never this ID. */
export interface ModuleTransport {
  invoke(input: ModuleInvoke): Promise<ModuleReply>;
  task(input: ModuleTaskRef): Promise<ModuleTask>;
  cancel(input: ModuleTaskRef): Promise<ModuleTask>;
}
export function createModuleClient(transport: ModuleTransport, moduleId: string) {
  return {
    invoke: (contributionId:string,resource:ModuleResource,requestId:string) => transport.invoke({moduleId,contributionId,resource,requestId}),
    task: (taskId:string) => transport.task({moduleId,taskId}),
    cancel: (taskId:string) => transport.cancel({moduleId,taskId}),
  };
}
