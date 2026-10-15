/**
 * **主机 Hook 授权存储(内存版)** —— MC-061 的授权落地:插件 hook 要执行,得先在这里
 * 有一份**有效**授权(见 `@contracts/hostHookGrant`)。**默认空表 = 默认拒绝**。
 *
 * ## 为什么先做内存版
 *
 * 台账把 MC-061 的完整执行通道划为「一整套新的授权与执行面」。本模块只落**授权那一半的
 * 可测核心**:签发 / 撤销 / 按来源查 / 判定 —— 与 ARC-004 的 `GrantStore` 同姿势(纯逻辑、
 * 可注入时钟、不 import electron/sql)。**真正的执行通道**(宿主 HookRunner 消费判定并在
 * 一次且仅一次 / 带取消预算下真跑)是后续切片;本片让「到底准不准跑」有**唯一判定落点**,
 * 不再是面板里写死的一句 `unsupported`。
 *
 * ## 持久化(跨重启活着)
 *
 * 授权表默认**纯内存**(未装配 = 重启即空,与从前一致)。生产在启动装配点调
 * {@link configureHostHookGrantPersist} 接上落盘版(`hostHookGrantFile.ts`,独立文件,
 * 不参与设置导入导出)。接上后**签发 / 撤销都落盘**,重启经 `load()` 载回 —— 「用户授过信
 * 的这条 hook 每次开机都得重签」这类静默回退因此被堵住。载入是 **fail-safe** 的:坏数据 →
 * 空表(**仍默认拒绝**),绝不把读不懂的当成「全部允许」。
 *
 * ## 撤销 / 卸载同步
 *
 * {@link revokeHostHookGrants} 可按插件名撤掉它全部授权 —— 插件卸载 / 重载时调它,
 * 「卸载后 hook 同步撤销」这条台账要求因此是**一句真的调用**,不是口号。
 */
import { createHash } from "node:crypto";
import { IPC } from "@contracts/ipc";
import {
  decideHostHookExecution,
  hostHookGrantCovers,
  isHostHookGrantActive,
  type HostHookDecision,
  type HostHookGrant,
  type HostHookSource,
} from "@contracts/hostHookGrant";
import { countBudgetExhausted } from "@contracts/policyEngine";

/**
 * 命令内容的**稳定摘要** —— 授权按它绑定(见 `HostHookSource.commandDigest`):命令被改过,
 * 旧授权就不该再覆盖这条 hook。放主进程而不是契约里,是因为契约要能进渲染端,而
 * `node:crypto` 不是渲染端能引的东西。
 */
