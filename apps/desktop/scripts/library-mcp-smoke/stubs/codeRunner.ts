import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Offline success double for the external MinerU code-node invocation. */
export async function runCodeNode(args: {
  code: string;
  language: string;
  input?: unknown;
  timeoutMs: number;
  cwd?: string;
  signal: AbortSignal;
  onProgress?: (progress: { percent?: number; message?: string }) => void;
}): Promise<any> {
  const input = args.input as { itemId?: string } | undefined;
  const itemId = input?.itemId;
  if (!itemId || !args.cwd) return { status: "failed", summary: "missing fixture input", error: "missing fixture input" };
  const outDir = join(args.cwd, "mineru", itemId);
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, "full.md");
  writeFileSync(mdPath, `# Offline MinerU fixture ${itemId}\n\n`, "utf8");
  return { status: "success", summary: "offline MinerU fixture", outputs: { items: [{ itemId, mdPath }] } };
}
