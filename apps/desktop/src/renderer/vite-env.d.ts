/// <reference types="vite/client" />

/**
 * Type declarations for Vite's `?worker` import suffix, used by the Monaco
 * bootstrap (monacoSetup.ts) to instantiate editor/language web workers from
 * bundled modules. Without this, tsc treats `"...worker?worker"` as an
 * unresolvable module.
 *
 * Vite's own `vite/client` types declare `*?worker` generically, but only
 * when the `vite/client` reference is present in a file tsc reads. This file
 * ensures that reference is always loaded for the renderer source tree.
 */
declare module "*?worker" {
  const workerConstructor: {
    new (options?: { name?: string }): Worker;
  };
  export default workerConstructor;
}

/**
 * `style-to-js` 是 `hast-util-to-jsx-runtime` 的传递依赖(不在本包的
 * node_modules 顶层,也没有类型),而互操作垫片 `lib/styleToJs.ts` 需要**按深路径**
 * 引它(CJS 那份)—— 声明在这里,免得 tsc 报 "Cannot find module"。
 *
 * 注意:shape 与 `@types/style-to-js` 一致,但**不保证**运行时拿到的就是函数
 * (那正是垫片要处理的事),所以垫片里仍然做了 `.default ?? mod` 的兜底。
 */
declare module "style-to-js/cjs/index.js" {
  const styleToJs: (value: string, options?: { reactCompat?: boolean }) => Record<string, string>;
  export default styleToJs;
}
