/** `@main/utils.js` 的替身 —— 只换掉会用到的 `uid`(真那份拖别的依赖)。 */
let serial = 0;
export function uid(prefix: string): string {
  serial += 1;
  return `${prefix}${serial}`;
}
