import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataRoot } from "@main/lib/dataRoot.js";
import { isKnownWorkspaceRoot } from "@main/lib/pathGuard.js";
import { EXAMPLE_MODULE, ModuleManifestSchema, type ModuleManifest } from "@contracts/modules";
import { ModuleHost } from "./ModuleHost.js";
import { fileCapabilities, resolveModuleResource } from "./fileCapabilities.js";

let hostPromise: Promise<ModuleHost> | null = null;
/** Lazy: importing IPC must not touch the user's data root during smoke tests. */
export function getModuleHost(): Promise<ModuleHost> {
  if (!hostPromise) hostPromise=createHost().catch(error=>{hostPromise=null;throw error;});
  return hostPromise;
}
async function createHost(): Promise<ModuleHost> {
  const dir=join(dataRoot(),"ui-modules"),path=join(dir,"manifests.json");
  const host=new ModuleHost({
    authorize:async resource=>{await resolveModuleResource(resource,isKnownWorkspaceRoot);},
    persist:async manifests=>{
      const body=JSON.stringify(manifests,null,2);
      if(Buffer.byteLength(body)>512*1024)throw Error("Module store exceeds 512 KiB");
      await mkdir(dir,{recursive:true});
      const temp=join(dir,"manifests-"+randomUUID()+".tmp");
      try {
        const file=await open(temp,"wx");
        try {await file.writeFile(body,"utf8");await file.sync();}finally{await file.close();}
        await rename(temp,path);
      } finally {await unlink(temp).catch(()=>{});}
    },
  });
  for(const capability of fileCapabilities(isKnownWorkspaceRoot))host.register(capability);
  host.addBuiltin({
    ...EXAMPLE_MODULE, id:"core.file-report",
    title:{zh:"内置文件检查",en:"Built-in file inspection"},
    contributions:[
      {...EXAMPLE_MODULE.contributions[0],title:{zh:"检查文件（大小 / SHA-256）",en:"Inspect file (size / SHA-256)"}},
      {
        id:"info",slot:"files.context",capability:"core.file.info",
        title:{zh:"查看文件信息",en:"View file information"},
        view:{
          title:{zh:"文件信息",en:"File information"},
          fields:[
            {key:"bytes",title:{zh:"字节数",en:"Bytes"}},
            {key:"modifiedAt",title:{zh:"修改时间",en:"Modified at"}},
          ],
        },
      },
    ],
  });
  let saved:ModuleManifest[]=[];
  try {
    if((await stat(path)).size>512*1024)throw Error("Module store exceeds 512 KiB");
    saved=z.array(ModuleManifestSchema).max(31).parse(JSON.parse(await readFile(path,"utf8")));
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  for(const manifest of saved)host.restore(manifest);
  return host;
}
