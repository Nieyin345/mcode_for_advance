/**
 * 人工记忆整理的纵向烟测：真实 store + 真实 IPC handler + 临时数据根。
 * 整理只产建议；删除须经界面选择、确认和内容指纹核对。绝不读写用户记忆。
 * Run: scripts/memory-review-smoke/run.ps1 (Windows) / run.sh (POSIX).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { IpcMain } from "electron";
import type { MemoryReviewEntry, MemoryReviewResult } from "@contracts/memory";
import { reviewSelectionConflict } from "@renderer/components/memory/reviewSelection.js";
import { notifications } from "./stubs/broadcast.js";

let total = 0;
let failed = 0;
function check(name: string, value: boolean, detail?: unknown): void {
  total++;
  if (value) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}: ${JSON.stringify(detail)}`); }
}
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

async function main(): Promise<void> {
  const root = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!root) throw new Error("必须由 runner 指定隔离的 MCODE_SMOKE_DATA_ROOT");
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const write = (rel: string, title: string, updatedAt: number, body: string): void => {
    const file = join(root, "memory", ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\ntitle: ${JSON.stringify(title)}\nupdatedAt: ${updatedAt}\n---\n\n${body}\n`, "utf8");
  };
  const file = (rel: string): string => join(root, "memory", ...rel.split("/"));
  const oldPath = "rules/old.md";
  const aPath = "preferences/one.md";
  const bPath = "preferences/two.md";
  const keepPath = "project/keep.md";
  write(oldPath, "待核旧规则", now - 100 * DAY, "旧记录（只给建议）");
  write(aPath, "界面排版", now - DAY, "正文甲。人工看两条的差异后才可删除。");
  write(bPath, "界面排版", now - DAY, "正文乙。标题相同不代表内容相同。");
  write(keepPath, "当前项目", now - DAY, "不应被列为过期或重复。");
  const original = readFileSync(file(oldPath), "utf8");
  // 引擎原生的项目记忆不是六类 Mcode 记忆，整理绝不能碰它。
  const enginePath = join(root, "projects", "demo", "memory", "MEMORY.md");
  mkdirSync(dirname(enginePath), { recursive: true });
  writeFileSync(enginePath, "engine native", "utf8");

  const handlers = new Map<string, (evt: unknown, input: unknown) => unknown>();
  const ipcMain = { handle(name: string, fn: (evt: unknown, input: unknown) => unknown) {
    handlers.set(name, fn);
  } } as unknown as IpcMain;
  const { MEMORY_REVIEW_CHANNEL, MEMORY_REVIEW_DELETE_CHANNEL } = await import("@contracts/memory");
  const { registerMemoryHandlers } = await import("@main/ipc/memory.js");
  registerMemoryHandlers(ipcMain);
  const call = async (channel: string, input?: unknown): Promise<any> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`没有注册 ${channel}`);
    return await handler(null, input);
  };

  console.log("维护：扫描建议，不自动删，不碰引擎记忆");
  const report = await call(MEMORY_REVIEW_CHANNEL) as MemoryReviewResult;
  same("只把超过 90 天的一条列作过期", report.stale.map((f) => f.path), [oldPath]);
  check("同标题但正文不同的一对也只给疑似重复建议", report.duplicates.some((d) =>
    new Set([d.a.path, d.b.path]).size === 2 &&
    [aPath, bPath].every((p) => [d.a.path, d.b.path].includes(p)) &&
    d.a.preview !== d.b.preview,
  ), report.duplicates);
  check("每条建议含完整内容指纹与人工可读摘要", report.stale[0]?.digest.length === 64 &&
    report.stale[0]?.preview.includes("旧记录"), report.stale[0]);
  check("扫描没有修改任何文件", original === readFileSync(file(oldPath), "utf8") &&
    existsSync(file(aPath)) && existsSync(file(bPath)));
  check("不会扫描引擎原生的项目 MEMORY.md", !JSON.stringify(report).includes("engine native") &&
    !JSON.stringify(report).includes("MEMORY.md") && existsSync(enginePath));
  check("列表没有被截断，也没有读失败", report.totalFiles === 4 &&
    !report.staleTruncated && !report.duplicateTruncated && report.unreadable.length === 0);

  console.log("人工选择：重复对不能两边都勾；仅显式选择的一条删除");
  check("两份都勾禁止删", reviewSelectionConflict(report, [aPath, bPath]));
  check("只勾一份可以继续", !reviewSelectionConflict(report, [bPath]));
  const chosen = report.duplicates.flatMap((d) => [d.a, d.b]).find((f) => f.path === bPath) as MemoryReviewEntry;
  const deleted = await call(MEMORY_REVIEW_DELETE_CHANNEL, { path: chosen.path, digest: chosen.digest });
  check("选中的重复文件经核对后删除", deleted.ok === true && !existsSync(file(bPath)), deleted);
  check("另一份与过期候选仍在", existsSync(file(aPath)) && existsSync(file(oldPath)));
  check("删除会通知列表订阅者", notifications.some((n: string) => n.includes(bPath)), notifications);
  check("重新扫描不会继续列已删除的重复文件", (await call(MEMORY_REVIEW_CHANNEL) as MemoryReviewResult).duplicates.length === 0);

  console.log("版本不符：拒绝删除且暴露错误，不能让过期建议暗删新内容");
  const old = report.stale[0]!;
  const changedBody = "旧记录（只给建议）" + "Z".repeat(180); // 摘要附近未变，必须检查全正文。
  write(oldPath, "待核旧规则", now - 100 * DAY, changedBody);
  const staleDigest = await call(MEMORY_REVIEW_DELETE_CHANNEL, { path: oldPath, digest: old.digest });
  check("正文改动后旧指纹拒删", staleDigest.ok === false && !!staleDigest.error && existsSync(file(oldPath)), staleDigest);
  const fresh = (await call(MEMORY_REVIEW_CHANNEL) as MemoryReviewResult).stale[0]!;
  const done = await call(MEMORY_REVIEW_DELETE_CHANNEL, { path: oldPath, digest: fresh.digest });
  check("重新扫描、再次确认才可删除", done.ok === true && !existsSync(file(oldPath)) && existsSync(enginePath), done);
  check("伪造指纹不能删除正常文件", (await call(MEMORY_REVIEW_DELETE_CHANNEL, {
    path: keepPath, digest: "0".repeat(64),
  })).ok === false && existsSync(file(keepPath)));
  check("越界路径与链接仍受 store 校验，不会成功", (await call(MEMORY_REVIEW_DELETE_CHANNEL, {
    path: "../../keep.md", digest: "0".repeat(64),
  })).ok === false);

  const editedMetaPath = "rules/hand-edited.md";
  write(editedMetaPath, "人工文件", now - 100 * DAY, "正文不变");
  const oldMeta = (await call(MEMORY_REVIEW_CHANNEL) as MemoryReviewResult).stale.find((f) => f.path === editedMetaPath)!;
  const beforeMetaEdit = readFileSync(file(editedMetaPath), "utf8");
  writeFileSync(file(editedMetaPath), beforeMetaEdit.replace(/^---\n/, "---\nnote: important\n"), "utf8");
  const changedMeta = await call(MEMORY_REVIEW_DELETE_CHANNEL, { path: editedMetaPath, digest: oldMeta.digest });
  check("仅人工更改未知 frontmatter 字段也不能用旧指纹删除", changedMeta.ok === false &&
    existsSync(file(editedMetaPath)), changedMeta);
  rmSync(file(editedMetaPath), { force: true });

  // listMemoryFiles 原本遇到打不开的 *.md 会无声跳过。整理不能悄悄说“全查了”。
  const broken = file("rules/not-a-file.md");
  mkdirSync(broken, { recursive: true });
  const partial = await call(MEMORY_REVIEW_CHANNEL) as MemoryReviewResult;
  check("列表阶段也显式上报不可读的 *.md", partial.unreadable.includes("rules/not-a-file.md"), partial.unreadable);
  rmSync(broken, { recursive: true });

  console.log("报告限额及失败：部分结果必须可见，不可装作全部扫描完了");
  const { buildMemoryReview } = await import("@main/memory/review.js");
  const metas = Array.from({ length: 205 }, (_, i) => ({
    path: `rules/x${i}.md`, category: "rules", title: String(i), updatedAt: now - 100 * DAY,
  }));
  const limited = buildMemoryReview(metas, (path: string) => {
    if (path === metas[0]!.path) throw new Error("unreadable");
    return { content: path };
  }, now);
  check("过期建议超上限时报告显示总量/截断", limited.staleTotal === 205 && limited.staleTruncated && limited.stale.length <= 100);
  check("重复扫描超上限时报告显示数量/截断", limited.duplicateTruncated && limited.scannedForDuplicates <= 200);
  check("读失败的文件单列，不会误列为可删", limited.unreadable.includes(metas[0]!.path) &&
    !limited.stale.some((f: MemoryReviewEntry) => f.path === metas[0]!.path));
  const sameTitle = Array.from({ length: 16 }, (_, i) => ({
    path: `rules/dup${i}.md`, category: "rules", title: "同标题", updatedAt: now,
  }));
  const manyPairs = buildMemoryReview(sameTitle, (path: string) => ({ content: path }), now);
  check("重复对超过 100 对仍明确说明只显示一部分", manyPairs.duplicatePairTotal === 120 &&
    manyPairs.pairTruncated && manyPairs.duplicates.length === 100);
  const oversized = buildMemoryReview(sameTitle.slice(0, 2), () => ({ content: "A".repeat(8_001) }), now);
  check("超长正文不取前缀误判重复", oversized.duplicates.length === 0 && oversized.tooLong.length === 2);

  console.log("界面入口：只接受勾选、确认，不自动执行删除");
  const panel = readFileSync(resolve("src/renderer/components/memory/MemoryExplorerPanel.tsx"), "utf8");
  const ui = readFileSync(resolve("src/renderer/components/memory/MemoryMaintenanceReview.tsx"), "utf8");
  check("记忆库页提供整理入口", panel.includes("MemoryMaintenanceReview") && panel.includes("memory.reviewOpen"));
  check("建议面板通过 IPC 取建议和版本校验删除", ui.includes("api.memory.review()") && ui.includes("api.memory.reviewDelete("));
  check("删除前明确二次确认且保护脏草稿", ui.includes("<ConfirmDialog") && ui.includes("dirty") && ui.includes("reviewSelectionConflict"));

  console.log(`\nmemory-review smoke: ${total - failed}/${total} passed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err) => { console.error(err); process.exitCode = 1; });
