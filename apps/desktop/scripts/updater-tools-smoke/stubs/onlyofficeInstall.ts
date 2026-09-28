/**
 * `@main/onlyoffice/localInstall.js` 的替身 —— 只给本套无头脚本用。
 *
 * ## 为什么需要它
 *
 * 本套把 `node:fs` / `node:fs/promises` 整个换成了内存里的假文件系统(stubs/fs.ts),
 * 而那份桩只导出「本套真正会走到的那些」函数。`toolInstall.ts` 现在多了一条到
 * ONLYOFFICE 的边(文档工具链里新增的那一项),它经 `OnlyOfficeBridge` 会拉进
 * `cpSync` / `realpathSync` / `openSync` 这些假 FS 没有的名字 —— **在打包阶段**
 * 就报 "No matching export",整套跑不起来。
 *
 * 换桩而不是去撑大 stubs/fs.ts:本套验的是「工具链的装 / 卸」与更新器,
 * ONLYOFFICE 那条路要提权、要跑官方安装器,**本来就不在无头范围内**。
 * 把边切掉比把假 FS 养成一个真 FS 更诚实(同 `@main/window.js` / `@main/updater.js`
 * 在这里的处理)。
 */
export const DEFAULT_DS_PORT = 8080;

export function installLocalDocumentServer(): Promise<void> {
  return Promise.reject(new Error("本套不该走到 ONLYOFFICE 的提权安装"));
}

export function detectLocal(): Promise<never> {
  throw new Error("本套不该走到 ONLYOFFICE 检测");
}

export function configureLocalDocumentServer(): Promise<void> {
  return Promise.reject(new Error("本套不该走到 ONLYOFFICE 的提权配置"));
}

