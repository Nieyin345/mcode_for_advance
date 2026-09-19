/* ────────────────────────── 触发器变量(memory / VAR-06)────────────────────────── */

/**
 * **零依赖叶子模块**:只有 `{{trigger.*}}` 的词法、候选与展开,不 import 任何东西。
 *
 * 为什么要单独一个文件:`scheduler.ts` 与 `nodeInputBuilders.ts` 都要用这份展开器,
 * 但后者牵着 `memory/retrieval`(进而牵 `electron`/dataRoot)—— 冒烟测试把 scheduler
 * 单独打包时,经由 nodeInputBuilders 会把 electron 拉进 bundle 直接炸(2026-09-18
 * 整合门踩过)。触发器变量是纯词法操作,把它抽成叶子,scheduler 就能安全地引用它,
 * 而"候选与解算共用同一个 `trigger.<key>` 名字"的约定不变:两个消费方 import 的是
 * **同一份实现**,不存在长歪的可能。
 */

/**
 * `{{trigger.<key>}}` —— 参数里引用**这次触发载荷**的写法。与 `{{某步.某变量}}` 同一套
 * 花括号词法,但名字空间不同:它不指向图上任何节点,指向的是触发载荷里那份
 * 平面事实(`kind` / `at` / `files` / `event` / `toolName` / `subjects`,见
 * `automationPayload.ts` 的 `TriggerPayloadFacts`)。
 *
 * ⚠️ **哪几种触发带得出哪几个键,判据在 `@contracts/nodeType` 的
 * `triggerFactKeysOf`** —— 界面上「插入变量」列候选用它。这里只认词法,不认识种类。
 */
const TRIGGER_REF_RE = /\{\{\s*trigger\.([A-Za-z0-9_.\-]+?)\s*\}\}/g;

/**
 * 载荷值 → 文本,与 `@contracts/nodeTemplate` 的 `stringify` 同一套规则(字符串原样、
 *  字符串数组用「、」连、其余 JSON)。那边的没导出,这份是触发器自己的名字空间。
 */
function stringifyTriggerValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (value as string[]).join("、");
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * 把**字符串参数**里的 `{{trigger.<key>}}` 换成载荷值。只动字符串 —— 数组、数字、开关
 * 往里插值没有意义(同 `scheduler.expandParams` 的范围)。
 *
 * **引用不到就抛**,由调度器的 catch 兜成这一步的失败 —— 和 `instructionOf`、模板
 * 解算同一条路:原样留着的话模型会自己脑补一个值,而那来自它的想象。两种抛法:
 *  - 这次压根不是触发器起的(没有载荷)→ 说清"没有触发器变量可用";
 *  - 载荷里没有这个 key → 列出**实际有的**那些,让用户照着改。
 *
 * 幂等:解过的参数里已经没有 `{{trigger.` 了,再跑一遍是空操作 —— 所以调度器
 * (`expandParams`)先解一遍之后,`buildNodeInput` 里的第二遍兜底不会有任何副作用。
 */
export function expandTriggerVars(
  params: Record<string, unknown>,
  trigger: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string" || !value.includes("{{")) continue;
    out[key] = value.replace(TRIGGER_REF_RE, (_all, rawKey: string) => {
      const name = String(rawKey).trim();
      if (trigger === undefined) {
        throw new Error(`参数「${key}」里的 \`{{trigger.${name}}}\` 解不出来 —— 这次运行不是触发器起的,没有触发器变量可用`);
      }
      if (!Object.prototype.hasOwnProperty.call(trigger, name)) {
        const have = Object.keys(trigger);
        const available = have.map((k) => "{{trigger." + k + "}}").join("、");
        throw new Error(
          `参数「${key}」里的 \`{{trigger.${name}}}\` 解不出来 —— 这次触发的载荷里没有它,` +
            (have.length > 0 ? `可用的有:${available}` : "载荷是空的"),
        );
      }
      return stringifyTriggerValue(trigger[name]);
    });
  }
  return out;
}
