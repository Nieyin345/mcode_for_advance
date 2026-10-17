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
 */
export function classifyMarketRegistry<T>(
  raw: string | null,
  parse: (value: unknown) => T[] | null,
  label: string,
): MarketRegistryRead<T> {
  if (raw === null || raw.trim() === "") return { kind: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: `${label}记录不是合法 JSON` };
  }
  const records = parse(value);
  if (records === null) return { kind: "corrupt", reason: `${label}记录顶层不是数组` };
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
