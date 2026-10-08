import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const within = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return !(isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep));
};
// A child name that no registered project/worktree uses. If an ancestor admits
// it too, that ancestor trusts its whole subtree (the documents roots).
const SUBTREE_PROBE = ".mcode-module-subtree-probe";

/** Resolve symlinks before authorizing the actual target, not only its spelling.
 * Known-root lookup is injected so tests use temporary directories, never user DB.
 * A workspace admitted only because it lies below a subtree-trusted directory
 * must canonically stay below that directory; a link inside it cannot promote
 * an outside directory (for example the app data root) to a workspace. */
export async function resolveModuleResource(resource: ModuleResource, knownRoot: (path:string)=>boolean): Promise<string> {
  if (!knownRoot(resource.projectPath)) throw Error("未知工作区");
  const lexicalRoot = resolve(resource.projectPath);
  const root = await realpath(lexicalRoot);
  for (let child = lexicalRoot, parent = dirname(lexicalRoot); parent !== child; child = parent, parent = dirname(parent)) {
    if (!knownRoot(parent) || !knownRoot(join(parent, SUBTREE_PROBE))) continue;
    if (!within(await realpath(parent), root)) throw Error("工作区在其受信根之外");
  }
  const file = await realpath(resolve(resource.path));
  if (!within(root, file)) throw Error("资源在工作区之外");
  if (!(await stat(file)).isFile()) throw Error("需要一个普通文件");
  return file;
}
export function fileCapabilities(knownRoot: (path:string)=>boolean): Capability<ModuleResource>[] {
  const inspect = async (resource:ModuleResource, context:CapabilityContext) => {
    const path=await resolveModuleResource(resource,knownRoot);
    const file=await open(path,"r");
    try {
      const initial=await file.stat();
      if (!initial.isFile() || initial.size > 32*1024*1024) throw Error("文件检查仅限不超过 32 MiB 的普通文件");
      const hash=createHash("sha256"), buffer=Buffer.alloc(64*1024);
      let bytes=0;
      while(true) {
        if(context.signal.aborted)throw Error("已取消");
        const read=await file.read(buffer,0,buffer.length,null);
        if(!read.bytesRead)break;
        bytes+=read.bytesRead;
        if(bytes>32*1024*1024)throw Error("文件在读取期间增大,超过 32 MiB 上限");
        hash.update(buffer.subarray(0,read.bytesRead));
        context.progress(initial.size?Math.min(0.99,bytes/initial.size):0.99);
      }
      const final=await file.stat();
      const current=await stat(await resolveModuleResource(resource,knownRoot));
      if(final.size!==initial.size || final.mtimeMs!==initial.mtimeMs || current.ino!==initial.ino || current.dev!==initial.dev || current.mtimeMs!==initial.mtimeMs) throw Error("文件在检查期间发生变化,请重试");
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
