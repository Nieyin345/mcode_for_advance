/** F028: translate a live Theia extension's registered commands into Mcode's *existing*
 * command-palette interface. This is not a parallel command registry or new UI.
 * This module is pure and cheap: no polling, disk I/O, subprocess, or startup side effects.
 */
import type { TheiaInstalledEntry, TheiaInstalledInput, TheiaInstalledResult } from "@contracts/ipc/modules.js";
import type { CommandDef } from "./commands.js";

export type NativeTheiaInvoke = (input: TheiaInstalledInput) => Promise<TheiaInstalledResult>;
export type NativeTheiaNotify = (message: {kind:"info"|"error";title:string;body?:string}) => void;

/** All dispatches go through the existing authenticated desktop IPC.
 * The palette receives only running-session commands belonging to its own sender.
 */
export function collectTheiaPaletteCommands(
  entries: readonly TheiaInstalledEntry[],
  invoke: NativeTheiaInvoke,
  notify: NativeTheiaNotify,
): CommandDef[] {
  const out: CommandDef[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    if (!item.enabled || item.corrupted || !item.running || !item.activeSession) continue;
    const {sessionId, commands} = item.activeSession;
    if (!sessionId || !Array.isArray(commands)) continue;
    for (const commandId of commands) {
      if (typeof commandId !== "string" || !commandId || commandId.length > 256) continue;
      const id = "theia:" + item.id + ":" + commandId;
      if (seen.has(id)) continue;
      seen.add(id);
      const title = commandId + " · " + item.extensionId;
      out.push({
        id, label:title, group:"view",
        keywords:[commandId,item.extensionId,"VS Code","Theia","扩展"],
        perform:async()=>{
          try {
            const response = await invoke({op:"execute",sessionId,commandId});
            if (response.kind !== "executed") throw Error("Theia 扩展命令未完成");
            notify({kind:"info",title,body:response.result});
          } catch (error) {
            notify({kind:"error",title,body:error instanceof Error?error.message:String(error)});
          }
        },
      });
    }
  }
  return out;
}
