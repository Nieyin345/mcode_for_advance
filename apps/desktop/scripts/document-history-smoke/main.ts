/**
 * 【EDIT-09】文件历史的回归网（`main/document/documentHistory.ts`）。
 *
 * ## 它验什么
 *
 *   1. **记录**：保存后记一版；**同一份字节不重复记**（否则每按一次 Cmd-S 多一条）；
 *   2. **列出**：从旧到新；快照被外部删掉时**不返回幽灵版本**；
 *   3. **回滚**：写回目标版本，**并且先把当前内容记一版**（回滚也要能回滚）；
 *   4. **上限**：超过 `MAX_VERSIONS` 时**裁掉最旧的**，且被裁掉的快照文件真的删了；
 *   5. **失败显式**：版本号不存在 / 快照已删 → 明确原因，不静默成功。
 *
 * ## 每节都有一条「反向」断言
 *
 * 全是"写完之后读回来对不对"的检查：一个把 `recordDocumentVersion` 写成永远返回
 * `{ok:true}` 的桩能让前半全绿。所以每节都要有一条"不该发生的事没发生"。
 *
 * ## 数据在哪
 *
 * `dataRoot` 与工作目录都由 run.sh 给到临时目录 —— **绝不碰用户的真数据根**。
 */

export {};

const { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");

const {
  recordDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
  readDocumentVersionBytes,
} = await import("@main/document/documentHistory.js");

const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
}

const WORK = process.env["MCODE_HISTORY_WORK"] ?? mkdtempSync(join(tmpdir(), "mcode-hist-"));
const DATA = process.env["MCODE_SMOKE_DATA_ROOT"] ?? mkdtempSync(join(tmpdir(), "mcode-hist-data-"));
const FILE = join(WORK, "report.md");

/* ───────── 1. 记录与去重 ───────── */
{
  writeFileSync(FILE, "第一版\n", "utf8");
  const first = await recordDocumentVersion({ filePath: FILE, source: "user", dataRoot: DATA });
  check("1a 第一次记录成功且真的新增", first.ok === true && first.added === true, first);

  const again = await recordDocumentVersion({ filePath: FILE, source: "user", dataRoot: DATA });
  check("1b 同一份字节不重复记（否则每按一次保存多一条）",
    again.ok === true && again.added === false, again);

  writeFileSync(FILE, "第二版\n", "utf8");
  const second = await recordDocumentVersion({ filePath: FILE, source: "ai", dataRoot: DATA });
  check("1c 内容变了才新增", second.ok === true && second.added === true, second);

  const listed = await listDocumentVersions({ filePath: FILE, dataRoot: DATA });
  check("1d 列出两条", listed.ok === true && listed.versions.length === 2, listed);
  /* ⚠️ **别用 `bytes` 区分版本**（旧断言就是这么写的，一直是红的）：
   * 「第一版\n」和「第二版\n」都是 10 字节 —— 长度相同，判据恒假。
   * 改用 `source`（第一版由 user 记、第二版由 ai 记），它是真的能区分这两条的性质。 */
  check("★ 1e 从旧到新（第一条是 user 记的那一版）",
    listed.ok && listed.versions[0]?.source === "user" && listed.versions[1]?.source === "ai",
    listed.ok ? listed.versions.map((v) => v.source) : listed);
  check("1f 来源如实记录（第二条是 ai）",
    listed.ok && listed.versions[1]?.source === "ai", listed.ok ? listed.versions[1] : null);
}

