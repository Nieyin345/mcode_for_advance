/**
 * 台账 MC-068 §33 的**真实函数故障注入**回归套 —— 直接打生产的
 * `apps/desktop/src/main/lib/moveFileSafe.ts`,用真实的 Windows 临时目录文件系统,
 * 只对特定的 `fs.promises` 调用注入一次 `EPERM` / `EXDEV`(见 `stub-fs.ts`,经
 * `run.sh` 的 `--alias:node:fs=...` 换桩)。
 *
 * ## 为什么单独一套
 *
 * 复审(§33.2 / §33.3)用两组**真实生产故障注入**证明上一版 `moveFileSafe` 仍有缺口:
 *
 *  - **反例 A**:`link`/`copyFile` **成功之后**删源失败,却报
 *    `committed:false / sourcePreserved:true / destinationPreserved:true / recoverable:false`
 *    —— 文件系统里目标**已经真的出现**,操作有可见副作用,却被报成「未提交且无需恢复」。
 *  - **反例 B**:覆盖失败后的回滚 `rename(backup, destination)` 在 win32 上对已存在普通
 *    文件是**替换语义**,把并发期间第三方刚写到 destination 的新内容**无声覆盖**,
 *    却仍报 `destinationPreserved:true`。
 *
 * 这两条都是**时序**问题,`agent_move_file` 那套端点 smoke 的 happy-path 绿例覆盖不到;
 * 所以这里直接驱动真实函数、真实注入,判据立在**真文件的字节**与**返回的结构化字段**上。
 *
 * ## 注入必须真的生效(防"空过"的假绿)
 *
 * 每条注过入的用例,跑完都断言这次调用期间命中次数 > 0 —— 否则是"夹具没命中却全绿"的假证据。
 * `fs` 走本套的**桩**(`./stub-fs.js`,同时经 `run.sh` 的 `--alias:node:fs=...` 换给生产代码),
 * 两处解析到**同一个绝对路径**、esbuild 只打一份 —— 不能写成裸 `node:fs`,那会得到两份模块
 * 实例、注入写进另一份、断言永远看不到命中。
 *
 * Run: scripts/move-file-safe-smoke/run.sh
 */
import * as fs from "./stub-fs.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { moveFileSafe, isMoveDurable } from "@main/lib/moveFileSafe.js";

let checks = 0;
let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    passed++;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { expected, got: actual });
}

const MV = fs.mkdtempSync(path.join(tmpdir(), "mcode-move-fault-"));
const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const kindOf = (p: string): "file" | "dir" | "missing" =>
  fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? "dir" : "file") : "missing";
const bakEntries = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.includes("mcode-move-bak"));
const tmpEntries = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.includes("mcode-move-tmp"));

