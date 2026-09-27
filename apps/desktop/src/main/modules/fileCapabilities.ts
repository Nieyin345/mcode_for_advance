import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ResourceSchema, ResultSchema, type ModuleResource } from "@contracts/modules";
import type { JsonSchemaDocument, ModuleCapabilityMetadata } from "@contracts/moduleCapability";
import type { Capability, CapabilityContext } from "./ModuleHost.js";

// Discovery-only, bounded draft-07 subset; ResourceSchema/ResultSchema and
// resolveModuleResource remain the actual runtime validation and authorization.
const fileInputSchema: JsonSchemaDocument = {
  type: "object", additionalProperties: false,
  required: ["projectPath", "path"],
  properties: {
    projectPath: {type: "string", minLength: 1, maxLength: 4096},
    path: {type: "string", minLength: 1, maxLength: 4096},
  },
};
const inspectionOutputSchema: JsonSchemaDocument = {
  type: "object", additionalProperties: false,
  required: ["bytes", "sha256"],
  properties: {
    bytes: {type: "integer", minimum: 0, maximum: 32 * 1024 * 1024},
    sha256: {type: "string", pattern: "^[0-9a-f]{64}$"},
  },
};
const fileInfoOutputSchema: JsonSchemaDocument = {
  type: "object", additionalProperties: false,
  required: ["bytes", "modifiedAt"],
  properties: {
    bytes: {type: "integer", minimum: 0},
    modifiedAt: {type: "number"},
  },
};
const inspectionMetadata: ModuleCapabilityMetadata = {
  schemaVersion: 1, version: "1.0.0",
  title: {zh: "文件检查", en: "File inspection"},
  description: {
    zh: "读取已登记工作区内不超过 32 MiB 的普通文件，计算字节数和 SHA-256；任务最多运行 30 秒，支持取消。",
    en: "Hash a regular file inside a registered workspace (up to 32 MiB) and return its byte count and SHA-256. This task times out after 30 seconds and supports cancellation.",
  },
  permissions: ["resource.read"], inputSchema: fileInputSchema, outputSchema: inspectionOutputSchema,
  supportsCancellation: true,
  limits: {maxFileBytes: 32 * 1024 * 1024, taskTimeoutMs: 30_000},
};
const fileInfoMetadata: ModuleCapabilityMetadata = {
  schemaVersion: 1, version: "1.0.0",
  title: {zh: "文件信息", en: "File information"},
  description: {
    zh: "查询已登记工作区内普通文件的字节数和修改时间，不读取文件内容。",
    en: "Return a regular file's byte size and modification time (milliseconds since Unix epoch) within a registered workspace, without reading its contents.",
  },
  permissions: ["resource.read"], inputSchema: fileInputSchema, outputSchema: fileInfoOutputSchema,
  supportsCancellation: false,
};

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
    {id:"core.file.inspect",kind:"task",metadata:inspectionMetadata,input:ResourceSchema,output:ResultSchema,run:inspect},
    {id:"core.file.info",kind:"query",metadata:fileInfoMetadata,input:ResourceSchema,output:ResultSchema,run:async resource=>{
      const value=await stat(await resolveModuleResource(resource,knownRoot));return {bytes:value.size,modifiedAt:value.mtimeMs};
    }},
  ];
}
