/**
 * 浏览器全局 + 一个**能观察 blob URL 生命周期的假 `URL`**。
 *
 * main.ts 第一个 import 它 —— ES 模块按顺序求值,这些要在 `DocxPreview` 的模块
 * 求值(`@renderer/lib/i18n` 之类)之前就位。`DocxPreview` 的 effect 里会用到:
 *   - `ResizeObserver`(`new ResizeObserver(...).observe(host)`);
 *   - `getComputedStyle` / `host.clientWidth`;
 *   - `URL.createObjectURL` / `URL.revokeObjectURL` —— 这是**被测点**:`docx-preview`
 *     的图片/字体全走 `createObjectURL`,本套数"创建了几个、撤销了几个"。
 *
 * `URL.createObjectURL` 在本套里**不碰真 Blob**,只发一个递增的假 id 并记账。
 * `revokeObjectURL` 把对应 id 标成已撤销。断言就是两条账的差集。
 */
type Creation = { url: string; revoked: boolean };

export const blobLog = {
  created: [] as Creation[],
  revokeCalls: [] as string[],
  reset(): void {
    this.created.length = 0;
    this.revokeCalls.length = 0;
  },
  /** 还没被撤销的 URL。 */
  live(): string[] {
    return this.created.filter((c) => !c.revoked).map((c) => c.url);
  },
};

let blobSeq = 0;

const globalTarget = globalThis as unknown as Record<string, unknown>;

class FakeURL {
  static createObjectURL(_blob: unknown): string {
    const url = `blob:mcode-smoke/${++blobSeq}`;
    blobLog.created.push({ url, revoked: false });
    return url;
  }
  static revokeObjectURL(url: string): void {
    blobLog.revokeCalls.push(url);
    const entry = blobLog.created.find((c) => c.url === url);
    if (entry) entry.revoked = true;
  }
}
globalTarget.URL = FakeURL;

/** 无操作 ResizeObserver —— `DocxPreview` 的 effect 会 `new` 它并 `observe(host)`。 */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalTarget.ResizeObserver = FakeResizeObserver;

globalTarget.getComputedStyle = () => ({ paddingLeft: "0px", paddingRight: "0px" });
globalTarget.requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 16) as unknown as number;
globalTarget.cancelAnimationFrame = (h: number) => clearTimeout(h);

if (typeof globalTarget.document === "undefined") {
  globalTarget.document = {
    documentElement: { lang: "en", setAttribute: () => {} },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    visibilityState: "visible",
  };
}
