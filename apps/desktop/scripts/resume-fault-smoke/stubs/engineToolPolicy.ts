export const excludedToolsForEngine = () => [];
export const readEngineToolPolicy = () => ({});
// 【MC-100/101 诊断】`ipc/engineTools.ts` 的只读诊断入口 import 了它 —— 本套验的是故障恢复,
// 策略不设限即可,故按同义给 `MISSING`(从没设过 → 不设限),与上面那条 `readEngineToolPolicy` 一致。
export const readEngineToolPolicyStatus = () => ({ status: "MISSING" as const, policy: {}, file: "/tmp/mcode-fake/engine-tools.json" });
export const writeEngineToolPolicy = () => {};
export const engineSupportsToolExclusion = () => true;
export const defaultEngineToolPolicyPath = () => "/tmp/mcode-fake/engine-tools.json";
export const normalizeExclude = () => [];
export const minimizePolicy = () => ({});
// 【MC-071 残余 E1】Provider 侧改走「状态与执行授权同源」的 resolver。本套验的是
// 故障恢复,策略文件不参与 —— 桩返回不设限空表即可(与上面 excludedToolsForEngine 同义)。
export const resolveEngineExcludedToolsForProvider = () => [];
export const resolveEngineExcludedToolsForProviderFile = () => [];
