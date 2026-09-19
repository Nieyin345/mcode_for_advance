/**
 * 把"被测的三份 + 两份桩"从**一个模块**里转出去。
 *
 * ## 为什么要有这一个文件
 *
 * `--alias:` 换桩之后,桩是**另一份模块实例** —— `stubs/rgSearch.ts` 里的
 * `resetCount` 和被测代码 `rgInstall.ts` 调进去的那份是同一个(因为 alias 把它换掉了),
 * 所以从桩里读计数是对的。
 *
 * 但**被测的两个模块之间**必须共享同一份 `@main/lib/rgInstall.js`:本套前面调的
 * `installRg()`(裸模块)与后面经 `registerRgHandlers` 取出来的 `rg.install` handler
 * 里调的那个,得是**同一个 installInFlight**。esbuild 对同一个文件只会打进来一份,
 * 所以正常 import 就是同一份 —— 这个文件存在的意义是把"哪几个符号、从哪儿来"收在
 * 一处,让 main.ts 里不再出现两次 import 同一个模块(那种写法一旦有人改成动态拼路径,
 * 就会悄悄变成两份实例,而症状是"并发那几条莫名其妙地红")。
 *
 * ⚠️ 技能文档里那条坑的**反面**:如果被测模块用**相对路径** import 了另一个也要换桩的
 * 模块,`--alias:` 换不掉相对 import,于是会得到两份实例。这里没有这种情况 ——
 * `rgInstall.ts` 的全部 import 都是 `@main/…` 包名形式的,alias 都能换。
 */
export { IPC } from "@contracts/ipc";
export { registerRgHandlers } from "@main/ipc/rg.js";
export { installRg, isRgInstalling } from "@main/lib/rgInstall.js";
export { bundledRgPath, resetCountNow as resetCount } from "./stubs/rgSearch.js";
