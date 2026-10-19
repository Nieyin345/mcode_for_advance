import assert from "node:assert/strict";
import { clampCellBudget } from "@main/lib/readBudget.js";

let checks = 0;
const check = (name: string, act: () => void) => { act(); checks++; console.log("ok " + name); };

check("normal document budget returns bounded 500 by 200", () => {
  assert.deepEqual(clampCellBudget(1000, 200, 100_000), {
    maxRows: 500, maxCols: 200, cellBudgetTruncated: true,
  });
});
check("under-budget request is unchanged", () => {
  assert.deepEqual(clampCellBudget(5, 3, 100), {
    maxRows: 5, maxCols: 3, cellBudgetTruncated: false,
  });
});
for (const [label, rows, cols, cells] of [
  ["nan rows", Number.NaN, 20, 100],
  ["infinite cols", 5, Number.POSITIVE_INFINITY, 100],
  ["zero rows", 0, 20, 100],
  ["negative columns", 10, -5, 100],
  ["zero budget", 10, 10, 0],
  ["noninteger budget", 10, 10, 0.5],
  ["infinite budget", 10, 10, Infinity],
  ["nan budget", 10, 10, NaN],
] as const) {
  check("invalid " + label + " fails closed", () => {
    assert.throws(() => clampCellBudget(rows, cols, cells), /finite|integer|positive|预算|上限|合法/i);
  });
}
console.log("read-budget-bounds-smoke:" + checks + "/" + checks + " PASS");