export function hostHookCommandDigest(command: string): string {
  return `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
}

/**
 * 从一条插件声明的 hook 造出它的**来源身份** —— **唯一构造点**。面板(`toPluginState`)、
 * 宿主执行通道(`HookRunner`)、授权签发,三处必须是**同一份**来源:`commandDigest` 若有
 * 一处漏算,面板标的「已授信」与执行时判的「准不准跑」就会对不上 —— 那正是「看着授了信、
 * 实际不跑」这种最难查的坏。
 */
export function hostHookSourceOf(input: {
  pluginId: string;
  version: string | undefined;
  nativeEvent: string;
  command: string;
  matcher?: string;
}): HostHookSource {
  return {
    pluginId: input.pluginId,
    version: input.version,
    commandDigest: hostHookCommandDigest(input.command),
    nativeEvent: input.nativeEvent,
    // 【MC-061 复审】matcher 摘要:空/未声明 → 空串(不绑定,向后兼容);有值 → 摘要。
    matcherDigest: input.matcher === undefined || input.matcher === "" ? "" : hostHookCommandDigest(input.matcher),
  };
}

/**
 * 一条插件 hook 的**稳定身份** —— 由来源身份(`插件 + 版本 + 原生事件 + 命令摘要`)派生的
 * 短哈希。宿主把它当 `HookSpec.id` 用:同一条 hook 的每一次投递拿的是**同一个 id**,于是
 * 并发闸、交付计数、去重都按「这一条」收口。命令或版本改了,id 就变 —— 与"来源变了、旧
 * 授权作废"是同一条纪律(见 `HostHookSource`)。
 */
export function hostHookIdOf(source: HostHookSource): string {
  const digest = createHash("sha256")
    .update(`${source.pluginId}\u0000${source.version ?? ""}\u0000${source.nativeEvent}\u0000${source.commandDigest}\u0000${source.matcherDigest ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `ph_${digest}`;
}

/** 主机 hook 授权表。模块级单例(生产在装配点用它;测试可 `resetHostHookGrants` 清空)。 */
let grants = new Map<string, HostHookGrant>();
let seq = 0;

/**
 * **授权变了 → 推渲染端**(MC-061 残余)。面板那一栏此前**没有推送通道**,授权**签发 / 撤销 /
 * 用尽**只有等用户手动切页(refetch)才更新 —— 用户盯着那一栏,看不到状态已经变了。
 *
 * ## 为什么是**注入的端口**,不直接 import window.ts
 *
 * 本模块是**纯**的(不 import electron / sql / window):`plugins-smoke` / `hooks-ipc-smoke`
 * 把整张 import 图打包进 node 跑,而 `window.ts` 拖着 `electron`。直接 import 它等于让这两套
 * 无头 smoke 在打包阶段就撞上原生模块。所以留一个窄端口(「窗口能不能收 / 发一条」),由
 * `window.ts` 在模块加载时装入 —— 与 `customUi/settingSync.ts` 的 `SettingNotifyPort` **同一
 * 姿势**(那条通路补的是「Agent 改设置后桌面不刷新」,这条补的是「授权变了面板不刷新」)。
 *
 * ## 没有窗口时**静默跳过**(不攒、不补发)
 *
 * `customUi/settingSync.ts` 会把窗口不在时的那条通知**攒起来**、窗口出现时补发 —— 因为那里
 * 的通知是「一次**已提交**的业务写入需要被桌面看见」,丢了就是真的丢了。**这里不同**:面板
 * 每次挂载 / 展开插件行都 `useRpc` 现读一遍(`listHostHookGrants`),所以窗口不在时没有"会永久
 * 丢失的刷新" —— 窗口一出现,面板自己就会读最新。故这里按**静默跳过**处理(与那条通路"没有
 * 窗口就不推"的**调用姿势**一致,只是不做补发)。
 */
export interface HostHookGrantNotifyPort {
  hasLiveRenderer(): boolean;
  /**
   * 发一条。**签名里不带 channel** —— 通道由本模块定死(见 {@link notifyGrantsChanged}),
   * 装配端只提供「怎么发出去」(`window.ts` 给的就是 `sendToRenderer`)。这样通道名只有
   * 一个出处,`ipc-wiring-smoke` 的推送出口扫描器也能在这份源码里直接看见
   * `sendToRenderer(IPC.HOST_HOOK_GRANTS_CHANGED, …)`。
   */
  send(payload: unknown): void;
}

let notifyPort: HostHookGrantNotifyPort | null = null;

/** 装配发件端口。`window.ts` 在自己的模块初始化时调一次(它手上有 sendToRenderer/hasLiveRendererWindow)。 */
export function setHostHookGrantNotifyPort(p: HostHookGrantNotifyPort): void {
  notifyPort = p;
}

/**
 * 推一条「某插件的授权变了」。**没有窗口 / 端口未装 → 静默跳过**(见 {@link HostHookGrantNotifyPort})。
 * 这是**唯一**的推出口 —— 签发 / 撤销 / 用尽三处都走它,免得各写一份通道名(`IPC.HOST_HOOK_GRANTS_CHANGED`)。
 *
 * `channel` / payload 形状对齐其它 main → renderer 广播(`library:changed` / `workflow:changed`):
 * 消息自身带 `channel` 判别键,渲染端按它分发。
 */
function notifyGrantsChanged(pluginId: string, reason: string, grantId?: string): void {
  if (notifyPort === null || !notifyPort.hasLiveRenderer()) return;
  // 载荷自带 `channel` 判别键(与 `library:changed` / `workflow:changed` 同形)。
  // 通道**在这里定死**,装出去的 `send` 只管怎么发 —— 见 {@link HostHookGrantNotifyPort}。
  notifyPort.send({
    channel: IPC.HOST_HOOK_GRANTS_CHANGED,
    pluginId,
    reason,
    ...(grantId !== undefined ? { grantId } : {}),
  });
}

/**
 * 可注入的持久化接口 —— 本模块不实现落盘,只认这个窄接口(与 ARC-004 的 `GrantStorePersist`
 * 同姿势,不 import electron / sql)。生产在装配点接 `hostHookGrantFile.ts` 的落盘版;未接时
 * 为 `undefined`(纯内存,重启即空,与从前一致)。
 */
export interface HostHookGrantPersist {
  /** 载入已存的授权(无则 null)。 */
  load(): HostHookGrant[] | null;
  /** 落盘全量授权。 */
  save(grants: HostHookGrant[]): void;
  /** **存档健康度**(MC-029)—— 让持有核区分「本来空」与「读不懂」,损坏时拒绝写入保全原字节。
   *  可选:自定义持久化(测试桩)不实现时按 `absent` 处理。 */
  health?(): "absent" | "valid" | "corrupt";
}

let persist: HostHookGrantPersist | undefined;
/** 当前存档是否读不懂(MC-029)—— 为真则**拒绝写入**,保住原字节(见 `commit`)。 */
let archiveCorrupt = false;

/**
 * 从已载入的授权里**续上 id 序号** —— id 形如 `hhg-<n>`,取最大 n 作为 `seq` 起点,于是重启后
 * 新签发的 id 不会与已有授权撞号(撞号 = 新授权静默覆盖旧的同 id 记录,是一类难查的坏)。
 */
function seqOfLoaded(loaded: readonly HostHookGrant[]): number {
  let max = 0;
  for (const g of loaded) {
    const m = /^hhg-(\d+)$/.exec(g.grantId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * **唯一的持久提交点**(MC-017)—— 先 `save` 候选全量,成功后才发布成活动表。
 *
 * `save` 抛错时 `grants` 一字未动:内存与磁盘同版本。从前三个 mutation(签发 / 记账 /
 * 撤销)都是「先改内存、后 `flush`」,`save` 抛错就留下「内存说改了、磁盘说没改」的分裂态
 * —— 同一进程按内存放行、重启后磁盘旧态又回来。与 `GrantStore.commit` 同一条纪律。
 */
function commit(next: Map<string, HostHookGrant>): void {
  if (archiveCorrupt) {
    throw new Error(
      "host-hook-grants.json 内容读不懂 —— 拒绝写入以免覆盖原存档(原字节已保留;请修复或删除该文件后重启)。",
    );
  }
  persist?.save([...next.values()]);
  grants = next;
}

/** 存档此刻是否处于「读不懂、已拒绝写入」状态(供诊断 / 测试)。 */
export function isHostHookGrantArchiveCorrupt(): boolean {
  return archiveCorrupt;
}

/**
 * **装配持久化**(唯一入口)—— 接上可注入的 load/save,并**立即载入**已存授权。
 * 传 `undefined` 复位回内存版。载入是 fail-safe 的:文件不存在 / 坏数据 → `load()` 给
 * `null` / 空 → 空表(**仍默认拒绝**,绝不把读不懂的当成「全部允许」)。
 *
 * ⚠️ 与 `resetHostHookGrants` 的区别:本函数**载入**磁盘上那份;reset 只清内存。
 */
export function configureHostHookGrantPersist(next: HostHookGrantPersist | undefined): void {
  persist = next;
  // 载入前先问健康度(MC-029):损坏的存档读成空表**要记住**,否则下一次签发 / 撤销会拿
  // "空表"当基准整表回写,把原坏文件抹掉。测试桩没实现 health 时按 absent(不阻塞)。
  archiveCorrupt = next?.health?.() === "corrupt";
  const loaded = next?.load() ?? null;
  grants = new Map();
  seq = 0;
  if (loaded) {
    for (const g of loaded) grants.set(g.grantId, g);
    seq = seqOfLoaded(loaded);
  }
}

/** 测试 / 装配用:清空全部授权,回到「默认拒绝」。**不动**已接的持久化配置(reset 只清内存)。 */
export function resetHostHookGrants(): void {
  grants = new Map();
  seq = 0;
  // 复位也清掉损坏标记:测试里「配置一份坏存档 → 复位 → 配置一份好存档」不该被前一次的标记
  // 永久卡住写入(`configureHostHookGrantPersist` 每次都会重新判定,但显式清一下更不容易踩)。
  archiveCorrupt = false;
}

/** 当前全部授权(只读快照;诊断 / 断言用)。 */
export function listHostHookGrants(): HostHookGrant[] {
  return [...grants.values()];
}

/**
 * 一条授权的**幂等键** —— 由来源身份(`插件 + 版本 + 命令摘要 + matcher 摘要`)与它覆盖的
 * 事件集合派生。**同一来源签两次 → 同一个键**(见 {@link issueHostHookGrant})。
 *
 * 为什么要它:「用户授权这条 hook」是一个**可以点两次**的动作(双击、先签后重签、
 * 面板重挂后再点一下)。若每点一次就多一份有效授权,表里会攒下一串覆盖同一来源的
 * 重复条目 —— 撤销时只撤到你点的那一份、其余仍在,于是"我明明撤了它怎么还跑"。
 * 幂等键把这个来源的**当前有效授权**收成一条。
 *
 * 事件集合**排序去重**后入键:声明顺序不同、但覆盖同一组事件的两份授权,语义上是同一份。
 */
function grantIdempotencyKey(input: {
  pluginId: string;
  version: string | undefined;
  events: readonly string[];
  commandDigest: string;
  matcherDigest: string;
}): string {
  const events = [...new Set(input.events)].sort().join(",");
  return [input.pluginId, input.version ?? "", events, input.commandDigest, input.matcherDigest].join("\u0000");
}

/**
 * **签发**一份授权。**只有宿主经用户授信时调它** —— 插件自己不能给自己发(本函数不暴露给
 * 插件 manifest 的任何入口)。`ttlMs` 必须为正(与 ARC-004 的 `issueGrant` 同一条纪律)。
 *
 * **持久幂等**:来源身份与事件集合相同、且**当前仍有效、预算未用尽**的授权已存在时,**复用
 * 那一份**(返回它、不新建、不续期)。于是"点两次授权"不会在表里留下两条覆盖同一来源的有效
 * 授权 —— 撤一次就真的撤干净(见 {@link grantIdempotencyKey})。已撤销 / 已过期 / **已用尽
 * 执行预算**的那份**不算数**:重新授权是**一份新的有效授权**(账从 `usedRuns = 0` 起),不是
 * 把旧的复活。⚠️ 「已用尽的不复用」是必须的一条:否则用户在预算用尽后点的那一下会**复用到
 * 那份已用尽的授权**上,于是「重新授权」永远救不回来 —— 表现是按钮点了、hook 还是不跑。
 *
 * `maxRuns` 省略 = **不限次数**(旧调用方 / 测试的语义不变);声明了就是「这批最多跑几次」,
 * 由 `recordHostHookRun` 逐次记账,用尽即 `exhausted`(见 `decideHostHookExecution`)。
 */
export function issueHostHookGrant(input: {
  pluginId: string;
  version?: string;
  events?: string[];
  commandDigest?: string;
  matcherDigest?: string;
  maxRuns?: number;
  ttlMs: number;
  now: number;
}): HostHookGrant {
  if (!(input.ttlMs > 0)) {
    throw new Error("主机 hook 授权必须有正的有效期(ttlMs > 0)。");
  }
  if (input.maxRuns !== undefined && (!Number.isInteger(input.maxRuns) || input.maxRuns < 0)) {
    throw new Error("主机 hook 授权的执行次数上限必须是非负整数(maxRuns >= 0)。");
  }
  const commandDigest = input.commandDigest ?? "";
  const matcherDigest = input.matcherDigest ?? "";
  const key = grantIdempotencyKey({
    pluginId: input.pluginId,
    version: input.version,
    events: input.events ?? [],
    commandDigest,
    matcherDigest,
  });
  // 已有**有效且预算未用尽**的同来源授权 → 复用它(幂等):不新建第二条覆盖同一来源的活授权。
  // ⚠️ 已用尽的**不复用**(否则"重新授权"救不回那份 maxRuns 用完的授权,见函数头)。
  for (const g of grants.values()) {
    if (!isHostHookGrantActive(g, input.now)) continue;
    if (countBudgetExhausted(g.maxRuns, g.usedRuns)) continue;
    const same = grantIdempotencyKey({
      pluginId: g.pluginId,
      version: g.version,
      events: g.events,
      commandDigest: g.commandDigest,
      matcherDigest: g.matcherDigest ?? "",
    });
    if (same === key) return g;
  }
  seq += 1;
  const grant: HostHookGrant = {
    grantId: `hhg-${seq}`,
    pluginId: input.pluginId,
    version: input.version,
    events: [...(input.events ?? [])],
    commandDigest,
    matcherDigest,
    issuedAt: input.now,
    expiresAt: input.now + input.ttlMs,
    revoked: false,
    // 只在声明了上限时才带 `usedRuns`(没有上限的授权不必记一个恒增的死字段 —— 与
    // `Grant.recordUse` 只对 `maxBudget` 累加同一条纪律)。
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns, usedRuns: 0 } : {}),
  };
  const next = new Map(grants);
  next.set(grant.grantId, grant);
  commit(next);
  // 【MC-061 残余】新授权 → 推面板那一块刷新(只在实际**新建**时推:上面复用分支直接 return,
  // 没走到这里 —— 复用没有改变面板该显示的东西)。见 {@link notifyGrantsChanged}。
  notifyGrantsChanged(grant.pluginId, "issue", grant.grantId);
  return grant;
}

/**
 * **记一次真执行**,并回答「这次能不能起进程」。一条插件 hook 在授权下**真的起了进程**之前
 * 调它:找到该来源那份(仍在用、未用尽)的授权,`usedRuns` +1。契约是「批了几次就只能是几次」
 * 在主机 hook 授权上的落点:没有这个口,`maxRuns` 就是**只声明不兑现**的死字段(每次判定都读到
 * 0,可以无限次执行 —— 与 ARC-004 的 `Grant.recordUse` 要堵的是同一个洞,判据也共用
 * `countBudgetExhausted`)。
 *
 * ## 返回值 = 这份来源此刻还有可用授权吗(调用方据此决定起不起进程)
 *
 *  - 找到**覆盖该来源、仍有效、未用尽**的授权 → `true`。其中:
 *    - 它声明了 `maxRuns` → `usedRuns` +1(真记账,下次判定据此判 `exhausted`);
 *    - 它**没有** `maxRuns`(**不限次数**)→ 不记账(那是恒增的死字段),但照样 `true`
 *      —— 「不限」的意思是**永远可用**,不是"没有余额"。
 *  - 找不到→ `false`(该来源已被撤权 / 过期 / 预算用尽)。这不是错误:调用方真正起进程前
 *    会**复验**授权,这一步是那道复验在**记账时刻**的继续 —— 少记一笔只会让预算更保守,
 *    绝不反向放宽。调用方按 `false` **不起进程**、并记一条带原因的 skipped。
 *
 * ## 匹配判据只有一份
 *
 * 只对**覆盖该来源**的那一份记(走**唯一一份** `hostHookGrantCovers` —— 与判定同一把尺子,
 * 免得"判定按 A 放行、记账记到 B 上")。有多份覆盖且都有余额时,记在**判定会选中的那一份**
 * (与 `decideHostHookExecution` 相同的"第一份有效且未用尽"顺序)。
 *
 * 记账失败**绝不抛**:它是旁路,坏了不该冒到事件流(见 `HookRunner` 不变量 1)。
 */
export function recordHostHookRun(source: HostHookSource, now: number): boolean {
  for (const g of grants.values()) {
    if (!isHostHookGrantActive(g, now)) continue;
    if (!hostHookGrantCovers(g, source)) continue;
    if (countBudgetExhausted(g.maxRuns, g.usedRuns)) continue; // 这一份用尽了,再看下一份
    // 声明了上限才记账;不限次数的授权不必记一个恒增的死字段(见 `HostHookGrant.usedRuns`)。
    if (g.maxRuns !== undefined) {
      // 先落盘、成功后才发布内存(MC-017):落盘失败时计数不动 —— 不会「内存 +1、磁盘 0」。
      const bumped: HostHookGrant = { ...g, usedRuns: (g.usedRuns ?? 0) + 1 };
      const next = new Map(grants);
      next.set(g.grantId, bumped);
      commit(next);
      // 【MC-061 残余】**这一笔把这批授权的余额用光了** → 推面板把那一条翻成「已用尽」。
      // 只在**刚好用尽**的这一笔记(下一条事件仍会读到 `exhausted`,但那不是"变了"——面板早
      // 已刷过;重复推只是噪音)。见 {@link notifyGrantsChanged}。
      if (countBudgetExhausted(g.maxRuns, bumped.usedRuns)) {
        notifyGrantsChanged(g.pluginId, "exhausted", g.grantId);
      }
    }
    return true;
  }
  return false;
}

/** 撤销一份授权(幂等)。返回 true 表示这次真的从"有效"翻成"已撤销"。 */
export function revokeHostHookGrant(grantId: string): boolean {
  const g = grants.get(grantId);
  if (!g || g.revoked) return false;
  // 先落盘、成功后才改内存(MC-017):落盘失败时它**仍是活的** —— 与磁盘一致,重启不会
  // 「撤销又回来」。
  const next = new Map(grants);
  next.set(grantId, { ...g, revoked: true });
  commit(next);
  // 【MC-061 残余】撤销 → 推面板把那一条翻成「已撤销」。幂等分支(本来就撤了)不推 —— 没变。
  notifyGrantsChanged(g.pluginId, "revoke", grantId);
  return true;
}

/**
 * **按插件撤掉它全部授权** —— 插件卸载 / 重载时调。返回撤掉了几份有效授权。
 * 台账「卸载后 hook 同步撤销」就落在这**一句调用**上(不是需要各入口自己记得)。
 */
export function revokeHostHookGrants(pluginId: string): number {
  const next = new Map(grants);
  let n = 0;
  for (const g of grants.values()) {
    if (g.pluginId === pluginId && !g.revoked) {
      next.set(g.grantId, { ...g, revoked: true });
      n += 1;
    }
  }
  if (n > 0) {
    commit(next);
    // 【MC-061 残余】按插件整撤(停用 / 卸载)→ 推面板整个插件那一块重读(一次整撤多份,不逐份推)。
    // 没撤到任何一份时不推 —— 没变。
    notifyGrantsChanged(pluginId, "revoke-all");
  }
  return n;
}

/**
 * **判定这条插件 hook 此刻准不准跑** —— 存储侧的入口,把当前全部授权喂给契约的纯判定。
 * 判据全在 `@contracts/hostHookGrant.decideHostHookExecution`,这里只是"取当前表"。
 */
export function decidePluginHookExecution(
  source: HostHookSource,
  mappedEvent: string | null,
  now: number,
): HostHookDecision {
  return decideHostHookExecution(source, mappedEvent, [...grants.values()], now);
}

/** 现在有没有**任何**有效授权(面板据此决定要不要把「已授信」那档显示出来)。 */
export function hasAnyActiveHostHookGrant(now: number): boolean {
  for (const g of grants.values()) if (isHostHookGrantActive(g, now)) return true;
  return false;
}
