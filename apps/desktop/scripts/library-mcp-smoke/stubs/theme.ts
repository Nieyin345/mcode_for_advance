/**
 * `@main/lib/theme.js` 的替身 —— 真的那个 import 了 electron 的 `nativeTheme`。
 *
 * 拖进这条路的唯一原因是 `BrowserManager`(见 stubs/browserManager.ts 的说明)。
 * 本套一次都不读主题,给两个常量就够 —— 但**不抛**:它不是"不该被调到"的那种,
 * 而是"调到了也无所谓"的那种。
 */
export function getOsPrefersDark(): boolean {
  return false;
}

export function getThemePreference(): string {
  return "system";
}
