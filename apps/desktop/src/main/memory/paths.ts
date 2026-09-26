import { MEMORY_CATEGORIES } from "@contracts/memory";
export interface MemoryAddress { scope: "legacy" | "global" | "project"; projectId?: string; category: string; file: string; }
export const MEMORY_PROJECT_ID = /^[A-Za-z0-9_-]{1,120}$/;
export function memoryAddress(path: string): MemoryAddress | null {
  const parts = path.split("/");
  let scope: MemoryAddress["scope"] = "legacy", projectId: string | undefined;
  if (parts.length === 3 && parts[0] === "global") { scope = "global"; parts.shift(); }
  else if (parts.length === 4 && parts[0] === "projects" && MEMORY_PROJECT_ID.test(parts[1] ?? "")) {
    scope = "project"; parts.shift(); projectId = parts.shift();
  }
  if (parts.length !== 2) return null;
  const [category, file] = parts;
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category!) || !file || file.length > 120 ||
      !file.endsWith(".md") || file.startsWith(".") || /[\\\u0000<>:"|?*]/.test(file) || file === ".md") return null;
  return { scope, ...(projectId ? { projectId } : {}), category: category!, file };
}
export function visibleMemory(path: string, projectId: string): boolean {
  const address = memoryAddress(path);
  return !!address && (address.scope === "global" || address.scope === "project" && address.projectId === projectId);
}
