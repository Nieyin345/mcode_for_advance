import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ResourceSchema, ResultSchema, type ModuleResource } from "@contracts/modules";
import type { Capability, CapabilityContext } from "./ModuleHost.js";

/** Resolve symlinks before authorizing the actual target, not only its spelling.
 * Known-root lookup is injected so tests use temporary directories, never user DB. */
export async function resolveModuleResource(resource: ModuleResource, knownRoot: (path:string)=>boolean): Promise<string> {
  if (!knownRoot(resource.projectPath)) throw Error("Unknown workspace");
  const root = await realpath(resource.projectPath);
  const file = await realpath(resolve(resource.path));
  const rel = relative(root,file);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".."+sep)) throw Error("Resource is outside workspace");
  if (!(await stat(file)).isFile()) throw Error("A regular file is required");
  return file;
}
export function fileCapabilities(knownRoot: (path:string)=>boolean): Capability<ModuleResource>[] {
  const inspect = async (resource:ModuleResource, context:CapabilityContext) => {
    const path=await resolveModuleResource(resource,knownRoot);
    const file=await open(path,"r");
    try {
      const initial=await file.stat();
      if (!initial.isFile() || initial.size > 32*1024*1024) throw Error("File inspection is limited to regular files up to 32 MiB");
      const hash=createHash("sha256"), buffer=Buffer.alloc(64*1024);
      let bytes=0;
      while(true) {
        if(context.signal.aborted)throw Error("Cancelled");
        const read=await file.read(buffer,0,buffer.length,null);
        if(!read.bytesRead)break;
        bytes+=read.bytesRead;
        if(bytes>32*1024*1024)throw Error("File grew beyond the 32 MiB limit");
        hash.update(buffer.subarray(0,read.bytesRead));
        context.progress(initial.size?Math.min(0.99,bytes/initial.size):0.99);
      }
      const final=await file.stat();
      const current=await stat(await resolveModuleResource(resource,knownRoot));
      if(final.size!==initial.size || final.mtimeMs!==initial.mtimeMs || current.ino!==initial.ino || current.dev!==initial.dev || current.mtimeMs!==initial.mtimeMs) throw Error("File changed during inspection; retry");
      return {bytes,sha256:hash.digest("hex")};
    } finally {await file.close();}
  };
  return [
    {id:"core.file.inspect",kind:"task",input:ResourceSchema,output:ResultSchema,run:inspect},
    {id:"core.file.info",kind:"query",input:ResourceSchema,output:ResultSchema,run:async resource=>{
      const value=await stat(await resolveModuleResource(resource,knownRoot));return {bytes:value.size,modifiedAt:value.mtimeMs};
    }},
  ];
}
