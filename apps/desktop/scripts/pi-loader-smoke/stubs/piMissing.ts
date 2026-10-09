/**
 * 让裸 `@earendil-works/pi-coding-agent` 动态 import 以 ERR_MODULE_NOT_FOUND 失败,
 * 复现「本机哪儿都没装 pi」——它会是打包机上有 node_modules 时的唯一拦路条件。
 */
const err = new Error("Cannot find package '@earendil-works/pi-coding-agent'");
(err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
throw err;
