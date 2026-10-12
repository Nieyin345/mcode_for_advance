/**
 * **GrantStore 的装配点与单例读取口**(ARC-004 实施步 ④ 的启动装配切片)。
 *
 * 步① 交付了纯判定核 `policyEngine.evaluate`;`grantStore.ts` 交付了**唯一签发口**;
 * `grantStoreFile.ts` 交付了**落盘**。但三者此前**没有任何生产代码把它们接起来** ——
 * 全仓没有一处 `new GrantStore({ persist: … })`。本模块补上那件「装」:
 *   - 一个**纯装配函数** `assembleGrantStore(dataRoot)`,按 `grantStoreFile.ts` 同样的
 *     窄姿势**只收一个数据根字符串**,自己拼出 `fileGrantPersist(atomicFileBlob(<数据根>/
 *     appControl/grants.json))`,把持久化真接上;
 *   - 一个进程内**单例读取口** `getGrantStore()`,让执行点(后续切片)统一从这里取授权,
 *     **绝不在各自模块里各 new 一份**(各 new 一份 = 各看各的内存 Map,签发在一处、
 *     查询在另一处 = 假授权)。
 *
 * ## 为什么不 import electron
 *
 * `grantStoreFile.ts` 已经把真正的磁盘读写收在 `BlobIO` 后面,`appContext.atomicWrite`
 * 也不 import electron;数据根是**纯字符串**,由调用方(`main/index.ts`)注入真实的
 * `dataRoot()`。于是本模块可被无头 smoke 直接 bundle —— 断言测**纯装配函数**即可,
 * 不必起 Electron、更不必碰用户数据根。
 *
 * ## 单例默认值 = 进程内内存版(与 operations.ts 同姿势)
 *
 * 未装配时 `getGrantStore()` 给到的是一个**进程内内存版**(无 persist):能签发、能查、
 * 能撤销,只是不跨重启。生产在 `main/index.ts` 的启动路径上调一次 `assembleGrantStore
 * (dataRoot())` 换上**落盘版**;换上之后不回退 —— 静默降级会让「已经持久落盘」变成假象。
 */
import { GrantStore } from "./grantStore.js";
import { atomicFileBlob, fileGrantPersist, grantStorePath } from "./grantStoreFile.js";

/**
 * 当前生效的 `GrantStore`。**默认是进程内内存版**(未装配);生产启动时换成落盘版。
 * 读取口只有一个 —— 想拿授权一律走 `getGrantStore()`,别在别处再 `new`。
 */
let activeStore: GrantStore = new GrantStore();

/** 单例读取口。执行点 / 签发口统一从这里取,**绝不在别处各 new 一份**。 */
export function getGrantStore(): GrantStore {
  return activeStore;
}

/**
 * 装配口 / 测试复位口。传 `null` 复位回一个**全新**的内存版(每个用例前清一次,免得串味);
 * 传实例则令它成为当前单例。生产不直接调它 —— 走 {@link assembleGrantStore}。
 */
export function setGrantStore(store: GrantStore | null): void {
  activeStore = store ?? new GrantStore();
}

/**
 * **纯装配函数**:给定数据根,装配一份落盘版的 `GrantStore` 并令它成为单例。
 *
 * 落点由 {@link grantStorePath} 决定 —— `<数据根>/appControl/grants.json`,与
 * `grantStoreFile.ts` 的判据同源:授权是**本机本用户**的事实,**不参与设置导入导出**。
 * `main/index.ts` 那层只传真实的 `dataRoot()`;无头 smoke 传临时目录即可,绝不碰数据根。
 */
export function assembleGrantStore(dataRoot: string): GrantStore {
  const store = new GrantStore({
    persist: fileGrantPersist(atomicFileBlob(grantStorePath(dataRoot))),
  });
  setGrantStore(store);
  return store;
}
