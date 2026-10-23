/**
 * `@tabler/icons-react` 的空壳 —— **ESM，显式具名导出**。
 *
 * ## 为什么不能用 CJS Proxy（踩过）
 *
 * 第一版这里是一个 CJS 的 `new Proxy({}, { get: () => stub })`。**运行时它是对的**
 * （任何名字都拿到一个函数），但 **esbuild 打包 CJS 时靠静态分析 `module.exports`
 * 的形状来决定有哪些具名导出** —— Proxy 让它扫不到任何名字，于是
 * `@renderer/lib/icons.tsx` 里那批 `export { IconMessage, ... } from "@tabler/icons-react"`
 * 全部被绑成 `undefined`。
 *
 * 症状极隐蔽：**没有报错**，`<IconMessage />` 渲染出来是一个 `{props:{size:11}}`
 * 这种**没有 `type` 的对象**，`__nodes()` 里什么都找不到。本套件因此红在
 * 「五种来源的图标互不相同」，而真正的原因是**图标一个都没绑上**。
 *
 * ## 所以：显式列出本套件用到的图标
 *
 * 新增图标时在这里加一行。**漏了不会报错，只会让那个图标变成 `undefined`** ——
 * 所以 `main.ts` 里有一条 `★ 正控：图标真的绑上了` 专门守这件事。
 *
 * 每个名字返回**不同的函数**（不是共用一个）：「五种来源的图标互不相同」那条断言
 * 需要能区分它们，共用会把差异抹平、让断言永远看到 1 个值。
 */

/** 画一个 null 的组件；`displayName` 让它可辨认（断言失败时 detail 能看出是哪个）。 */
const icon = (name) => {
  const f = () => null;
  f.displayName = name;
  return f;
};

export const IconBolt = icon("IconBolt");
export const IconCheck = icon("IconCheck");
export const IconClock = icon("IconClock");
export const IconGitBranch = icon("IconGitBranch");
export const IconListCheck = icon("IconListCheck");
export const IconLoader2 = icon("IconLoader2");
export const IconMessage = icon("IconMessage");
export const IconRobot = icon("IconRobot");
export const IconUser = icon("IconUser");
export const IconX = icon("IconX");
