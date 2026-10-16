/**
 * `@renderer/lib/api.js` 替身 —— **可控的设置读写**(MC-047 回归网地基)。
 *
 * 能力:
 *   - 按 key 预置值(`seedSetting`);
 *   - **按 key** 注入下一次读/写失败(`failNextGetFor` / `failNextSetFor`)——
 *     浏览器面板一次挂载会按树序读好几格,不按键定向就没法精确砸哪一格;
 *   - 记录每次 get/set 调用;
 *   - 其他命名空间给递归空壳(`api.anything.whatever()` 都解析,返回值字段为
 *     undefined —— 消费方读取不到就安静跳过,不影响本套的断言面)。
 */
const values = new Map<string, string>();
const gets: string[] = [];
const sets: Array<{ key: string; value: string }> = [];
const failGetKeys = new Map<string, string>();
const failSetKeys = new Map<string, string>();

export function seedSetting(key: string, value: string): void {
  values.set(key, value);
}
export function failNextGetFor(key: string, message: string): void {
  failGetKeys.set(key, message);
}
export function failNextSetFor(key: string, message: string): void {
  failSetKeys.set(key, message);
}
export function getCalls(): string[] {
  return [...gets];
}
export function setCalls(): Array<{ key: string; value: string }> {
  return [...sets];
}
export function readValue(key: string): string | undefined {
  return values.get(key);
}
export function resetApiStub(): void {
  values.clear();
  gets.length = 0;
  sets.length = 0;
  failGetKeys.clear();
  failSetKeys.clear();
}

export const api = {
  setting: {
    get(input: { key: string }): Promise<{ value: string | null }> {
      gets.push(input.key);
      const failure = failGetKeys.get(input.key);
      if (failure !== undefined) {
        failGetKeys.delete(input.key);
        return Promise.reject(new Error(failure));
      }
      return Promise.resolve({ value: values.get(input.key) ?? null });
    },
    set(input: { key: string; value: string }): Promise<unknown> {
      sets.push({ ...input });
      const failure = failSetKeys.get(input.key);
      if (failure !== undefined) {
        failSetKeys.delete(input.key);
        return Promise.reject(new Error(failure));
      }
      values.set(input.key, input.value);
      return Promise.resolve({ ok: true });
    },
  },
  pickFolder: (): Promise<{ path: string }> => Promise.resolve({ path: "" }),
};

/** 递归空壳:`api.browser.vaultStatus()` / `api.whatever.deep.call()` 都能解析并
 *  resolve 一个通用回执(字段读取为 undefined,消费方按"拿不到"处理)。 */
function shell(path: string): unknown {
  const callable = (...args: unknown[]): Promise<unknown> => Promise.resolve({ path, args });
  return new Proxy(callable, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return shell(`${path}.${prop}`);
    },
  });
}

export default new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (prop === "setting") return api.setting;
    if (prop === "pickFolder") return api.pickFolder;
    if (typeof prop !== "string") return undefined;
    return shell(prop);
  },
});
