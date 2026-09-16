/** Vite 的 `?raw` 导入:模块默认导出该文件的**原文**(string)。
 *
 *  主进程的 tsconfig 只带了 `types: ["node"]`,没有 `vite/client`,所以这些导入
 *  在类型层面是不认识的。这里补一份最小声明 —— 只用得上默认导出,不需要别的。 */
declare module "*?raw" {
  const content: string;
  export default content;
}
