import type { ExecutionEngine } from "../../src/main/orchestration/executionEngine.js";
import type { ExecutionContext } from "../../src/main/orchestration/executionContext.js";
import type { NodeOutcome } from "@contracts/nodeType";
import type { buildNodeInput } from "../../src/main/orchestration/nodeInputBuilders.js";
export type RunNode = (node: ExecutionContext["node"], manifest: ExecutionContext["manifest"], input: ExecutionContext["input"]) => Promise<NodeOutcome>;
// build.mjs replaces this TEST file with expressions extracted by TypeScript AST
// from runner.ts. No database/session/model bootstrap is imported. Failure to find
// those expressions is a harness error, never a valid product red light.
export function createRunnerFixture(_conversation: RunNode, _fallback: RunNode): ExecutionEngine {
  throw new Error("Run through build.mjs to test the actual runner registration expression");
}
export function runnerInputFixture(_session: { id: string }, _runId: string): typeof buildNodeInput {
  throw new Error("Missing AST-extracted input binding");
}
export function runnerKindsFixture(_engine: ExecutionEngine): string[] {
  throw new Error("Missing AST-extracted capability inventory");
}
