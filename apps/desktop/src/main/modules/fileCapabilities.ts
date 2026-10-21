import { createHash } from "node:crypto";
import { z } from "zod";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ResourceSchema, ResultSchema, type ModuleResource } from "@contracts/modules";
import type { JsonSchemaDocument, ModuleCapabilityMetadata } from "@contracts/moduleCapability";
import type { Capability, CapabilityContext } from "./ModuleHost.js";
import { BUILTIN_CAPABILITY_CATALOGUE } from "./builtinCapabilityCatalogue.js";

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
const appCallMetadata: ModuleCapabilityMetadata = {
  schemaVersion:1, version:"1.0.0",
  title:{zh:"扩展调用主进程 API",en:"Extension application API bridge"},
  description:{zh:"宿主绑定身份并验证安装授权的 RPC 代理；仅供隔离扩展内部调用，不作为外部菜单动作。",en:"Host-owned, grant-checked RPC bridge for isolated extensions only."},
  permissions:["resource.read","resource.write"],
  inputSchema:{type:"object",required:["method"],properties:{method:{type:"string"}},additionalProperties:true},
  outputSchema:{type:"object",additionalProperties:{type:["string","number","boolean","null"]}},
  supportsCancellation:false,
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
  const detail = await stat(file);
  if (!detail.isFile() || detail.nlink !== 1) throw Error("需要一个普通文件（拒绝跨工作区硬链接）");
  return file;
}
/** Open the exact inode that was authorized, not a different file swapped in
 * after realpath/stat. A single hardlink to an outside path must also be denied:
 * a correct-looking lexical path does not make its inode workspace-owned.
 * This is bounded Node-level mitigation; an OS openat2-style directory anchor
 * is still needed against malicious concurrent ancestor renames.
 */
async function openAuthorizedFile(
  resource: ModuleResource,
  knownRoot: (path: string) => boolean,
) {
  const authorized = await resolveModuleResource(resource, knownRoot);
  const fd = await open(authorized, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw Error("拒绝非普通文件或硬链接");
    // Catch symlink / hardlink replacement after the initial authorization, and
    // never use a pathname stat as the content actually read from this descriptor.
    const checked = await resolveModuleResource(resource, knownRoot);
    const current = await stat(checked);
    if (checked !== authorized || !current.isFile() || current.nlink !== 1 ||
        current.dev !== opened.dev || current.ino !== opened.ino) {
      throw Error("文件在授权与打开期间已变化，拒绝读取");
    }
    return fd;
  } catch (error) {
    await fd.close();
    throw error;
  }
}
export function fileCapabilities(knownRoot: (path:string)=>boolean): Capability<any>[] {
  const inspect = async (resource:ModuleResource, context:CapabilityContext) => {
    const file=await openAuthorizedFile(resource,knownRoot);
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
      if(bytes!==initial.size || final.size!==initial.size || final.mtimeMs!==initial.mtimeMs || final.ctimeMs!==initial.ctimeMs || current.ino!==initial.ino || current.dev!==initial.dev || current.mtimeMs!==initial.mtimeMs || current.ctimeMs!==initial.ctimeMs) throw Error("文件在检查期间发生变化,请重试");
      return {bytes,sha256:hash.digest("hex")};
    } finally {await file.close();}
  };
  // 【MC-035】id/kind **不在这里手写**:从 `builtinCapabilityCatalogue` 取,两条实现按
  // id 挂上去。catalogue 里加了而这里没实现 → 下面那个 `throw` 会**立刻**在注册期炸,
  // 而不是让能力目录与真实注册各说各话。
  const implementations: Record<string, Capability<any>> = {
    "core.app.call": {id:"core.app.call",kind:"action",metadata:appCallMetadata,input:z.object({method:z.string().min(1),input:z.unknown().optional()}).strict(),output:ResultSchema,run:async()=>{throw Error("core.app.call only accepts host-bound calls from a running extension");}},
    "core.file.inspect": {id:"core.file.inspect",kind:"task",metadata:inspectionMetadata,input:ResourceSchema,output:ResultSchema,run:inspect},
    "core.file.info": {id:"core.file.info",kind:"query",metadata:fileInfoMetadata,input:ResourceSchema,output:ResultSchema,run:async resource=>{
      const file=await openAuthorizedFile(resource,knownRoot);
      try {
        const value=await file.stat();
        return {bytes:value.size,modifiedAt:value.mtimeMs};
      } finally {
        await file.close();
      }
    }},
  };
  return BUILTIN_CAPABILITY_CATALOGUE.map((entry) => {
    const implementation = implementations[entry.id];
    if (!implementation) throw Error(`内置能力 ${entry.id} 在目录里但没有实现`);
    if (implementation.kind !== entry.kind) throw Error(`内置能力 ${entry.id} 的种类与目录不一致(目录 ${entry.kind},实现 ${implementation.kind})`);
    return implementation;
  });
}
