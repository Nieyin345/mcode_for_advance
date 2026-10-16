/**
 * Node 直跑 TS 的解析钩子：把相对 `./x.js` 说明符解析到 `./x.ts`。
 *
 * tsconfig 四条 (`moduleResolution: "bundler"`) 约定源码内互相导入写 `.js`
 * 后缀(编译产物才是 .js)，esbuild / vite / tsc 都认这条约定 —— 但 Node 的
 * ESM 解析器不认：直跑 TS (`--experimental-transform-types`) 时它去找真
 * `.js` 文件，找不到就 ERR_MODULE_NOT_FOUND。
 *
 * 从前 `engine-regressions-smoke` 直跑适配器没碰到这一点，纯属巧合 —— 那些
 * 适配器链上的跨模块导入恰好全是 `import type`(被类型擦除剥掉)。MC-009
 * 给 PiMessageAdapter 加了第一个**值级**跨模块导入(共享截断判据)，这条约定
 * 就露出来了。
 *
 * 这个钩子只挂在那一个直跑套件上(`--import` 注册)，esbuild 打包的套件不用、
 * 也不受影响。只处理相对说明符 —— 裸包名(`node:crypto`、`@main/...` 的
 * type-only 形式)原样放行，避免把自己变成第二个解析器。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    const tsCandidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(tsCandidate))) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
