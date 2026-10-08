/**
 * `docx-preview` 的替身 —— 只保留**与本次被判缺陷相关的那一条真实行为**。
 *
 * 真库里 `HtmlRenderer.blobToURL` 是这么写的(dist/docx-preview.js):
 *
 *   ```js
 *   if (this._options.useBase64URL) return blobToBase64(blob);
 *   return URL.createObjectURL(blob);
 *   ```
 *
 * 而 `defaultOptions.useBase64URL = false`,且**整个 dist 里 `revokeObjectURL` 出现 0 次**
 * (grep 过)。于是每遇到一张内嵌图片 / 一个内嵌字体,库就 `createObjectURL` 一份,
 * 却从不撤销 —— 谁也没法撤,因为它不把 URL 交出来。
 *
 * 本替身如实复刻这一支:文档里有一张图 → `useBase64URL` 为真就产出 `data:` URL,
 * 否则走 `URL.createObjectURL`(此时 prelude 里那份记账的假 `URL` 会把这次创建记下来)。
 * 组件能做的唯一一件事就是**把 `useBase64URL: true` 传进去**(它拿不到库创建的 URL,
 * 无从自己销毁)—— 这正是本套要钉住的那个决定。
 */
import { blobLog } from "../prelude.js";

export interface RenderOptions {
  useBase64URL?: boolean;
  [key: string]: unknown;
}

/** 记下组件实际传进来的选项,断言里可以直接看。 */
export const renderCalls: Array<{ options: RenderOptions }> = [];

/** 假的一份内嵌图片字节 —— 包成 Blob,与真库 `new Blob([...])` 后传给
 *  `URL.createObjectURL` 的调用形状一致(那正是 SDK 的入参类型)。 */
function imageBlob(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
}

/**
 * 复刻 `renderAsync` 的签名与"加载内嵌图片"那一支。
 * `body` / `styleContainer` 只是被写入的宿主,内容不重要。
 */
export async function renderAsync(
  _data: unknown,
  body: { innerHTML?: string },
  _styleContainer?: { innerHTML?: string },
  userOptions?: RenderOptions,
): Promise<unknown> {
  const options = userOptions ?? {};
  renderCalls.push({ options });
  const src = options.useBase64URL ? "data:image/png;base64,iVBORw0KGgo=" : URL.createObjectURL(imageBlob());
  void blobLog; // 保证 prelude 的记账器已求值(URL 已被替换)
  if (body) body.innerHTML = `<section class="mcode-docx"><img src="${src}"></section>`;
  return { images: 1 };
}
