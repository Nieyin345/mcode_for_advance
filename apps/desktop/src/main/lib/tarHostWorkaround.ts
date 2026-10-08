/**
 * **Windows 上那个 GNU tar 坑的判据** —— 一份,给两处解压路径共用。
 *
 * ## 是什么
 *
 * 解压 `.zip` / `.tar.gz` 时我们调系统的 `tar`。macOS 与 Windows 10+ 自带的是
 * **bsdtar**(能读 zip),但 Windows 的 PATH 上可能有一个 **MSYS/Git Bash 的 GNU tar**
 * 排在 System32 的 bsdtar 前面 —— GNU tar 会把 `C:\foo\bar.zip` 当成远端主机
 * `C:\foo\bar.zip`(即 `host:file`)去连,直接报
 * `Cannot connect to C: resolve failed`(退出码 128)。
 *
 * ## 怎么绕
 *
 * GNU tar 自己的开关 `--force-local` 就是为这种冒号路径准备的(健康的 bsdtar 从不需要它),
 * 所以**撞到这个特征就带 `--force-local` 重试一次**。
 *
 * ## 为什么单开一个文件
 *
 * 这个判据从前在 `lib/rgInstall.ts` 与 `plugins/pluginManager.ts` **各写了一份**
 * (正则与"重试一次"的意图都一样,只是各自的解压包装不同)。两边分岔时没有任何东西会报出来
 * —— 一个坑只在一处被绕开,另一条路上用户还是解压失败。放在这里两边共用,正则只有一份;
 * 各自的 tar 调用包装仍留各自文件(它们的调用签名本就不同)。
 */
export const TAR_REMOTE_HOST_RE = /Cannot connect to .* resolve failed/i;

/** Windows 上 PATH 的 tar 报"把路径当远端主机"了吗?是 → 调用方应带 `--force-local`
 *  重试一次。非 win32 恒 false(这个坑只在 Windows 的不一致 tar 生态里存在)。 */
export function isTarRemoteHostFailure(message: string): boolean {
  return process.platform === "win32" && TAR_REMOTE_HOST_RE.test(message);
}
