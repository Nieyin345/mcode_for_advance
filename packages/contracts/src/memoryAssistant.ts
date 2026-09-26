import { z } from "zod";
import type { Session } from "./session.js";
export const MEMORY_ASSISTANT_CHANNEL = "memory:assistant";
export const MemoryAssistantKindSchema = z.enum(["capture", "checkpoint", "health"]);
export type MemoryAssistantKind = z.infer<typeof MemoryAssistantKindSchema>;
export const MemoryAssistantJobSchema = z.object({
  id: z.string(), sourceSessionId: z.string(), projectId: z.string(), workerSessionId: z.string(),
  kind: MemoryAssistantKindSchema,
  status: z.enum(["running", "ready", "failed", "cancelled", "queued", "consumed", "expired"]),
  createdAt: z.number(), expiresAt: z.number(), result: z.string(), error: z.string().optional(),
  targetSessionId: z.string().optional(),
});
export type MemoryAssistantJob = z.infer<typeof MemoryAssistantJobSchema>;
const sessionId = z.string().min(1).max(180);
export const MemoryAssistantSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), sessionId }),
  z.object({ op: z.literal("start"), sessionId, kind: MemoryAssistantKindSchema }),
  z.object({ op: z.literal("cancel"), sessionId, jobId: sessionId }),
  z.object({ op: z.literal("discard"), sessionId, jobId: sessionId }),
  z.object({ op: z.literal("deliver"), sessionId, jobId: sessionId, targetSessionId: sessionId.optional() }),
]);
export type MemoryAssistantInput = z.infer<typeof MemoryAssistantSchema>;
export interface MemoryAssistantResult { jobs: MemoryAssistantJob[]; incoming?: MemoryAssistantJob; target?: Session }
