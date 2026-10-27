/**
 * 【Office 深度集成】后台文档视图的**休眠策略** —— 纯决策层，不碰 Electron。
 *
 * ## 为什么需要它
 *
 * O18 的实测基线：六个 GenOffice 编辑器同时驻留时，Electron 进程组工作集约
 * **1.70 GiB**，其中绝大部分是各自的 renderer（Sheets 253 MiB、Docs 187 MiB、
 * Slides 183 MiB、Markdown 136 MiB、HTML 127 MiB、PDF 115 MiB）。
 *
 * 而 `DocumentViewHost.hide()` 只把视图**挪到屏幕外**（`parkOffscreen`）：
 * Chromium 仍把整页留在内存里、仍在跑定时器与 Univer/ProseMirror 的 JS 堆。
 * 用户切了五个标签之后，前面四个编辑器全在后台满编驻留。
 *
 * ## 为什么不能简单"隐藏就销毁"
 *
 * O18 卡里写得很清楚：**不能未经保存状态/恢复协议就强制释放后台渲染器，
 * 尤其不能对有未保存数据的文档这样做。** 销毁一个脏视图 = 静默丢掉用户没保存的编辑。
 *
 * 所以策略按**能否无损恢复**分档，而不是按"空闲多久"一刀切：
 *
 * | 视图状态 | 能不能回收 | 理由 |
 * |---|---|---|
 * | 干净 + 已隐藏 + 超过宽限期 | ✅ 可回收 | 重新打开只需重读盘上原文件，内容不变 |
 * | 脏（有未保存编辑） | ❌ 永不回收 | 销毁 = 丢数据；只做后台节流 |
 * | 可见 | ❌ 永不回收 | 正在被看 |
 * | 从未成功打开过文件（只在起始页） | ✅ 可回收 | 没有文档状态可丢 |
 *
 * ## 三条独立的保护（任何一条成立就不回收）
 *
 *  1. **宽限期**：刚隐藏的视图可能马上被切回来（用户在两个标签间来回看），
 *     立刻销毁会让每次切换都重新加载 300–1300 ms（O18 的首帧耗时）。
 *  2. **脏**：见上。
 *  3. **回收上限**：一次最多回收 N 个，避免用户切走一整排标签时同时触发
 *     N 次大内存释放造成尖峰（Chromium 释放大堆本身有开销）。
 *
 * ## 它不做什么
 *
 * - **不决定怎么释放**：调用方拿到的是一组 docId，具体"何时销毁 / 如何重建"
 *   仍由 `DocumentViewHost` 负责（它拥有会话表与几何事实）。
 * - **不记住"哪些文档值钱"**：没有 ML/启发式。只有上面三条可解释的判据。
 */
export interface DormancyCandidate {
  docId: string;
  /** 视图当前是否可见。可见的一定不回收。 */
  visible: boolean;
  /** 页面自报的未保存状态；`undefined` = 还没报过（按**保守**处理，见下）。 */
  dirty: boolean | undefined;
  /** 隐藏时刻（`Date.now()`）；`null` = 从不曾隐藏（即一直可见）。 */
  hiddenAt: number | null;
  /** 这份视图是否真的打开过文件（有 `openedFilePath`）。 */
  hasDocument: boolean;
}

export interface DormancyPolicy {
  /** 隐藏后多久才允许回收（毫秒）。 */
  graceMs: number;
  /** 一次最多回收几个。 */
  maxPerSweep: number;
}

/**
 * 默认值来自 O18 的实测数量级，不是拍的：
 *
 * - `graceMs = 90_000`：O18 记录切回已隐藏 Sheets 是一次真实用户动作，往返在
 *   秒级；两分钟足以覆盖"在两个标签间来回对照"的场景，又能在用户真正切走后
 *   回收掉后面那些。设成 10 秒会让对照场景每次都重新加载（300–1300 ms）。
 * - `maxPerSweep = 2`：单个 Sheets 释放约 250 MiB，两个一批已经是可见的尖峰；
 *   分多批回收能让主线程在两批之间喘一口气。
 */
export const DEFAULT_DORMANCY_POLICY: DormancyPolicy = Object.freeze({
  graceMs: 90_000,
  maxPerSweep: 2,
});

/**
 * 挑出本轮可以回收的 docId。
 *
 * **`dirty === undefined` 按脏处理**（不回收）：这是仓库里反复出现的一条判据 ——
 * 「没报过」不等于「干净」。把它当成干净会销毁一份可能改了没保存的文档。
 * 想回收，先让它报一次干净（vendor 的 `reportCloseCheck` 在打开成功后就会报）。
 */
export function selectDormantViews(
  candidates: readonly DormancyCandidate[],
  now: number,
  policy: DormancyPolicy = DEFAULT_DORMANCY_POLICY,
): string[] {
  const eligible = candidates
    .filter((candidate) => {
      if (candidate.visible) return false;
      // 脏或未报告 —— 都不回收（见函数注释）。
      if (candidate.dirty !== false) return false;
      if (candidate.hiddenAt === null) return false;
      // 从未打开过文件：回收它没有收益（起始页本身就小），却会让"点开一个标签
      // 结果要重新加载编辑器"发生在一个本该瞬时的地方。只回收真带文档的视图。
      if (!candidate.hasDocument) return false;
      return now - candidate.hiddenAt >= policy.graceMs;
    })
    // 最久隐藏的先回收：用户最不可能切回去的就是它。
    .sort((a, b) => (a.hiddenAt ?? 0) - (b.hiddenAt ?? 0))
    .slice(0, Math.max(0, policy.maxPerSweep))
    .map((candidate) => candidate.docId);
  return eligible;
}

/**
 * 一个视图被回收后，重新打开它需要什么 —— 这份清单是「无损」的定义。
 *
 * 调用方（`DocumentViewHost`）在销毁前必须把这些全部留下；任何一项丢了，
 * 恢复出来的就不是同一份文档状态。
 */
export interface DormantSnapshot {
  docId: string;
  /** 视图身份（`genoffice-app://<kind>/index.html` 或 file:// 页）。 */
  url: string;
  /** 原厂编辑器种类。
   *
   *  ⚠️ 与契约 `DocViewOpenInput.editor` **逐字一致**（没有 `"docs"`）：docs 页走的是
   *  普通文档视图那一条（`menu:command("open-path")`），它没有独立的 `editor` 值。
   *  `null` = 普通文档视图。 */
  editor: "pdf" | "markdown" | "html" | "sheets" | "slides" | null;
  /** 打开的文件路径（回收前的权威路径）。 */
  filePath: string | null;
  /** 最后一次已知几何 —— 重建时要摆回同一个位置，否则会闪一下。 */
  bounds: { x: number; y: number; width: number; height: number };
  /** 绑定到哪个 Mcode 会话（AI 工具链要用）。 */
  mcodeSessionId: string | null;
  /** 回收时刻，仅用于诊断与"沉淀顺序"。 */
  dormantAt: number;
  /** 隐藏时刻（隐藏了多久的诊断来源）。 */
  hiddenAt: number | null;
}

/** 快照是否足以无损恢复。任何一项不成立都不该销毁视图。 */
export function snapshotCanRestore(snapshot: DormantSnapshot): boolean {
  if (snapshot.filePath === null) return false;
  if (snapshot.editor !== null) {
    // 原厂视图只认固定的 scheme 身份；换一个 URL 就等于换了一个编辑器。
    return snapshot.url.startsWith("genoffice-app://");
  }
  return snapshot.url.length > 0;
}
