/** `@renderer/lib/icons.js` / `@tabler/icons-react` 的空壳(CJS:任意具名 import 都拿得到)。
 *  那是个几千导出的 barrel,打进来只让这套变慢;图标在惰性 JSX 里只是 `type`,不会被调用。 */
const stub = () => null;
module.exports = new Proxy({}, { get: () => stub });
