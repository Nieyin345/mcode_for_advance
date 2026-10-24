/**
 * 【T125】不可还原的产物：`restorable` 状态。
 *
 * ## 这一套钉的六件事
 *
 * 1. 非 UTF-8 的普通文件（docx / GBK 文本）**出现在 `turn.files` 里**，
 *    带 `restorable: false`、`before: ""`、`adds/dels: 0`；
 * 2. **★ 撤销之后那个文件一个字节都没变** —— 这条是本卡的数据安全判据。
 *    变异「`restoreFiles` 忽略 `restorable === false`」必须让它红，
 *    而且红的原因必须是「文件被清成 0 字节」，不是别的；
 * 3. `restoreFiles` 把这类路径报进**独立的 `unrestorable`**，不是 `conflicts`
 *    （那个通道的用户文案是「之后又改过」——对这些文件是假话）；
 * 4. **旧数据兼容**：一条没有 `restorable` 字段的条目按「可还原」处理；
 * 5. **目录换文件（EISDIR）不进卡片** —— `file-snapshot-smoke` 的 FULL-1 守的那条，
 *    本卡不能把它改死；
 * 6. 正常的 UTF-8 文件 `restorable` 缺省（`undefined`），rewind 行为零变化。
 *
 * ## 用的是真身
 *
 * `FileSnapshot` / `restoreFiles` 全部 import 生产实现，套件里不重写判据。
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSnapshot, restoreFiles } from "../../src/main/lib/fileSnapshot.js";
import { initDb } from "../../src/main/store/db.js";
import { SessionRepo, ProjectRepo } from "../../src/main/store/repositories.js";
import { settleTurn } from "../../src/main/tasks/autoCreate.js";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const WS = mkdtempSync(join(tmpdir(), "t125-"));
process.on("exit", () => {
  try {
    rmSync(WS, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** 非 UTF-8 的字节：PK 头 + 无效 UTF-8 序列（真 docx 走的是同一条解码失败路径）。 */
const DOCX_BEFORE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80, 0x81]);
const DOCX_AFTER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x09, 0x09, 0x09, 0x91, 0x92, 0x93]);

/** 造一条 `chat` 会话（`settleTurn` 只对用户面对的对话建任务）。 */
function makeChatSession(): string {
  const now = Date.now();
  const projectId = `proj_${Math.random().toString(36).slice(2, 10)}`;
  ProjectRepo.create({
    id: projectId,
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    path: `D:/tmp/${Math.random().toString(36).slice(2, 8)}`,
    archived: false,
    createdAt: now,
    updatedAt: now,
  } as never);
  const id = `sess_${Math.random().toString(36).slice(2, 10)}`;
  // 字段形状照 `task-message-auto-create-smoke` 的 fixture（SESSION_COLUMNS 驱动，
  // 少一个 NOT NULL 字段写库就失败）。本套只关心 kind / title。
  SessionRepo.create({
    id,
    projectId,
    title: "t125 会话",
    kind: "chat",
    status: "idle",
    providerId: "claude",
    model: "claude-sonnet-5-5",
    effort: "default",
    permissionMode: "default",
    workflowId: null,
    customModelId: null,
    claudeSessionId: null,
    parentSessionId: null,
    nodeId: null,
    agentProfile: null,
    archived: false,
    pinnedAt: null,
    envMode: "local",
    wtStyle: null,
    worktreePath: null,
    todos: null,
    contextSnapshot: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    createdAt: now,
    updatedAt: now,
  } as never);
  return id;
}

