import { MEMORY_CATEGORIES, MEMORY_PROJECT_ID_RE } from "@contracts/memory";
export interface MemoryAddress { scope: "legacy" | "global" | "project"; projectId?: string; category: string; file: string; }
/** 项目 id 的合法形状 —— 与契约共用一份(见 `@contracts/memory` 的 `MEMORY_PROJECT_ID_RE`)。 */
export const MEMORY_PROJECT_ID = MEMORY_PROJECT_ID_RE;
/** 记忆**文件名**上限(frontmatter 只有两行,名字超长只可能是构造出来的)。
 *  **唯一一处** —— `memoryServer` 生成候选名时截到更短(80)以给 `.md` 和去重后缀留余量,
 *  但拒绝线在这里。从前 `memory/store.ts` 里还有一个同值的 `MAX_FILE_NAME` 常量,
 *  全仓零引用而真正生效的是这里的字面量 —— 那种"常量看着能调、其实调了没用"最难查。 */
export const MAX_MEMORY_FILE_NAME = 120;
export function memoryAddress(path: string): MemoryAddress | null {
  const parts = path.split("/");
  let scope: MemoryAddress["scope"] = "legacy", projectId: string | undefined;
  if (parts.length === 3 && parts[0] === "global") { scope = "global"; parts.shift(); }
  else if (parts.length === 4 && parts[0] === "projects" && MEMORY_PROJECT_ID.test(parts[1] ?? "")) {
    scope = "project"; parts.shift(); projectId = parts.shift();
  }
  if (parts.length !== 2) return null;
  const [category, file] = parts;
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category!) || !file || file.length > MAX_MEMORY_FILE_NAME ||
      !file.endsWith(".md") || file.startsWith(".") || /[\\\u0000<>:"|?*]/.test(file) || file === ".md") return null;
  return { scope, ...(projectId ? { projectId } : {}), category: category!, file };
}
export function visibleMemory(path: string, projectId: string): boolean {
  const address = memoryAddress(path);
  return !!address && (address.scope === "global" || address.scope === "project" && address.projectId === projectId);
}
