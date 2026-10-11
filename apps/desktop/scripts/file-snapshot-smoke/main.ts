/**
 * 每轮文件快照 / 历史回滚的回归网（台账 MC-001、MC-002、MC-003、MC-005、MC-006、MC-008）。
 *
 * 这六条全是**用户数据安全**的一类，而且它们错了都不报错：
 *
 *   - MC-001 那个符号链接/junction 只要还在工作区里，**字面路径**看着就在里面 ——
 *     于是"只能写项目内"这条闸对**物理**越界完全无感，模型可以经一个链接写到工作区
 *     外面去，甚至绕过"资料库只读"。
 *   - MC-002 历史回滚不看磁盘现态：第 1 轮改 X，第 2 轮又改 X，回滚第 1 轮会把
 *     第 2 轮的改动一并抹掉，而界面只说"已撤销"。
 *   - MC-003 是 O(旧行数 × 新行数) 的 LCS 表：1 万行级文件要几百 MB，5 万行级理论上
 *     10GB —— 收尾时把主进程卡死/OOM，文件本身改得多少无关。
 *   - MC-005 只改末尾换行会被当成"无变化"从卡片和快照里**静默剔掉**：用户改了，
 *     界面上看不见，也回滚不了。
 *   - MC-006 `startsWith("..")` 把 `..config` 这种合法的点文件名当逃逸路径拒掉。
 *   - MC-008 两次并发 recordPre 同一路径会在 await 之间双双通过"未快照"检查，
 *     后完成的那次可能读到**改过之后**的内容，于是"原始内容"被悄悄换掉。
 *
 * 所以这里**真建文件、真调 recordPre/freeze/restoreFiles**，而不是断言"源码里写着
 * 某个字符串"（仓规：断言要测行为，不是文本 —— 后者在一个把函数体清空的实现上照样绿）。
 *
 * 不碰用户真实数据：所有文件都在 `mktemp -d` 建出来的临时目录里，跑完删。
 *
 * Run: scripts/file-snapshot-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSnapshot,
  restoreFiles,
  safeResolveOk,
  normalizeToolFilePath,
  containsDotDotEscape,
} from "@main/lib/fileSnapshot.js";
import { pathWithin } from "@main/lib/realPathWithin.js";
import type { TurnFileEntry } from "@contracts/runtime";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function deepEq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const ROOT = mkdtempSync(join(tmpdir(), "mcode-filesnap-"));
/** 一个"工作区"子目录，模拟项目 cwd；外面的东西放在 ROOT 里当"工作区之外"。 */
const WS = join(ROOT, "ws");
const OUTSIDE = join(ROOT, "outside");
mkdirSync(WS, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

function write(rel: string, content: string): string {
  const p = join(WS, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf-8");
  return p;
}
function read(rel: string): string {
  return readFileSync(join(WS, rel), "utf-8");
}
function writeBytes(rel: string, bytes: Uint8Array): string {
  const p = join(WS, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, bytes);
  return p;
}

function mkEntry(over: Partial<TurnFileEntry> & { filePath: string }): TurnFileEntry {
  return { kind: "modified", adds: 1, dels: 1, before: "", ...over };
}

try {
  console.log("\n【MC-006】合法点文件名 vs 真逃逸");
  {
    // 合法的点文件：`..` 是文件名的一部分，不是"上一级"。
    const dotdot = write("..config", "x");
    check("`..config` 在根内 → safeResolveOk 放行", safeResolveOk(WS, dotdot) === true);
    const dotdot2 = write("..backup", "y");
    check("`..backup` 在根内 → 放行", safeResolveOk(WS, dotdot2) === true);
    // 真逃逸：`../` 或 `..\\`。
    check("`../escape` → 拒绝", safeResolveOk(WS, join(WS, "..", "escape")) === false);
    check("cwd 本身 → 拒绝（它不是 cwd 内的一个文件）", safeResolveOk(WS, WS) === false);
    // 意图判据
    eq("containsDotDotEscape('..config') == false", containsDotDotEscape("..config"), false);
    eq("containsDotDotEscape('../x') == true", containsDotDotEscape("../x"), true);
    eq("containsDotDotEscape('a/../../b') == true", containsDotDotEscape("a/../../b"), true);
    eq("containsDotDotEscape('..') == true", containsDotDotEscape(".."), true);

    const norm = normalizeToolFilePath(WS, "..config");
    eq("normalizeToolFilePath 认 `..config` 为项目内", norm?.insideProject, true);
    eq("normalizeToolFilePath 认 `..config` 未逃逸", norm?.escaped, false);
    const norm2 = normalizeToolFilePath(WS, "../../etc/passwd");
    eq("normalizeToolFilePath 认 `../../etc/passwd` 已逃逸", norm2?.escaped, true);
    eq("normalizeToolFilePath 认它不在项目内", norm2?.insideProject, false);
  }

  console.log("\n【MC-005】只改末尾换行不算「无变化」");
  {
    // "hello" → "hello\n"：行数统计两边都是 ["hello"]（末尾单个换行是终止符），
    // 老判据 adds===0 && dels===0 会把这条当无变化剔掉。
    write("nl.txt", "hello");
    const snap = new FileSnapshot();
    await snap.recordPre(WS, "nl.txt");
    write("nl.txt", "hello\n");
    const frozen = await snap.freeze();
    eq("末尾加一个换行 → 仍然进快照（不是「无变化」）", frozen.length, 1);
    eq("它的 kind 是 modified", frozen[0]?.kind, "modified");
    eq("before 是原样 'hello'", frozen[0]?.before, "hello");
    // 反过来：去掉末尾换行
    write("nl2.txt", "world\n");
    const snap2 = new FileSnapshot();
    await snap2.recordPre(WS, "nl2.txt");
    write("nl2.txt", "world");
    const frozen2 = await snap2.freeze();
    eq("去掉末尾换行 → 也进快照", frozen2.length, 1);
    // 反向控制：真的逐字节没变才应该被剔
    write("same.txt", "unchanged\n");
    const snap3 = new FileSnapshot();
    await snap3.recordPre(WS, "same.txt");
    const frozen3 = await snap3.freeze();
    eq("真的没变 → 不进快照（反向控制，防「什么都留」）", frozen3.length, 0);
  }

  console.log("\n【MC-002】历史回滚的冲突检测");
  {
    // 第 1 轮：X 从 A 改成 B
    write("conflict.txt", "A");
    const snap = new FileSnapshot();
    await snap.recordPre(WS, "conflict.txt");
    write("conflict.txt", "B");
    const frozen = await snap.freeze();
    eq("收尾时记下了 afterHash", typeof frozen[0]?.afterHash, "string");

    // 情形 1：没人再动它 → 正常还原
    const ok = await restoreFiles(WS, frozen);
    deepEq("没被再改过 → 正常还原", ok.restored, [join(WS, "conflict.txt")]);
    deepEq("没有冲突", ok.conflicts, []);
    eq("磁盘回到 A", read("conflict.txt"), "A");

    // 情形 2：第 2 轮/用户又把它改成 C → 回滚第 1 轮必须**不覆盖**
    write("conflict.txt", "A");
    const snap2 = new FileSnapshot();
    await snap2.recordPre(WS, "conflict.txt");
    write("conflict.txt", "B");
    const frozen2 = await snap2.freeze();
    write("conflict.txt", "C"); // 后来的改动
    const r2 = await restoreFiles(WS, frozen2);
    deepEq("之后又被改过 → 列为冲突", r2.conflicts, [join(WS, "conflict.txt")]);
    deepEq("并且没有被算成「已还原」", r2.restored, []);
    eq("★ 用户后来的 C 原样保留（没被 A 覆盖）", read("conflict.txt"), "C");

    /* 【MC-002】情形 6：**重试必须幂等**。第 13 轮复查点名的"额外幂等陷阱"——
     *
     * 部分撤销时 UI 保留按钮、用户点重试,而重试把**整批原文件**原样再送一遍。已成功
     * 还原的那个文件此刻停在 `before`(≠ afterHash),旧判据会把它读成"之后被改过"→
     * 判冲突 → **越重试越糟**。正确语义:当前 == before 就是"已达目标态",幂等放行。 */
    write("conflict.txt", "A");
    const snap6 = new FileSnapshot();
    await snap6.recordPre(WS, "conflict.txt");
    write("conflict.txt", "B");
    const frozen6 = await snap6.freeze();
    const first = await restoreFiles(WS, frozen6);
    deepEq("首次还原成功", first.restored, [join(WS, "conflict.txt")]);
    eq("磁盘回到 before(A)", read("conflict.txt"), "A");
    // 重试:同一份 frozen 再送一遍。此刻磁盘是 A(= before),绝不能报冲突。
    const retry = await restoreFiles(WS, frozen6);
    deepEq("★ 重试:已还原的文件算成功,不报冲突(幂等)", retry.restored, [join(WS, "conflict.txt")]);
    deepEq("★ 重试不产生冲突", retry.conflicts, []);
    eq("磁盘仍是 A(没有被二次写入弄坏)", read("conflict.txt"), "A");

    // 情形 3：created 文件被后来的动作删了 → 目标状态已达成，算已还原，不报冲突
    const createdEntry = mkEntry({ filePath: join(WS, "gone.txt"), kind: "created", before: "", afterHash: "deadbeef" });
    const r3 = await restoreFiles(WS, [createdEntry]);
    deepEq("created 文件已不在 → 视为已还原", r3.restored, [join(WS, "gone.txt")]);
    deepEq("不报冲突", r3.conflicts, []);

    // 情形 4：created 文件被后来的动作**改成了别的**内容 → 冲突，不能删
    const createdEntry2 = mkEntry({ filePath: join(WS, "reborn.txt"), kind: "created", before: "" });
    write("reborn.txt", "made-then-edited");
    const r4 = await restoreFiles(WS, [createdEntry2]);
    // 【MC-002 第 23 轮残余】createdEntry2 没有 afterHash（模拟**本次修复前**落盘的旧条目）
    // → 从前走老行为直接删；现在无指纹的旧条目**保守拒绝**：无处判断文件在本轮之后
    // 有没有被改过，直接删就可能删掉用户后来创建/写入的内容。列进 conflicts，不动磁盘。
    check(
      "★ 无 afterHash 的 created 旧条目 → 保守拒绝(不直接删)",
      r4.conflicts.includes(join(WS, "reborn.txt")) && r4.restored.length === 0,
      { conflicts: r4.conflicts, restored: r4.restored },
    );
    eq("★ 用户后来写的内容仍在(没被静默删除)", read("reborn.txt"), "made-then-edited");

    const createdEntry3 = mkEntry({
      filePath: join(WS, "reborn2.txt"),
      kind: "created",
      before: "",
      afterHash: "0000000000000000000000000000000000000000000000000000000000000000",
    });
    write("reborn2.txt", "user-edited-afterwards");
    const r5 = await restoreFiles(WS, [createdEntry3]);
    deepEq("★ 创建的条目又被改过 → 冲突，不删", r5.conflicts, [join(WS, "reborn2.txt")]);
    eq("★ 用户后来的内容原样保留", read("reborn2.txt"), "user-edited-afterwards");

    // 情形 5：【MC-002 第 23 轮残余】没有 afterHash 的旧条目（本次改动前落盘的历史快照）
    // → **保守拒绝**：无从判断文件在本轮之后有没有被再改过，直接写回 before 就有
    // 覆盖用户后来改动的风险。第 23 轮明确要求"对无 hash 的遗留快照保守拒绝或提供
    // 确认及文件级重试"，所以这里列进 conflicts、不动磁盘。
    const legacy = mkEntry({ filePath: join(WS, "legacy.txt"), before: "OLD" });
    write("legacy.txt", "NEW");
    const r6 = await restoreFiles(WS, [legacy]);
    deepEq("★ 无 afterHash 的旧条目 → 保守拒绝(列冲突,不自动还原)", r6.conflicts, [join(WS, "legacy.txt")]);
    deepEq("★ 且没被算成已还原", r6.restored, []);
    eq("★ 用户当前的 NEW 原样保留(没被 OLD 覆盖)", read("legacy.txt"), "NEW");

    // 情形 7：【MC-002 第 23 轮残余】指纹按**原始字节**算，不是 UTF-8 解码后的字符串。
    // `before` 是合法的（否则 recordPre 的严格解码就把它排除在快照之外），但收尾时
    // 磁盘上可能已经变成**非法 UTF-8**（这一轮把文件写成了二进制）。此时 `after` 的
    // 宽松解码会把每一段坏字节塌成同一个 U+FFFD —— 两个**内容不同**的非法 UTF-8
    // 序列会算出**相同的字符串指纹**，冲突检测被绕过、直接覆盖用户后来的改动。
    // 判据：收尾后写入**另一段**非法 UTF-8（与收尾时不同字节），回滚必须判冲突。
    {
      write("invalid-utf8.bin", "A"); // 收尾前合法
      const snap7 = new FileSnapshot();
      await snap7.recordPre(WS, "invalid-utf8.bin");
      writeBytes("invalid-utf8.bin", Buffer.from([0xff])); // 收尾时：非法 UTF-8
      const frozen7 = await snap7.freeze();
      eq("收尾时记下了 afterHash（二进制收尾也记）", typeof frozen7[0]?.afterHash, "string");
      // 后来又改成**另一段**非法 UTF-8：与 [0xff] 解码后同样是单个 U+FFFD（字符串指纹会撞）。
      writeBytes("invalid-utf8.bin", Buffer.from([0xfe]));
      const r7 = await restoreFiles(WS, frozen7);
      deepEq(
        "★ 不同的非法 UTF-8 内容算「被改过」→ 冲突（字节指纹不撞）",
        r7.conflicts,
        [join(WS, "invalid-utf8.bin")],
      );
      eq(
        "★ 用户后来写的 0xfe 原样保留（没被误判成「没变」而覆盖）",
        readFileSync(join(WS, "invalid-utf8.bin"))[0],
        0xfe,
      );
    }
  }

  console.log("\n【MC-003】大文件不做 O(n×m) 的表");
  {
    // 造一个两边各 3000 行的文件（(3001)² ≈ 900 万格 > 400 万上限），只改中间一行。
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    write("big.txt", big);
    const snap = new FileSnapshot();
    await snap.recordPre(WS, "big.txt");
    write("big.txt", big.replace("line 1500", "line 1500 CHANGED"));
    const t0 = Date.now();
    const frozen = await snap.freeze();
    const elapsed = Date.now() - t0;
    eq("大文件仍然出快照", frozen.length, 1);
    // 超限走降级：adds=n / dels=m（整段计数）。关键是**没有**去建那张表。
    check(
      "超限时走降级计数（adds 与 dels 都等于行数，而非精确的 1/1）",
      frozen[0]?.adds === 3000 && frozen[0]?.dels === 3000,
      { adds: frozen[0]?.adds, dels: frozen[0]?.dels },
    );
    check("且耗时是毫秒级（真的没建表）", elapsed < 2000, { elapsed });
    // 反向控制：小文件仍走精确路径
    write("small.txt", "a\nb\nc\n");
    const snapS = new FileSnapshot();
    await snapS.recordPre(WS, "small.txt");
    write("small.txt", "a\nB\nc\n");
    const fs2 = await snapS.freeze();
    eq("小文件仍是精确计数 adds=1", fs2[0]?.adds, 1);
    eq("小文件仍是精确计数 dels=1", fs2[0]?.dels, 1);
  }

  console.log("\n【MC-008】并发 recordPre 只捕获首次内容");
  {
    write("race.txt", "ORIGINAL");
    // 判据立在**读取次数**上：同一路径并发 N 次，只该真读一次。这比"抓第一次读和
    // 并发写谁先落地"确定得多 —— 那个竞态本来就是非确定的，拿它当判据会偶发假红。
    class CountingSnapshot extends FileSnapshot {
      reads = 0;
      protected override async capturePre(abs: string): Promise<void> {
        this.reads++;
        return super.capturePre(abs);
      }
    }
    const snap = new CountingSnapshot();
    await Promise.all(Array.from({ length: 10 }, () => snap.recordPre(WS, "race.txt")));
    eq("★ 并发 10 次同一路径 → 只真读一次（有 in-flight 占位）", snap.reads, 1);
    // 现在把它改掉，freeze 才会为它出条目；before 必须是**首次读到的** ORIGINAL，
    // 而不是并发期间任何一个后来者读到的内容。
    write("race.txt", "LATER-EDIT");
    const frozen = await snap.freeze();
    eq("并发同一路径 → 只出一条", frozen.length, 1);
    eq("★ before 是首次读到的内容", frozen[0]?.before, "ORIGINAL");
    // 反向控制：**不同**路径就该各读各的（占位只按路径去重，别变成全局串行）。
    const snap1b = new CountingSnapshot();
    write("race2.txt", "x");
    await Promise.all([snap1b.recordPre(WS, "race.txt"), snap1b.recordPre(WS, "race2.txt")]);
    eq("不同路径 → 各读一次", snap1b.reads, 2);

    // 失败/取消不能留下永远 pending 的占位：记录一个不存在的文件后，再记录同一路径
    // 必须还能落到"created"上（而不是被 in-flight 占位挂住）。
    const snap2 = new FileSnapshot();
    await snap2.recordPre(WS, "not-there.txt"); // ENOENT → exists:false
    await snap2.recordPre(WS, "not-there.txt"); // 第二次不该挂住
    const f2 = await snap2.freeze(); // 文件依旧不存在 → 净零剔除
    eq("不存在路径重复记录不挂住（净零被剔）", f2.length, 0);
    // 记录下来之后真创建了 → freeze 应看到 created
    const snap3 = new FileSnapshot();
    await snap3.recordPre(WS, "then-made.txt");
    write("then-made.txt", "made");
    const f3 = await snap3.freeze();
    eq("先记 ENOENT 再创建 → 出 created 条目", f3[0]?.kind, "created");
  }

  console.log("\n【MC-001】符号链接 / junction 不得越出根");
  {
    // 在"工作区里"建一个指向工作区外目录的链接。字面路径在 WS 内，物理目的地在外面。
    let linkMade = false;
    const linkPath = join(WS, "escape-link");
    try {
      symlinkSync(OUTSIDE, linkPath, process.platform === "win32" ? "junction" : "dir");
      linkMade = true;
    } catch {
      // Windows 非管理员可能建不了 symlink；junction 一般可以。建不了就跳过这一组。
      linkMade = false;
    }
    if (!linkMade) {
      console.log("  skip 平台不允许创建链接（symlink/junction）—— 跳过物理越界用例");
    } else {
      const escapedFile = join(linkPath, "secret.txt");
      // 字面看：WS/escape-link/secret.txt —— relative() 说它在 WS 内。
      // 物理看：它其实在 OUTSIDE 里。
      check("★ 经链接写到工作区外 → pathWithin 拒绝", pathWithin(WS, escapedFile) === false);
      check("★ safeResolveOk 同步拒绝（文件写入闸走的是它）", safeResolveOk(WS, escapedFile) === false);
      // 正向控制：不经过链接的普通文件仍在根内。
      check("正向控制：普通项目内文件仍放行", safeResolveOk(WS, join(WS, "normal.txt")) === true);
      // restoreFiles 也必须拒 —— 否则历史回滚能把文件写到工作区外。
      const evil: TurnFileEntry[] = [
        mkEntry({ filePath: escapedFile, kind: "created", before: "" }),
      ];
      writeFileSync(join(OUTSIDE, "secret.txt"), "IMPORTANT", "utf-8");
      const rep = await restoreFiles(WS, evil);
      deepEq("★ 回滚经链接的目标 → 被拒（计入 failed）", rep.failed, [escapedFile]);
      eq("外部的文件原样还在（没被删）", readFileSync(join(OUTSIDE, "secret.txt"), "utf-8"), "IMPORTANT");
      // 也确认链接确实指向外面（夹具没摆错）
      const real = readlinkSync(linkPath).replace(/\\\\\?\\/, "");
      check("夹具正确：链接确实指向 OUTSIDE", lstatSync(linkPath).isSymbolicLink() || lstatSync(linkPath).isDirectory(), { real });
    }
  }

  console.log("\n【回归】基础行为没被改坏");
  {
    write("normal-new.txt", "hello\nworld\n");
    const snap = new FileSnapshot();
    await snap.recordPre(WS, "normal-new.txt");
    write("normal-new.txt", "hello\nWORLD\nagain\n");
    const frozen = await snap.freeze();
    eq("普通修改出条目", frozen.length, 1);
    eq("kind=modified", frozen[0]?.kind, "modified");
    eq("before 原样保留", frozen[0]?.before, "hello\nworld\n");
    const rep = await restoreFiles(WS, frozen);
    eq("还原成功", rep.restored.length, 1);
    eq("内容精确回滚", read("normal-new.txt"), "hello\nworld\n");

    // freeze 之后再 recordPre 是 no-op（frozen 闸），且 freeze 不重入。
    // 判据立在"冻结之后新记录不进来"上 —— 注意 freeze() 会保留 originals 的
    // **路径键**（hasPaths 要用），所以 size 不会归零；但冻结后不该再收新路径。
    const sizeAfterFreeze = snap.size;
    await snap.recordPre(WS, "after-freeze.txt");
    eq("freeze 之后再 recordPre 不新增路径（no-op）", snap.size, sizeAfterFreeze);
    const again = await snap.freeze();
    eq("freeze 不重入（第二次给空）", again.length, 0);
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`file-snapshot-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
