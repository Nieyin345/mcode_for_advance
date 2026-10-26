import type {IpcMain} from "electron";
import {createDbGuardedIpc} from "../../src/main/ipc/dbGuardedIpc.js";
import {registerTheiaInstalledHandlers} from "../../src/main/ipc/theiaInstalled.js";

/** Loaded as a separate ESM runtime so production import.meta.url semantics remain intact. */
export function registerF040TheiaHandlers(ipcMain:IpcMain,dataDir:string,theiaRoot:string):void{
  registerTheiaInstalledHandlers(createDbGuardedIpc(ipcMain),{dataRoot:()=>dataDir,theiaRoot});
}
