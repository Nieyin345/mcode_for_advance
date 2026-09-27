import assert from "node:assert/strict";
import { NodeRunnerSchema } from "@contracts/nodeType";
// A behavior assertion against the existing production contract, not a missing import.
assert.equal(NodeRunnerSchema.safeParse({ kind: "module-capability" }).success, true,
  "P2-01: contracts must recognize the module-capability runner");
console.log("PASS runner contract recognizes module-capability");
