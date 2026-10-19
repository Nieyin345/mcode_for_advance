/**
 * 【MC-037】市场来源注册表的**唯一**读取分类核。
 *
 * 技能市场(`<数据根>/skill-markets/markets.json` 文件)、MCP 市场
 * (`mcp.marketSources` 设置行)、插件市场(`plugins.marketplaces` 设置行)从前
 * 各自实现了一份"读不出来就当空表"的容错 —— 三份都把**损坏**读成**从未添加**,
 * 于是下一次写入(`add*` 拿空表当旧清单整表写回)把用户的历史来源静默抹掉。
 * 本核把判据收成一条,三处共用:
 *
 *   - `absent`  —— 从未写过(文件不存在 / 值为 null 或空串):**合法初始态**,
 *     首次新建仍可正常工作(不能把"新用户"误判成"损坏");
 *   - `ok`      —— 顶层形状合法(JSON 可解析 + 顶层是数组)。**个别**坏记录被
 *     逐条校验丢弃**不算**损坏(核内既有行为:坏行隔离,不阻塞整表 —— 与
 *     MC-052 的"归属未证明才保留"同一取舍方向:这里每条记录的身份就是它自己,
 *     丢掉一条坏行不会伤到别人);
 *   - `corrupt` —— JSON 不可解析 / 顶层不是数组。**拒绝进入读写事务**:读侧不许
 *     把它当空表(那是谎),写侧不许拿它当写回基准(那是数据破坏)。原字节一个不动,
 *     报错显式(给 UI/Agent 同一个 `corrupt` 标记,见各 IPC 返回的 `corrupt?` 字段)。
 *
 * 与 `workflowSeedStatus`(MC-053)、`classifySeedList`、`secretMapStore` 的
 * "损坏可见、拒绝无条件覆盖"是**同一条纪律**;这里抽出来是因为三处市场注册表
 * 的分叉实现正是缺陷本体的一部分(台账原文:"横向基础设施重复实现")。
 */

export type MarketRegistryRead<T> =
  | { kind: "absent" }
  | { kind: "ok"; records: T[] }
  | { kind: "corrupt"; reason: string };

/**
 * 分类一段**原始文本**(文件内容或设置行的值)。
 *
 * @param raw   原始文本;`null` / `""` / 仅空白 → absent(从未写过)。
 * @param parse 顶层形状合法时逐条校验:返回通过校验的记录(个别坏行丢弃)。
 *              顶层不是数组时返回 `null`(= 损坏)。
 * @param label 出错信息里的可读名字(如 "技能市场")。
 * @param shapeError 顶层形状不对时的原因措辞(默认「…记录顶层不是数组」)。
 *              容器形态不同的名单(如技能预设 `{ presets: [...] }`、导入包
 *              `{ bundles: [...] }`)传自己的说法,分类判据仍只有这一份。
 */
export function classifyMarketRegistry<T>(
  raw: string | null,
  parse: (value: unknown) => T[] | null,
  label: string,
  shapeError = `${label}记录顶层不是数组`,
): MarketRegistryRead<T> {
  if (raw === null || raw.trim() === "") return { kind: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: `${label}记录不是合法 JSON` };
  }
  // A malformed individual entry can make a stricter caller-supplied parser
  // throw. That must not escape the shared read classifier: a catalog write
  // after an unhandled parse failure could fall back to an empty list.
  let records: T[] | null;
  try {
    records = parse(value);
  } catch {
    return { kind: "corrupt", reason: `${label}记录解析失败` };
  }
  if (records === null || !Array.isArray(records)) return { kind: "corrupt", reason: shapeError };
  return { kind: "ok", records };
}

/**
 * 写侧拒绝语 —— 三处 `add*` / `remove*` 在 `corrupt` 时用**同一句**话拒绝,
 * 用户/Agent 看到的口径一致。`refuseMarketRegistryWrite` 是它的返回形状快捷方式。
 */
export function marketRegistryCorruptMessage(label: string, reason: string): string {
  return `${label}记录损坏(${reason}),已拒绝写入以免覆盖原记录;请先修复或清空该记录再重试`;
}

/** 写入口的统一守卫:损坏 → `{ ok:false, error }`;否则 `null`(可写)。 */
export function refuseMarketRegistryWrite(
  read: MarketRegistryRead<unknown>,
  label: string,
): { ok: false; error: string } | null {
  return read.kind === "corrupt"
    ? { ok: false, error: marketRegistryCorruptMessage(label, read.reason) }
    : null;
}

/**
 * 长操作(git 索引拉取/扫描/网络探测)结束、真正写回之前的**二次判据**。
 *
 * 各 `add*` 入口在操作开始前读过一次记录,但那之后的 `await` 窗口里记录可能被
 * 并发改写或砸坏。若照旧用**操作前的快照**(或更糟:降级读 `readRecords()`,
 * 损坏时返回 `[]`)写回,就会覆盖窗口内发生的改动 —— 这是 MC-037 原例的时序
 * 变体。这里把"写回基准"统一改成**写回时刻的 fresh 快照**:
 *
 *   - fresh `corrupt` → 拒绝写入,原字节不动(与入口处同一句拒绝语);
 *   - fresh `ok`/`absent` → 以 fresh 为基准合并本次变更(不丢窗口内的并发新增)。
 *
 * 物理写回仍由各副本自己做(文件 / 设置行不同),判据只有这一份。
 */
export function recheckMarketRegistryBeforeWrite<T>(
  fresh: MarketRegistryRead<T>,
  label: string,
): { ok: true; base: T[] } | { ok: false; error: string; corrupt: true } {
  if (fresh.kind === "corrupt") {
    return { ok: false, error: marketRegistryCorruptMessage(label, fresh.reason), corrupt: true };
  }
  return { ok: true, base: fresh.kind === "ok" ? fresh.records : [] };
}
