/**
 * O7: machine-readable, intentionally human-authored coverage boundary for
 * Office acceptance suites. It is NOT inferred from their PASS count.
 */
export const OFFICE_COVERAGE = Object.freeze({
  o0: Object.freeze({
    tier: "u1",
    coverage: "6 份隔离复杂样本、六格式打开→改动→保存→重开、49 项语义保真断言及变异",
    notCovered: "任意文档的任意编辑、PDF 旋转后的视觉呈现、PPTX 真实模板的占位符继承",
  }),
  o1: Object.freeze({
    tier: "smoke",
    coverage: "Claude/Pi/Codex 三家协议形状、错误、取消、负控和工具结果 ACK",
    notCovered: "真实在线 SDK/API 调用、实际凭据、真实模型编辑的端到端行为",
  }),
  o3: Object.freeze({
    tier: "u1",
    coverage: "Windows x64 解压态产物、六格式打开与渲染、资源缺失负控",
    notCovered: "NSIS 安装器安装流程、macOS/Linux、六格式编辑→保存→重开",
  }),
});

/** Reject a missing/renamed line rather than letting a fluent note pass as evidence. */
export function validateOfficeCoverage(output) {
  if (typeof output !== "string") throw new Error("coverage output must be a string");
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines.length !== 3
    || !/^TIER: (smoke|u1|deep)$/.test(lines[0] ?? "")
    || !/^COVERAGE: \S.+/.test(lines[1] ?? "")
    || !/^NOT-COVERED: \S.+/.test(lines[2] ?? "")) {
    throw new Error("Office coverage output requires exactly TIER, COVERAGE, NOT-COVERED");
  }
  return output;
}

export function formatOfficeCoverage(suite) {
  const item = OFFICE_COVERAGE[suite];
  if (!item) throw new Error(`unknown Office coverage suite: ${suite}`);
  return validateOfficeCoverage(
    `TIER: ${item.tier}\nCOVERAGE: ${item.coverage}\nNOT-COVERED: ${item.notCovered}\n`,
  );
}

export function printOfficeCoverage(suite) {
  process.stdout.write(formatOfficeCoverage(suite));
}

if (process.argv[1] && /office-coverage\.mjs$/.test(process.argv[1])) {
  printOfficeCoverage(process.argv[2]);
}
