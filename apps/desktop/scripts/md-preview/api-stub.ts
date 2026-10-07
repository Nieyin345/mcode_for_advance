/** md-preview 用的 api 桩：图片读取回真 data URL，其余走空实现。
 *  ⚠️ data URL 直接写在这里，**不能**经 `window.__mdStub` 转一手 —— ES 的 import
 *  先于 entry 模块体执行，那个 assignment 还没跑，读到的会是空串（probe.mjs 头注
 *  第 5 条记的正是这个坑）。 */
const RED_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const asyncNoop = (): Promise<undefined> => Promise.resolve(undefined);
function deep(): unknown {
  return new Proxy(asyncNoop, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      if (prop === "constructor") return Object;
      return deep();
    },
    apply: () => Promise.resolve(undefined),
  });
}

export const api = {
  file: {
    readBinary: (): Promise<{ dataUrl: string }> => Promise.resolve({ dataUrl: RED_DOT }),
    readFile: deep(),
  },
  on: deep(),
  setting: deep(),
};
