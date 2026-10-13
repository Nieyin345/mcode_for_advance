/**
 * 【MC-096 E1 夹具】—— `@main/lib/appContext.js` 的**转发壳**,让 `atomicWrite` 有一个**一次性钩子**。
 * 只在 `extension-store-smoke/run.sh` 里经 esbuild `--alias:@main/lib/appContext.js=...` 换掉真那份;
 * **没设钩子时逐调用转发真实实现**(其余用例照常走真 atomicWrite)。生产代码 `lib/extensionStore.ts`
 * **一行未改** —— 这不是第二套实现,只是把落盘那一步换成一个可控的替身。
 *
 * ## 它复现什么
 *
 * MC-096 的总量竞态:`writeFileInExtension` 先算 `directoryBytes(...)`、再 `atomicWrite(...)` 落盘。
 * 夹具把钩子挂在 `atomicWrite` 上:第一个写者的 `atomicWrite` 即将落盘时,同步**启动第二个写者**
 * (它还没落盘)。修好后(总量检查在**宿主级目录租约内**复查),第二个写者必须**等第一个释放租约**
 * 才拿到锁、读到已落盘的用量而拒;修好前(裸检查,无租约)第二个写者在同一个同步栈里跑完并放行
 * —— 两者都落盘、累计超 `EXTENSION_TOTAL_MAX`。这就把跨进程才有的竞态变成**确定性**的单进程复现。
 *
 * 与 `maint-m07-smoke/fsFaultShim.ts` 同一姿势:壳自己用**相对路径** import 真实现(不经 alias,
 * 否则自我递归),再 `export *` 把真那份的其余导出原样透出。
 */
import { atomicWrite as realAtomicWrite } from "../../../src/main/lib/appContext.js";

export * from "../../../src/main/lib/appContext.js";

/** 一次性钩子:下一次 `atomicWrite` 触发前同步调用(用来塞第二个写者)。 */
let beforeWrite: ((file: string) => void) | null = null;

export function armAtomicWriteHook(fn: ((file: string) => void) | null): void {
  beforeWrite = fn;
}

export function atomicWrite(file: string, text: string): void {
  const fn = beforeWrite;
  if (fn) {
    beforeWrite = null; // 一次性 —— 只在那一发之前插一次,不递归
    fn(file);
  }
  return realAtomicWrite(file, text);
}
