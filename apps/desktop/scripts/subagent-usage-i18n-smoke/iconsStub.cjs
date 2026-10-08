/** `@tabler/icons-react` 空壳(CJS,任意具名 import 都拿得到东西)。 */
const stub = () => null;
module.exports = new Proxy({}, { get: () => stub });
