/** `@tabler/icons-react` 的空壳(CJS:这样任意具名 import 都能拿到东西)。 */
const stub = () => null;
module.exports = new Proxy({}, { get: () => stub });
