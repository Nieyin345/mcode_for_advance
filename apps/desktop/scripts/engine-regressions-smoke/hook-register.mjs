/** 注册 ts-js-resolve-hook.mjs(见那个文件的头注释:Node 直跑 TS 时把
 *  相对 `.js` 说明符解析到 `.ts` 姐妹文件)。`node --import <本文件>`。 */
import { register } from "node:module";

register("./ts-js-resolve-hook.mjs", import.meta.url);