console.log("\n① ★ 非 UTF-8 文件出现在 turn.files 里，标成 restorable:false");
let docxPath = "";
let docxEntry: Awaited<ReturnType<FileSnapshot["freeze"]>>[number] | undefined;
{
  docxPath = join(WS, "report.docx");
  writeFileSync(docxPath, DOCX_BEFORE);
  const snap = new FileSnapshot();
  await snap.recordPre(WS, docxPath);
  writeFileSync(docxPath, DOCX_AFTER); // 模拟工具改了它
  const frozen = await snap.freeze();
  docxEntry = frozen.find((f) => f.filePath === docxPath);
  check("★ 出现在 turn.files 里", docxEntry !== undefined, frozen.map((f) => f.filePath));
  check("★ restorable === false", docxEntry?.restorable === false, docxEntry);
  check("★ before 是空串（没有伪造原文）", docxEntry?.before === "", docxEntry?.before);
  check("★ adds/dels 都是 0（没读到就不能编数字）", docxEntry?.adds === 0 && docxEntry?.dels === 0, docxEntry);
  check("kind 是 modified", docxEntry?.kind === "modified", docxEntry?.kind);
}

console.log("\n② ★★ 数据安全：撤销之后那个 docx 一个字节都没变");
{
  // 这是整张卡最重要的一条。变异「忽略 restorable === false」会让它红，
  // 而红的样子必须是「文件被清成 0 字节」。
  const beforeBytes = readFileSync(docxPath);
  const report = await restoreFiles(WS, [docxEntry!]);
  const afterBytes = readFileSync(docxPath);
  check(
    "★★ 撤销后文件内容逐字节不变（没被清空、没被改写）",
    Buffer.compare(beforeBytes, afterBytes) === 0,
    { beforeLen: beforeBytes.length, afterLen: afterBytes.length },
  );
  check(
    "★★ 文件长度没有变成 0（这是「before 空串被写回」的症状）",
    afterBytes.length > 0,
    { len: afterBytes.length },
  );
  check("★ 它被报进 unrestorable", report.unrestorable.length === 1 && report.unrestorable[0] === docxPath, report);
  check("★ 它不在 restored 里（没做任何还原动作）", !report.restored.includes(docxPath), report.restored);
  check("★★ 它不在 conflicts 里（那个通道的文案是「之后又改过」，对它是假话）", !report.conflicts.includes(docxPath), report.conflicts);
  check("★ 它不在 failed 里（不是「还原失败」，是「本就不该还原」）", !report.failed.includes(docxPath), report.failed);
}

console.log("\n③ GBK 文本同样进得去 —— 范围是「读不到 before」，不是「二进制」");
{
  const gbkPath = join(WS, "notes.txt");
  writeFileSync(gbkPath, Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // "中文" 的 GBK
  const snap = new FileSnapshot();
  await snap.recordPre(WS, gbkPath);
  writeFileSync(gbkPath, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2]));
  const frozen = await snap.freeze();
  const entry = frozen.find((f) => f.filePath === gbkPath);
  check("★ GBK .txt 也出现在 turn.files 里", entry !== undefined, frozen.map((f) => f.filePath));
  check("★ 它也标成 restorable:false", entry?.restorable === false, entry);
}

console.log("\n④ 旧数据兼容：没有 restorable 字段的条目按「可还原」处理");
{
  const legacyPath = join(WS, "legacy.txt");
  writeFileSync(legacyPath, "改之前\n");
  // 手工构造一条**没有 restorable** 的条目 —— 模拟本次改动之前落盘的历史会话。
  const legacyEntry = {
    filePath: legacyPath,
    kind: "modified" as const,
    adds: 1,
    dels: 1,
    before: "改之前\n",
    afterHash: undefined,
  };
  const report = await restoreFiles(WS, [legacyEntry as never]);
  check("★ 旧条目没有被当成不可还原", report.unrestorable.length === 0, report.unrestorable);
  // afterHash 缺失 → 走遗留快照分支，拒绝自动还原 —— 那是 MC-002 的既有行为，不变。
  check("★ 旧条目仍按 MC-002 的遗留快照规则处理", report.conflicts.length === 1, report);

  // 再验一次关键区分：带 afterHash 的旧条目应当能真的还原。
  const legacy2 = join(WS, "legacy2.txt");
  writeFileSync(legacy2, "原文\n");
  const snap2 = new FileSnapshot();
  await snap2.recordPre(WS, legacy2);
  writeFileSync(legacy2, "改后\n");
  const frozen2 = await snap2.freeze();
  const e2 = frozen2.find((f) => f.filePath === legacy2)!;
  check("正常文本的 restorable 是 undefined（缺省）", e2.restorable === undefined, e2.restorable);
  const r2 = await restoreFiles(WS, [e2]);
  check("★ 正常文本仍能被还原", r2.restored.includes(legacy2), r2);
  check("★ 还原后内容回到原文", readFileSync(legacy2, "utf8") === "原文\n", readFileSync(legacy2, "utf8"));
}