/** 每个用例独占一个子目录,免相互污染。 */
let seq = 0;
function sandbox(): string {
  const d = path.join(MV, `c${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ═══════════ 反例 A:link / copyFile 成功后删源失败 → 部分完成(不是"未提交")═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "source-a.txt");
  const dst = path.join(d, "dest-a.txt");
  fs.writeFileSync(src, "DATA-ORIGINAL");
  const h0 = fs.hits();
  fs.armFault("rm", "source-a.txt", { code: "EPERM" }); // link 成功后的删源这一步失败
  const r = await moveFileSafe(src, dst, { overwrite: false });
  const hitOk = fs.hits() > h0;
  fs.clearFault();

  check("反例A 注入确实生效(link 成功后 rm 抛了一次 EPERM)", hitOk, { hits: fs.hits() - h0 });
  check(
    "反例A 文件系统事实:硬链接已建,source 与 destination 都在、内容都为 DATA-ORIGINAL",
    read(src) === "DATA-ORIGINAL" && read(dst) === "DATA-ORIGINAL",
    { src: read(src), dst: read(dst) },
  );
  eq("反例A phase 如实报部分完成(PARTIALLY_APPLIED)", r.phase, "PARTIALLY_APPLIED");
  eq("反例A reason=PARTIALLY_APPLIED", r.reason, "PARTIALLY_APPLIED");
  check("反例A committed=true(目标确实有内容)", r.committed === true, r);
  check("反例A sourcePreserved=true(源还在)", r.sourcePreserved === true, r);
  check("反例A recoverable=true(需人工确认后删源)", r.recoverable === true, r);
  check("反例A commitOutcome=APPLIED_NOT_DURABLE(有副作用,但不得报成功)", r.commitOutcome === "APPLIED_NOT_DURABLE", r);
  check("反例A 不是 DURABLE —— 不得当成完全成功", isMoveDurable(r) === false, r);
  check("反例A 提示里说清「源仍在、别重跑」", r.message.includes("源仍在") && r.message.includes("不要重跑"), r.message);
}

/* ═══════════ 反例 A-跨卷:EXDEV 后 copyFile 成功、删源失败 → 同样部分完成 ═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "source-x.txt");
  const dst = path.join(d, "dest-x.txt");
  fs.writeFileSync(src, "CROSS-VOL");
  const h0 = fs.hits();
  fs.armFault("link", "source-x.txt", { code: "EXDEV" }); // 迫使走跨卷 COPYFILE_EXCL 分支
  fs.armFault("rm", "source-x.txt", { code: "EPERM" }); // 拷贝成功后删源失败
  const r = await moveFileSafe(src, dst, { overwrite: false });
  const hitOk = fs.hits() - h0 >= 2;
  fs.clearFault();

  check("反例A-跨卷 两条注入都命中(EXDEV + EPERM)", hitOk, { hits: fs.hits() - h0 });
  check(
    "反例A-跨卷 文件系统事实:destination 有整份内容、source 仍在",
    read(dst) === "CROSS-VOL" && read(src) === "CROSS-VOL",
    { src: read(src), dst: read(dst) },
  );
  eq("反例A-跨卷 phase=PARTIALLY_APPLIED", r.phase, "PARTIALLY_APPLIED");
  check("反例A-跨卷 committed=true / sourcePreserved=true / recoverable=true", r.committed && r.sourcePreserved && r.recoverable, r);
  eq("反例A-跨卷 commitOutcome=APPLIED_NOT_DURABLE", r.commitOutcome, "APPLIED_NOT_DURABLE");
}

/* ═══════════ 反例 B:覆盖失败回滚时,第三方已占位 → 绝不覆盖其内容 ═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "source-b.txt");
  const dst = path.join(d, "dest-b.txt");
  fs.writeFileSync(src, "SOURCE-NEW");
  fs.writeFileSync(dst, "OLD-ORIGINAL");
  const h0 = fs.hits();
  // 源提交的 rename(source→destination) 抛 EPERM;抛之前模拟"另一个写入者"把 THIRD-PARTY 写到空出的 destination。
  fs.armFault("rename", "source-b.txt", {
    code: "EPERM",
    before: () => fs.writeFileSync(dst, "THIRD-PARTY-NEW"),
  });
  const r = await moveFileSafe(src, dst, { overwrite: true });
  const hitOk = fs.hits() > h0;
  fs.clearFault();

  check("反例B 注入确实生效(源提交 rename 抛了一次 EPERM)", hitOk, { hits: fs.hits() - h0 });
  check(
    "反例B 第三方新内容被完整保留(没被备份恢复无声覆盖)",
    read(dst) === "THIRD-PARTY-NEW",
    { dst: read(dst) },
  );
  check("反例B 源未改动(SOURCE-NEW 仍在)", read(src) === "SOURCE-NEW", { src: read(src) });
  eq("反例B phase=UNCERTAIN(槽位所有权无法证明)", r.phase, "UNCERTAIN");
  check("反例B recoverable=true 且给出 backupRef", r.recoverable === true && typeof r.backupRef === "string", r);
  check("反例B 备份仍在且内容是旧目标 OLD-ORIGINAL", r.backupRef ? read(r.backupRef) === "OLD-ORIGINAL" : false, {
    backup: r.backupRef ? read(r.backupRef) : null,
    bak: bakEntries(d),
  });
  eq("反例B commitOutcome=FAILED(没有可对外宣布的持久成果)", r.commitOutcome, "FAILED");
}

/* ═══════════ 覆盖失败且回滚成功(无第三方占位):恢复旧目标,不算丢 ═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "source-r.txt");
  const dst = path.join(d, "dest-r.txt");
  fs.writeFileSync(src, "SRC");
  fs.writeFileSync(dst, "OLD");
  const h0 = fs.hits();
  fs.armFault("rename", "source-r.txt", { code: "EPERM" }); // 源提交失败,槽位空着
  const r = await moveFileSafe(src, dst, { overwrite: true });
  const hitOk = fs.hits() > h0;
  fs.clearFault();

  check("回滚成功 注入生效", hitOk, { hits: fs.hits() - h0 });
  check("回滚成功 旧目标已按 no-clobber 安全恢复(内容 OLD)", read(dst) === "OLD", { dst: read(dst) });
  check("回滚成功 源未动 / 无备份残留", read(src) === "SRC" && bakEntries(d).length === 0, { src: read(src), bak: bakEntries(d) });
  eq("回滚成功 phase=PREPARED(原状)", r.phase, "PREPARED");
  check("回滚成功 committed=false / destinationPreserved=true", r.committed === false && r.destinationPreserved === true, r);
}

/* ═══════════ 覆盖失败 + 回滚也失败(link 注入):UNCERTAIN,备份与新内容都留 ═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "source-u.txt");
  const dst = path.join(d, "dest-u.txt");
  fs.writeFileSync(src, "SRC");
  fs.writeFileSync(dst, "OLD");
  const h0 = fs.hits();
  fs.armFault("rename", "source-u.txt", { code: "EPERM" }); // 源提交失败
  // 回滚用的 link(backup → destination) 也失败 → 槽位空、恢复不了 → UNCERTAIN。
  fs.armFault("link", "mcode-move-bak", { code: "EPERM" });
  const r = await moveFileSafe(src, dst, { overwrite: true });
  const hitOk = fs.hits() - h0 >= 2;
  fs.clearFault();

  check("回滚失败 两条注入都命中", hitOk, { hits: fs.hits() - h0 });
  eq("回滚失败 phase=UNCERTAIN", r.phase, "UNCERTAIN");
  eq("回滚失败 commitOutcome=FAILED", r.commitOutcome, "FAILED");
  check("回滚失败 备份保留、内容 OLD、给 backupRef", r.recoverable === true && !!r.backupRef && read(r.backupRef) === "OLD", {
    backupRef: r.backupRef,
    backupContent: r.backupRef ? read(r.backupRef) : null,
  });
  check("回滚失败 源仍在(未丢)", read(src) === "SRC", { src: read(src) });
  eq("回滚失败 destinationPreserved 如实为 false(此处确实空了)", r.destinationPreserved, false);
}

/* ═══════════ 跨卷复制失败(EXDEV 后 copyFile 也失败):源未动、目标未建 ═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "source-c.txt");
  const dst = path.join(d, "dest-c.txt");
  fs.writeFileSync(src, "KEEP");
  const h0 = fs.hits();
  fs.armFault("link", "source-c.txt", { code: "EXDEV" });
  fs.armFault("copyFile", "source-c.txt", { code: "EIO" });
  const r = await moveFileSafe(src, dst, { overwrite: false });
  const hitOk = fs.hits() > h0;
  fs.clearFault();

  check("跨卷复制失败 注入生效", hitOk, { hits: fs.hits() - h0 });
  eq("跨卷复制失败 phase=PREPARED(无净副作用)", r.phase, "PREPARED");
  check("跨卷复制失败 源未动、目标未建、无 tmp 残留", read(src) === "KEEP" && kindOf(dst) === "missing" && tmpEntries(d).length === 0, {
    src: read(src),
    dst: kindOf(dst),
    tmp: tmpEntries(d),
  });
  check("跨卷复制失败 committed=false / sourcePreserved=true", r.committed === false && r.sourcePreserved === true, r);
}

/* ═══════════ Windows 别名:junction 指向同一实体 → 拒绝;硬链接别名 → 明确按两条路径处理 ═══════════ */
if (process.platform === "win32") {
  // junction:realpath 跟得动,source 与 destination 解析到同一物理目录 → 必须拒绝,不能 rm 掉自己。
  const d = sandbox();
  const real = path.join(d, "real");
  fs.mkdirSync(path.join(real, "keep"), { recursive: true });
  fs.writeFileSync(path.join(real, "keep", "f.txt"), "INNER");
  const junc = path.join(d, "link");
  fs.symlinkSync(real, junc, "junction");
  const rj = await moveFileSafe(real, junc, { overwrite: true });
  check(
    "junction 别名:源与目标解析到同一实体 → 拒绝、内层文件完好",
    rj.reason === "SAME_SOURCE_DESTINATION" && read(path.join(real, "keep", "f.txt")) === "INNER",
    { r: rj, inner: read(path.join(real, "keep", "f.txt")) },
  );

  // 硬链接别名:两名字指向同一 inode。realpath **不**把硬链接归一(它是两个目录项),
  // 所以当前实现按「两条不同路径」处理。这里钉住**已定义的行为**:移动后目标处有本份内容、
  // 不丢字节(具体归属见台账 remaining ①,fileId 级同实体判定尚未接入)。
  const d2 = sandbox();
  const h1 = path.join(d2, "h1.txt");
  const h2 = path.join(d2, "h2.txt");
  fs.writeFileSync(h1, "HARD");
  fs.linkSync(h1, h2);
  const rh = await moveFileSafe(h1, h2, { overwrite: false });
  // overwrite=false、目标已存在 → 明确拒绝(而不是覆盖),硬链接两条都还在、内容一致。
  check(
    "硬链接别名(overwrite=false):拒绝而非覆盖,两名字内容都是 HARD",
    rh.reason === "DESTINATION_EXISTS" && read(h1) === "HARD" && read(h2) === "HARD",
    { r: rh, h1: read(h1), h2: read(h2) },
  );
}

/* ═══════════ 重启时遗留的旧备份(.mcode-move-bak-*)不干扰新操作,也不被误当目标 ═══════════ */
{
  const d = sandbox();
  // 模拟上一进程崩溃留下的备份残留(名字含随机后缀,与本次操作的唯一名不同)。
  const staleBak = path.join(d, "dest-stale.txt.mcode-move-bak-9999-deadbeef");
  fs.writeFileSync(staleBak, "STALE-ORPHAN");
  const src = path.join(d, "fresh.txt");
  const dst = path.join(d, "dest-stale.txt");
  fs.writeFileSync(src, "FRESH");
  const r = await moveFileSafe(src, dst, { overwrite: true });
  check(
    "遗留旧备份:新移动照常完成、遗留备份原样保留(未误删/未误当目标)",
    r.phase === "COMMITTED" && read(dst) === "FRESH" && read(staleBak) === "STALE-ORPHAN",
    { r, dst: read(dst), stale: read(staleBak) },
  );
}

/* ═══════════ 目录覆盖:备份后源提交失败、槽位空 → 目录也按 no-clobber 安全恢复 ═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "dir-src");
  const dst = path.join(d, "dir-dest");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "new.txt"), "NEWDIR");
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "old.txt"), "OLDDIR");
  const h0 = fs.hits();
  fs.armFault("rename", "dir-src", { code: "EPERM" }); // 源目录提交失败,槽位空着
  const r = await moveFileSafe(src, dst, { overwrite: true });
  const hitOk = fs.hits() > h0;
  fs.clearFault();

  check("目录覆盖回滚 注入生效", hitOk, { hits: fs.hits() - h0 });
  check(
    "目录覆盖回滚 旧目录按 no-clobber 恢复(old.txt 在、内容 OLDDIR)、源树完好、无备份残留",
    read(path.join(dst, "old.txt")) === "OLDDIR" &&
      read(path.join(src, "new.txt")) === "NEWDIR" &&
      bakEntries(d).length === 0,
    { dstOld: read(path.join(dst, "old.txt")), srcNew: read(path.join(src, "new.txt")), bak: bakEntries(d) },
  );
  eq("目录覆盖回滚 phase=PREPARED(原状)", r.phase, "PREPARED");
}

/* ═══════════ 相同资源多会话并发:两个 overwrite=true 同时搬向同一已存在目标 ═══════════ */
{
  const d = sandbox();
  const s1 = path.join(d, "s1.txt");
  const s2 = path.join(d, "s2.txt");
  const dst = path.join(d, "shared.txt");
  fs.writeFileSync(s1, "FROM-S1");
  fs.writeFileSync(s2, "FROM-S2");
  fs.writeFileSync(dst, "ORIGINAL");
  const [r1, r2] = await Promise.all([
    moveFileSafe(s1, dst, { overwrite: true }),
    moveFileSafe(s2, dst, { overwrite: true }),
  ]);
  const dstNow = read(dst);
  // 确定性不变量(与调度顺序无关):目标**必是某个源的内容**,绝不是原 ORIGINAL、也不是半截。
  // 两个写入者都显式要求覆盖同一目标,「最后写者胜」是定义内的语义;绝不能出现原目标未动却
  // 两个源都没了的"双删",也不能出现谁都没写成的半截。目标是文件(非目录)、可读。
  check(
    "并发同目标(overwrite=true):目标内容必是某个源(非原 ORIGINAL、非半截)、可读",
    (dstNow === "FROM-S1" || dstNow === "FROM-S2") && kindOf(dst) === "file",
    { dstNow, kind: kindOf(dst), r1: r1.phase, r2: r2.phase },
  );
  // 每个返回的 MoveResult 都必须自洽:committed 与 phase 不打架,且与「源是否还在」一致。
  for (const [i, r] of [r1, r2].entries()) {
    const srcPath = i === 0 ? s1 : s2;
    const srcStill = kindOf(srcPath) !== "missing";
    check(
      `并发同目标 返回自洽(#${i} phase=${r.phase}):phase 与源存在状态一致`,
      r.sourcePreserved === srcStill &&
        (r.phase === "COMMITTED" ? r.sourcePreserved === false : true),
      { phase: r.phase, committed: r.committed, sourcePreserved: r.sourcePreserved, srcStill },
    );
  }
}

