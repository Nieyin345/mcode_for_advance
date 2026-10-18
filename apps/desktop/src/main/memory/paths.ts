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

/**
 * 目录级地址的可见性 —— `listMemoryFiles` 的 `onUnreadable` 也会报**目录**
 * (`rules`、`projects/A/rules`、`global/rules`,类目目录被链接替换或整目录读不动),
 * 而 {@link visibleMemory} 只认文件地址(两段式 `类目/文件.md`),拿它判目录会把
 * **整类记忆漏读**静默丢出披露 —— 与 MC-031 的原始缺陷同一类(注入少了条目而没人知道)。
 *
 * 判据与文件版**同出一份作用域语义**:
 * - 库根(`memory`)与 `projects`、`global` 是各项目共用的基础设施,名字里不含任何项目,
 *   对谁都可披露;
 * - `global/<类目>` 全局可见;`projects/<id>` 与 `projects/<id>/<类目>` 只对**本项目**可见
 *   (别的项目的存在与名字不得借诊断泄露,与 `review.ts` 的 MC-092 口径一致);
 * - 旧布局的类目目录不参与任何项目的注入,不披露(与 legacy 文件一致)。
 * 其余形状(坏项目 id、多余层级)一律 false。
 */
export function visibleMemoryDir(path: string, projectId: string): boolean {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 1) return parts[0] === "memory" || parts[0] === "projects" || parts[0] === "global";
  if (parts.length === 2) {
    if (parts[0] === "global") return (MEMORY_CATEGORIES as readonly string[]).includes(parts[1]!);
    return parts[0] === "projects" && MEMORY_PROJECT_ID.test(parts[1] ?? "") && parts[1] === projectId;
  }
  if (parts.length === 3) {
    return parts[0] === "projects" && MEMORY_PROJECT_ID.test(parts[1] ?? "") &&
      parts[1] === projectId && (MEMORY_CATEGORIES as readonly string[]).includes(parts[2]!);
  }
  return false;
}

/** 不可读项既可能是**文件**也可能是**目录**(见 {@link visibleMemoryDir});诊断披露按同一份
 *  作用域判据收口 —— 别处要判「这条诊断该不该让本项目看见」时用这个,不要只调文件版。 */
export function visibleMemoryDiagnostic(path: string, projectId: string): boolean {
  return memoryAddress(path) !== null ? visibleMemory(path, projectId) : visibleMemoryDir(path, projectId);
}
