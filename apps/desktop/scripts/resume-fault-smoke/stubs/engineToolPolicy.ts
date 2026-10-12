export const excludedToolsForEngine = () => [];
export const readEngineToolPolicy = () => ({});
export const writeEngineToolPolicy = () => {};
export const engineSupportsToolExclusion = () => true;
export const defaultEngineToolPolicyPath = () => "/tmp/mcode-fake/engine-tools.json";
export const normalizeExclude = () => [];
export const minimizePolicy = () => ({});
// 【MC-071 残余 E1】Provider 侧改走「状态与执行授权同源」的 resolver。本套验的是
// 故障恢复,策略文件不参与 —— 桩返回不设限空表即可(与上面 excludedToolsForEngine 同义)。
export const resolveEngineExcludedToolsForProvider = () => [];
export const resolveEngineExcludedToolsForProviderFile = () => [];
