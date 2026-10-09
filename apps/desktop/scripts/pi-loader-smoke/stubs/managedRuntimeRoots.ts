/**
 * `@main/runtimes/managedRuntimeRoots.js` 的桩 —— piSdkLoader 的运行期探针。
 *
 * 真模块从 electron 派生的 userData 路径取根,无头跑不了。这里把根与版本清单
 * 交给环境变量,让脚本能分别构造「托管安装加载失败」与「哪儿都没装」两种场景,
 * 断言抛出来的那句话是中文(用户可见,直接进健康检查的状态栏/起轮错误)。
 */
export function getManagedRuntimeRoot(): string | null {
  return process.env["MCODE_SMOKE_MANAGED_ROOT"] || null;
}

export function listManagedVersions(_agent: string): string[] {
  const raw = process.env["MCODE_SMOKE_MANAGED_VERSIONS"] || "";
  return raw ? raw.split(",") : [];
}
