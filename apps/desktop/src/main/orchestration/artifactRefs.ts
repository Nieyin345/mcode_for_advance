import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
    // Tool-produced paths are displayed and may be passed to the native
    // open-path action. NUL, embedded newlines, and other control characters
    // are never meaningful artifact locations; reject rather than misreport.
    if (/[\x00-\x1f\x7f]/.test(uri)) return [];
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(uri)?.[1]?.toLowerCase();
    const isDrivePath = /^[a-z]:[\\/]/i.test(uri);
    let normalizedUri: string;
    if (scheme === "file" && value.kind !== "data") {
      // WorkflowStepCard's Open button only accepts native absolute paths,
      // not file:///C:/... URLs or %-encoded names. Use Node's platform
      // decoder so spaces, # and ? remain filename bytes, not URL delimiters.
      // A remote file://host is a network share, not an authorized local
      // artifact; do not turn an untrusted node result into an SMB request.
      try {
        const url = new URL(uri);
        if (url.hostname !== "" && url.hostname !== "localhost") return [];
        normalizedUri = fileURLToPath(url);
      } catch {
        return [];
      }
    } else if (!isDrivePath && scheme && value.kind !== "data" &&
        ["javascript", "vbscript", "data"].includes(scheme)) {
      return [];
    } else {
      normalizedUri = scheme && !isDrivePath ? uri : path.resolve(cwd || process.cwd(), uri);
    }
    return [{
      kind: value.kind,
      uri: normalizedUri,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
      ...(typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0
        ? { sizeBytes: value.sizeBytes } : {}),
    }];
  });
}
