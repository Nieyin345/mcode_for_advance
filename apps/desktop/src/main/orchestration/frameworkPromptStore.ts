/**
 * T64 — persisted per-section framework wording.
 * <dataRoot>/context/framework/<id>.md, alongside instructions.md.
 * Read each RUN once (not each node) to guarantee in-flight snapshot isolation.
 * Only a fixed allowlist of editable sections can ever be written.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "@main/lib/appContext.js";
import {
  FRAMEWORK_SECTIONS,
  type EditableFrameworkSectionId,
  type FrameworkOverrides,
} from "./frameworkSections.js";

export function frameworkFile(root: string, id: EditableFrameworkSectionId): string {
  return join(root, "context", "framework", `${id}.md`);
}

function readOverride(root: string, id: EditableFrameworkSectionId): string | undefined {
  let content: string;
  try {
    content = readFileSync(frameworkFile(root, id), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error; // corruption/permissions are errors, not an implicit default
  }
  return content.trim().length > 0 ? content : undefined;
}

export function readFrameworkOverrides(root: string): FrameworkOverrides {
  const values: FrameworkOverrides = {};
  for (const section of FRAMEWORK_SECTIONS) {
    if (!section.editable) continue;
    const content = readOverride(root, section.id);
    if (content !== undefined) values[section.id] = content;
  }
  return values;
}

export function listFrameworkSections(root: string) {
  const overrides = readFrameworkOverrides(root);
  return FRAMEWORK_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    description: section.description,
    editable: section.editable,
    defaultContent: section.default,
    content: section.editable ? (overrides[section.id] ?? section.default) : section.default,
    customized: section.editable ? overrides[section.id] !== undefined : false,
  }));
}

export function saveFrameworkSection(
  root: string,
  id: EditableFrameworkSectionId,
  content: string,
): void {
  // Defense in depth: IPC validation is not the only path to this function.
  if (!FRAMEWORK_SECTIONS.some((section) => section.id === id && section.editable)) {
    throw new Error("系统注入的框架段落不可修改");
  }
  if (content.length > 200_000) throw new Error("框架提示词超过长度限制");
  // Empty content is semantically the default; delete rather than storing a
  // misleading override. Reads also handle hand-edited whitespace-only files.
  if (!content.trim()) {
    resetFrameworkSection(root, id);
    return;
  }
  atomicWrite(frameworkFile(root, id), content);
}

export function resetFrameworkSection(root: string, id: EditableFrameworkSectionId): void {
  if (!FRAMEWORK_SECTIONS.some((section) => section.id === id && section.editable)) {
    throw new Error("系统注入的框架段落不可修改");
  }
  rmSync(frameworkFile(root, id), { force: true });
}