console.log("\n⑤ 目录换文件（EISDIR）不进卡片 —— FULL-1 那条不能改死");
{
  const dirPath = join(WS, "was-a-dir");
  mkdirSync(dirPath);
  const snap = new FileSnapshot();
  await snap.recordPre(WS, dirPath); // EISDIR → 我们不知道 turn 前它是什么
  rmSync(dirPath, { recursive: true });
  writeFileSync(dirPath, "现在是文件");
  const frozen = await snap.freeze();
  check(
    "★ EISDIR 的路径不出现在 turn.files 里（不知道原状就不编造）",
    frozen.every((f) => f.filePath !== dirPath),
    frozen.map((f) => f.filePath),
  );
}

console.log("\n⑥ 正常文件的行为零变化");
{
  const ok = join(WS, "ok.txt");
  writeFileSync(ok, "a\nb\n");
  const snap = new FileSnapshot();
  await snap.recordPre(WS, ok);
  writeFileSync(ok, "a\nB\nc\n");
  const frozen = await snap.freeze();
  const e = frozen.find((f) => f.filePath === ok);
  check("restorable 缺省", e?.restorable === undefined, e?.restorable);
  check("kind modified", e?.kind === "modified", e?.kind);
  check("adds 是精确计数", e?.adds === 2, e?.adds);
  check("dels 是精确计数", e?.dels === 1, e?.dels);
}

console.log("\n⑦ ★ 读不出的产物仍然算「这一轮产出了东西」（走真身 settleTurn）");
{
  // 【T125】`adds`/`dels` 对这类条目是 0，而 0 不等于「没改」。若 `artifactsOf`
  // 继续按 `adds - dels > 0` 过滤，`apply_ops` 改过的 docx 会被静默排除在任务之外
  // —— 那正是这张卡要修的那个洞。
  //
  // 这条**必须走真身 `settleTurn`**：它是唯一能观测 `artifactsOf` 的公开入口。
  // 在套件里复刻一遍 artifactsOf 的判据 = 验副本（这个仓库栽过）。
  const docxForTask = join(WS, "task-report.docx");
  writeFileSync(docxForTask, DOCX_BEFORE);
  const snap = new FileSnapshot();
  await snap.recordPre(WS, docxForTask);
  writeFileSync(docxForTask, DOCX_AFTER);
  const frozen = await snap.freeze();
  const entry = frozen.find((f) => f.filePath === docxForTask)!;
  check("（前提）它是 restorable:false 且 adds=dels=0", entry.restorable === false && entry.adds === 0 && entry.dels === 0, entry);

  await initDb();
  const sessionId = makeChatSession();
  const created = settleTurn({ sessionId, files: [entry], reason: "end_turn" });
  check("★★ 它被算成产物：真的建出了任务", created.created === true, created);
  check("★ 任务状态是 done（不是 accepted —— 执行完成 ≠ 验收通过）", created.status === "done", created);

  // 对照：同一套 fixture、同一个会话，**空文件列表**仍然不建任务。
  // 没有这一条，上面那条在「反正什么都建」的实现里也会绿。
  const empty = settleTurn({ sessionId, files: [], reason: "end_turn" });
  check("★ 对照组：空文件列表仍然不建任务", empty.created === false, empty);
}

console.log(`\nt125-restorable-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
