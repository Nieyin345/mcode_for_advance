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

/**
 * 本套对 ONLYOFFICE 安装结果的**唯一控制点**。
 *
 * 默认 `null` = 不该走到这条路(与从前一致:抛"本套不该走到 ONLYOFFICE 的提权安装")。
 * 用例若要验 `toolInstall` 的**错误文案映射**(`onlyOfficeErrorText`),就 `setOnlyOfficeFailure`
 * 塞一个 `localInstall` 真会抛的原始码/英文句,那段就把它当真错误重抛出去 —— 于是
 * `installTool("onlyoffice")` 会走真实的 catch → 映射 → 抛出,判据钉在被翻出来的那句话上。
 */
let injectedFailure: string | null = null;

/** 让下一次(以及之后直至清空)`installLocalDocumentServer` 抛这条原始错误。 */
export function setOnlyOfficeFailure(raw: string | null): void {
  injectedFailure = raw;
}

export function installLocalDocumentServer(): Promise<void> {
  if (injectedFailure !== null) return Promise.reject(new Error(injectedFailure));
  return Promise.reject(new Error("本套不该走到 ONLYOFFICE 的提权安装"));
}

/** 「已经装过 → 只修配置」那条路。同样受 {@link setOnlyOfficeFailure} 控制。 */
export function detectLocal(): Promise<{ installed: boolean; suggestedServerUrl?: string }> {
  if (injectedFailure !== null) return Promise.resolve({ installed: true, suggestedServerUrl: "http://127.0.0.1:8080" });
  throw new Error("本套不该走到 ONLYOFFICE 检测");
}

export function configureLocalDocumentServer(): Promise<void> {
  if (injectedFailure !== null) return Promise.reject(new Error(injectedFailure));
  return Promise.reject(new Error("本套不该走到 ONLYOFFICE 的提权配置"));
}

