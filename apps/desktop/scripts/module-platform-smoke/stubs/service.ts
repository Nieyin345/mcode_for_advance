import type { ModuleHost } from "../../../src/main/modules/ModuleHost.js";
let host:ModuleHost;
export function setTestHost(value:ModuleHost):void {host=value;}
export async function getModuleHost():Promise<ModuleHost> {if(!host)throw Error("test host missing");return host;}
