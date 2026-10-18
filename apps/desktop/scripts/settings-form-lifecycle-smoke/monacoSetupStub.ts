/** 【MC-026 复核】`@renderer/lib/monacoSetup.js` 的叶子桩 —— 面板级组件的执行链里
 *  `CodeParamField` 会 import 它(引 `?worker` 资源,esbuild 解析不了);本套件不挂
 *  编辑器、也永不渲染那个惰性组件,只需要导入面可求值。 */
export function monacoSetup(): void {}
export default { monacoSetup };
