/**
 * `@main/store/repositories.js` 的替身 —— 只提供 `SettingRepo` 的内存版。
 *
 * 真那份要 sql.js + 真数据根(见 mcp-ipc-smoke 的 run.sh 里那三条环境变量的说明)。
 * 本套要验的是 `mcpConfig` 拿到**一行坏数据**时的行为,和库本身无关 —— 所以换成
 * 内存 map,并额外开一个 `seedRaw` 让测试能塞进合法 JSON 之外的字节。
 */
const store = new Map<string, string>();

export const SettingRepo = {
  get(key: string): string | null {
    return store.has(key) ? store.get(key)! : null;
  },
  set(key: string, value: string): void {
    store.set(key, value);
  },
};

/** 测试专用:直接写入原始字符串(可以不是合法 JSON)。 */
export function seedRaw(key: string, raw: string): void {
  store.set(key, raw);
}

/** 测试专用:读回原始字符串,用来验证"自愈"确实把坏行覆盖掉了。 */
export function peekRaw(key: string): string | null {
  return store.has(key) ? store.get(key)! : null;
}

/** 测试专用:清空。 */
export function clearRaw(): void {
  store.clear();
}

