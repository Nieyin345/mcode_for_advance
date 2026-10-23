/**
 * `electron` 的替身 —— 只给 T90 的子进程探针用。
 *
 * `dataRoot.ts` 用 `app.getPath("userData")` 找数据根指针、`app.getPath("home")`
 * 回落。探针要精确控制这两条路径，所以这里从环境变量读。
 *
 * ⚠️ **没设就抛**：与 `run-store-smoke/stubs/dataRoot.ts` 同一条纪律 ——
 * `copyDataRootTo` 会真的复制目录，路径错了就是把东西写到不该写的地方。
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 没设 —— 这个桩只给 T90 探针用`);
  return v;
}

export const app = {
  getPath(name: string): string {
    if (name === "userData") return required("MCODE_T90_USER_DATA");
    if (name === "home") return required("MCODE_T90_HOME");
    throw new Error(`T90 探针不需要 app.getPath(${name})`);
  },
};

/** `dataRoot.ts` 在 `log` 上只用 info/warn/error —— 静默即可，失败由退出码表达。 */
export const log = { info: () => {}, warn: () => {}, error: () => {} };
