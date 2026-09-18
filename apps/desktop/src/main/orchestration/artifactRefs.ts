import * as path from "node:path";
import type { NodeArtifact } from "@contracts/nodeType";

/** Normalize executor-reported artifact references into stable local paths/URIs. */
export function normalizeNodeArtifacts(raw: unknown, cwd: string): NodeArtifact[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): NodeArtifact[] => {
    if (typeof item !== "object" || item === null) return [];
    const value = item as Record<string, unknown>;
    if (value.kind !== "file" && value.kind !== "directory" && value.kind !== "data") return [];
    if (typeof value.uri !== "string" || value.uri.trim().length === 0) return [];
    const uri = value.uri.trim();
    const normalizedUri = /^[a-z][a-z\d+.-]*:/i.test(uri)
      ? uri
      : path.resolve(cwd || process.cwd(), uri);
    return [{
      kind: value.kind,
      uri: normalizedUri,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
      ...(typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes) ? { sizeBytes: value.sizeBytes } : {}),
    }];
  });
}