/* ═══════════ 故障返回的 MoveResult 与实际文件字节一致(§33.4 验收项)═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "consist-src.txt");
  const dst = path.join(d, "consist-dst.txt");
  fs.writeFileSync(src, "CONSIST");
  // 注入:覆盖分支的源提交 rename 失败(槽位空),测「destinationPreserved=true ⇒ 目标真在且是旧内容」。
  fs.writeFileSync(dst, "OLDC");
  const h0 = fs.hits();
  fs.armFault("rename", "consist-src.txt", { code: "EPERM" });
  const r = await moveFileSafe(src, dst, { overwrite: true });
  fs.clearFault();
  check("一致性 注入生效", fs.hits() > h0, { hits: fs.hits() - h0 });
  const dstExists = kindOf(dst) !== "missing";
  const srcExists = kindOf(src) !== "missing";
  check(
    "MoveResult 与真实字节一致:sourcePreserved / destinationPreserved 都对应真文件存在与否",
    r.sourcePreserved === srcExists && r.destinationPreserved === dstExists,
    { sourcePreserved: r.sourcePreserved, srcExists, destinationPreserved: r.destinationPreserved, dstExists },
  );
}

/* ═══════════ 无故障基线:正常移动 / 覆盖 / no-clobber / 拓扑拒绝继续绿 ═══════════ */
{
  const d = sandbox();
  const src = path.join(d, "plain.txt");
  fs.writeFileSync(src, "PLAIN");
  const r = await moveFileSafe(src, path.join(d, "sub", "plain.txt"), { overwrite: false });
  check(
    "基线 正常移动:COMMITTED、源消失、目标内容一致、无残留",
    r.phase === "COMMITTED" && isMoveDurable(r) && read(path.join(d, "sub", "plain.txt")) === "PLAIN" && kindOf(src) === "missing" && bakEntries(d).length === 0,
    { r },
  );
}
{
  const d = sandbox();
  const src = path.join(d, "ov.txt");
  const dst = path.join(d, "ovd.txt");
  fs.writeFileSync(src, "NEW");
  fs.writeFileSync(dst, "OLD");
  const r = await moveFileSafe(src, dst, { overwrite: true });
  check(
    "基线 覆盖旧文件:COMMITTED、内容换新、源消失、无备份残留",
    r.phase === "COMMITTED" && read(dst) === "NEW" && kindOf(src) === "missing" && bakEntries(d).length === 0,
    { r, dst: read(dst), bak: bakEntries(d) },
  );
}
{
  const d = sandbox();
  const p = path.join(d, "same.txt");
  fs.writeFileSync(p, "逐字节不变");
  const before = read(p);
  const r = await moveFileSafe(p, p, { overwrite: true });
  check(
    "基线 自覆盖:COMMITTED / reason=SAME_SOURCE_DESTINATION / 内容逐字节不变",
    r.phase === "COMMITTED" && r.reason === "SAME_SOURCE_DESTINATION" && read(p) === before,
    { r },
  );
}
{
  const d = sandbox();
  const src = path.join(d, "tree");
  fs.mkdirSync(path.join(src, "nested"), { recursive: true });
  fs.writeFileSync(path.join(src, "nested", "dummy.txt"), "dummy");
  const r = await moveFileSafe(src, path.join(src, "nested"), { overwrite: true });
  check(
    "基线 目录移入自身子树:被拒、dummy 完好",
    r.reason === "DESTINATION_INSIDE_SOURCE" && read(path.join(src, "nested", "dummy.txt")) === "dummy",
    { r },
  );
}
{
  const d = sandbox();
  const keep = path.join(d, "keep.txt");
  const src = path.join(d, "src.txt");
  fs.writeFileSync(keep, "KEEP");
  fs.writeFileSync(src, "SRC");
  const r = await moveFileSafe(src, keep, { overwrite: false });
  check(
    "基线 overwrite=false 目标已存在:拒绝、两边都不动",
    r.reason === "DESTINATION_EXISTS" && read(keep) === "KEEP" && read(src) === "SRC",
    { r },
  );
}

fs.rmSync(MV, { recursive: true, force: true });

console.log(`\n${passed}/${checks} 通过`);
if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