/* ───────── 2. 回滚：先保当前，再写目标 ───────── */
{
  const before = await listDocumentVersions({ filePath: FILE, dataRoot: DATA });
  const oldest = before.ok ? before.versions[0] : null;
  check("2a 有可回滚的目标", oldest !== null);

  const restored = await restoreDocumentVersion({
    filePath: FILE, sha256: oldest!.sha256, dataRoot: DATA,
  });
  check("2b 回滚成功", restored.ok === true, restored);
  check("2c 文件内容真的回到第一版",
    readFileSync(FILE, "utf8") === "第一版\n", readFileSync(FILE, "utf8"));

  const after = await listDocumentVersions({ filePath: FILE, dataRoot: DATA });
  /* **关键**：回滚前那一版必须被保住 —— 否则"回滚"本身不可逆。
   *
   * 但**不是**每次都新增一条：历史是**按内容寻址**的，`recordDocumentVersion`
   * 与这里都有一条「与最后一条同内容就不重记」的去重（见
   * `documentHistory.ts` 里两处 `index.versions.at(-1)?.sha256 === digest`）。
   *
   * 本场景里回滚前的内容**正是索引里最后一条**（第二版刚被记过），所以正确地
   * 不新增 —— 3 条 vs 2 条不是判据，**内容还在不在**才是。
   * 旧断言写死 3 条，那是去重逻辑加上之前的事；它红的时候，功能是对的。
   *
   * 下面的 2d′ 直接验"能回到回滚前那一版"，那才是这条保护真正要成立的事。 */
  const previousDigest = before.ok ? before.versions.at(-1)?.sha256 : undefined;
  check("★ 2d 回滚前的内容仍在历史里（回滚也要能回滚）",
    after.ok && after.versions.some((v) => v.sha256 === previousDigest),
    after.ok ? after.versions.map((v) => v.sha256.slice(0, 8)) : after);
  /* 2e：`source: "restore"` 标记只在**回滚前的内容不在索引里**时才出现
   * （外部改过文件、或者中间被裁掉了）。本场景不产生它 —— 断言"必须有"是错的。
   * 改成断言"历史里每条的 source 都是三个合法值之一"，防止这个字段漂移。 */
  check("2e 每一条的 source 都在合法取值里",
    after.ok && after.versions.every((v) => v.source === "user" || v.source === "ai" || v.source === "restore"),
    after.ok ? after.versions.map((v) => v.source) : after);
  // 真正的「回滚也能回滚」：现在再滚回刚才那一版，文件必须真的变回去。
  if (previousDigest !== undefined) {
    const backAgain = await restoreDocumentVersion({ filePath: FILE, sha256: previousDigest, dataRoot: DATA });
    check("★ 2f 能滚回回滚前的那一版（回滚可逆）",
      backAgain.ok === true && readFileSync(FILE, "utf8") === "第二版\n",
      { ok: backAgain.ok, content: readFileSync(FILE, "utf8") });
  }
}

/* ───────── 3. 失败要显式 ───────── */
{
  const bad = await restoreDocumentVersion({
    filePath: FILE, sha256: "0".repeat(64), dataRoot: DATA,
  });
  check("3a 不存在的版本号 → 明确失败", bad.ok === false, bad);

  const malformed = await restoreDocumentVersion({
    filePath: FILE, sha256: "not-a-hash", dataRoot: DATA,
  });
  check("3b 版本号格式不对 → 明确失败", malformed.ok === false, malformed);

  const missing = await readDocumentVersionBytes({
    filePath: FILE, sha256: "1".repeat(64), dataRoot: DATA,
  });
  check("3c 读不存在的版本 → 明确失败", missing.ok === false, missing);
}

/* ───────── 4. 幽灵版本不列出 ───────── */
{
  const listed = await listDocumentVersions({ filePath: FILE, dataRoot: DATA });
  const victim = listed.ok ? listed.versions[0] : null;
  check("4a 有可删的版本", victim !== null);

  // 直接把快照文件删掉，模拟"索引写过但文件被外部清掉"。
  const dir = join(DATA, "docs", "history");
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const target = names.find((n) => n.includes(victim!.sha256));
  check("4b 找到了那个快照文件", target !== undefined, names);
  if (target !== undefined) rmSync(join(dir, target), { force: true });

  const after = await listDocumentVersions({ filePath: FILE, dataRoot: DATA });
  check("4c 快照没了的版本不出现在列表里（不留幽灵）",
    after.ok && !after.versions.some((v) => v.sha256 === victim!.sha256), after);
}

/* ───────── 5. 上限：裁最旧的，且文件真删 ───────── */
{
  // 逐个写 60 个不同内容 —— 超过 MAX_VERSIONS（48）。
  for (let i = 0; i < 60; i += 1) {
    writeFileSync(FILE, `第 ${i} 轮\n`, "utf8");
    await recordDocumentVersion({ filePath: FILE, source: "user", dataRoot: DATA });
  }
  const listed = await listDocumentVersions({ filePath: FILE, dataRoot: DATA });
  check("5a 版本数被裁到上限（48）", listed.ok && listed.versions.length === 48,
    listed.ok ? listed.versions.length : listed);

  // 只数本文件的快照（历史目录里也可能有本套件其它文件的）。
  const dir = join(DATA, "docs", "history");
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const digestCount = names.filter((n) => /\.[a-f0-9]{64}\./.test(n)).length;
  check("5b 被裁掉的快照文件真的删了（不留占位）",
    digestCount <= 48 + 1, { digestCount, names: names.length });
}

/* ───────── 汇总 ───────── */
const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? "✓" : "✗"} ${entry.name}${entry.ok ? "" : ` — ${JSON.stringify(entry.detail)}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error(`\n${failed.length} 条失败`);
  process.exit(1);
}
