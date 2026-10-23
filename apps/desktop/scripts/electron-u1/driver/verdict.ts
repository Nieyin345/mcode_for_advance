/**
 * T16 —— 共享判定逻辑（启动器与探针共用；零 Electron / 零 IO）。
 *
 * 判定的**红/绿事实**只有一个来源：探针记录每步的字面 PASS/FAIL，启动器只按
 * `journey.expect` 解释它。变异验证（把 `assertionStatus` 改成无条件 PASS）会
 * 直接翻转这里读到的 literalStatus —— 所以「由红变绿」可被机器核对。
 *
 * ## 退出码语义（build.mjs / run.sh 共用）
 *
 * - `0` 全绿：每条旅程的所有步骤都 PASS。**默认（无变异）跑不该出现 0** ——
 *   第三条旅程是故意失败的自检，它一旦变绿说明断言没有在判。
 * - `1` 预期红：唯一失败的是标了 `expect:"fail"` 的旅程，且 `failBecause` 认可
 *   失败形态（失败落在指定步骤、证据已落盘）。这是**默认跑的正常结果**。
 * - `2` 意外红：非"预期失败"的旅程失败，或预期失败形态不对（例如失败于别的步骤，
 *   或骨架自己崩了）。这是真的坏消息。
 */
import type { U1Evidence, U1Journey } from "./types.js";

export function literalStatus(evidence: U1Evidence[]): "PASS" | "FAIL" {
  return evidence.some((e) => e.status === "FAIL") ? "FAIL" : "PASS";
}

export type Expectation = "all-pass" | "expected-failure" | "unexpected-failure";

/** 按旅程声明解释它的字面结果。 */
export function classifyJourney(journey: U1Journey, evidence: U1Evidence[]): { expectation: Expectation; reason?: string } {
  const literal = literalStatus(evidence);
  if (literal === "PASS") {
    if (journey.expect === "fail") {
      // 声明"必须失败"却没有一步失败 —— 这是变异验证要找的红→绿翻转点。
      return { expectation: "all-pass", reason: "旅程声明 expect:\"fail\" 但没有失败（断言可能被旁路）" };
    }
    return { expectation: "all-pass" };
  }
  const failed = evidence.find((e) => e.status === "FAIL")!;
  if (journey.expect !== "fail") return { expectation: "unexpected-failure", reason: `旅程失败于「${failed.step}」` };
  if (typeof journey.failBecause !== "function") return { expectation: "unexpected-failure", reason: "expect:\"fail\" 缺少 failBecause" };
  if (!journey.failBecause(evidence)) {
    return { expectation: "unexpected-failure", reason: `失败形态与预期不符（失败于「${failed.step}」）` };
  }
  return { expectation: "expected-failure" };
}

/** 汇总多条旅程的退出码（见文件头的三档语义）。 */
export function suiteExitCode(journeys: Array<{ journey: U1Journey; evidence: U1Evidence[] }>): { code: 0 | 1 | 2; reasons: string[] } {
  const reasons: string[] = [];
  let unexpected = false;
  let expected = false;
  for (const { journey, evidence } of journeys) {
    const c = classifyJourney(journey, evidence);
    if (c.expectation === "unexpected-failure") unexpected = true;
    if (c.expectation === "expected-failure") expected = true;
    if (c.reason) reasons.push(`${journey.name}: ${c.reason}`);
  }
  if (unexpected) return { code: 2, reasons };
  if (expected) return { code: 1, reasons };
  return { code: 0, reasons };
}

/**
 * 套件是否声明了「故意失败」自检旅程。
 *
 * T16 的注册表里固定有一条 `expect:"fail"` 的 `deliberate-failure`，启动器在正常跑
 * 里**强制**它按预期红（否则视为骨架假绿）。T7 这类「只跑真实产品旅程」的注册表
 * 不该为了满足这条自检而塞一条假旅程 —— 但也不能因此丢掉「断言真的在判」的证据：
 * T7 用 `--mutation=unconditional-pass` 的对照跑（同一批旅程、断言被旁路）证明
 * 断言在判。所以 `build.mjs` 只在注册表**确有** `expect:"fail"` 旅程时才启用
 * 「正常跑必须出现预期红」的自检。
 */
export function hasDeliberateFailureJourney(journeys: U1Journey[]): boolean {
  return journeys.some((j) => j.expect === "fail");
}
