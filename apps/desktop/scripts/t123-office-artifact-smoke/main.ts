/**
 * 【T123】Office/PDF 的产物必须进 turn.files —— 否则任务中心看不见它们。
 *
 * ## 这一套钉的四件事
 *
 * 1. `document_tool_call` 的 create 类工具（`create_document` / `build_deck`）
 *    之后 `turn.files` 非空，`kind === "created"`，路径是那个 docx；
 * 2. 拿这份 `turn.files` 走**真身** `classifyTurn`，真的建出任务；
 * 3. `Write` 的既有行为零变化（正控）；
 * 4. **`document_tool_call` 不在 `FILE_MUTATING_TOOLS` 里** —— 这是 T123 的核心判据。
 *
 * ## 第 4 条为什么单独存在
 *
 * 「把 `document_tool_call` 加进 `FILE_MUTATING_TOOLS`」是看起来更简单的修法，
 * 但那个集合同时驱动工作区越界围栏与 rewind 的 pre-turn 快照（见 T97 §三与
 * T123 §二）。第 4 条与第 1 条合起来才说明：**产物进了 turn.files，而集合没被改动。**
 * 只有第 1 条时，两种修法都能让它绿。
 *
 * ## 用的是真身，不是副本
 *
 * `FileSnapshot` / `SdkMessageAdapter` / `classifyTurn` 全部 import 生产实现。
 * 套件里不重写任何一条判据 —— 这个仓库栽过「抄一份逻辑去验副本」（T101）。
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSnapshot, FILE_MUTATING_TOOLS } from "../../src/main/lib/fileSnapshot.js";
import { SdkMessageAdapter } from "../../src/main/providers/claude-sdk/SdkMessageAdapter.js";
import { classifyTurn } from "../../src/main/tasks/autoCreate.js";
import type { RuntimeEvent, TurnFileEntry } from "@contracts/runtime";

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

const root = mkdtempSync(join(tmpdir(), "t123-office-"));
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/* ── 一个非 UTF-8 的 .docx 样本（PK 头 + 无效 UTF-8 字节）──────────────────
 * 真实的 .docx 是 zip；这里只要「字节不是合法 UTF-8」，`recordPre` 走的就是
 * 与真 .docx 完全同一条分支（STRICT_UTF8.decode 抛 → unrestorable）。
 *
 * ⚠️ 这个文件**不在 setup 时创建** —— 它在 dispatch 之后、flushFinal 之前才出现，
 * 这样 `recordPre` 拿到的是 ENOENT（exists:false），`freeze()` 才会给出
 * `kind: "created"`。事先创建会让它变成 `modified`，同时丢掉「新建二进制」
 * 这条更关键的分支。 */
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const NON_UTF8 = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28, 0xa0, 0xa1]);
const docxDir = join(root, "out");
mkdirSync(docxDir, { recursive: true });
const docxPath = join(docxDir, "report.docx");
const writeDocx = (): void => writeFileSync(docxPath, Buffer.concat([DOCX_MAGIC, NON_UTF8]));

const textPath = join(docxDir, "notes.md");
const textBody = "# 标题\n\n正文第一行\n正文第二行\n";
writeFileSync(textPath, textBody, "utf8");
const editText = (): void => writeFileSync(textPath, `${textBody}追加一行\n`, "utf8");

/* ── 一个只记录事件的 ProviderContext ───────────────────────────────────── */
function makeAdapter(): { adapter: SdkMessageAdapter; events: RuntimeEvent[]; snapshots: FileSnapshot } {
  const events: RuntimeEvent[] = [];
  const ctx = {
    emit: (e: RuntimeEvent) => events.push(e),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
  const snapshots = new FileSnapshot();
  // sessionId / askUserQuestionAvailable / cwd / snapshots
  return { adapter: new SdkMessageAdapter(ctx, "t123", false, root, snapshots), events, snapshots };
}

/** 造一条 assistant 消息，里面只有一个 tool_use 块。 */
function toolUse(name: string, input: Record<string, unknown>): unknown {
  return {
    type: "assistant",
    message: {
      id: `msg_${Math.random().toString(36).slice(2, 10)}`,
      role: "assistant",
      model: "test-model",
      content: [{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 10)}`, name, input }],
    },
  };
}

/**
 * 跑一个"回合"：dispatch 一条只有 tool_use 的 assistant 消息，然后 flushFinal。
 *
 * ## 为什么要有 `afterDispatch`，而且必须先等快照落地
 *
 * `dispatch` 只**记录** tool_use（发了 `tool.use` 事件、调了 `recordPre`），
 * 它**不执行**工具 —— 真正执行工具的是 SDK / ModuleHost 的受控子进程。
 * 所以套件必须自己补上「工具已经落盘」这个副作用。
 *
 * ⚠️ **不能 dispatch 完立刻写**：`recordPre` 是 `void` 调用的（fire-and-forget），
 * 它内部 `await readFile` 还没完成时，我们若先写文件，它读到的就是**写后**的内容
 * → `before === after` → `freeze()` 按「空转重写」剔掉（那是它的正确行为，
 * 见 `fileSnapshot.ts` 里 `afterBytes.equals(before)` 分支）。
 * 实测过这条：不加等待，正控 `Write` 那条也会红。
 *
 * 所以这里轮询 `inflight` 直到清空 —— 那是 `recordPre` 唯一的落地信号
 * （`FileSnapshot` 没有暴露 await 接口，`freeze()` 是唯一消费者）。
 */
async function settleSnapshots(snap: FileSnapshot): Promise<void> {
  const inner = snap as never as { inflight: Map<string, unknown> };
  for (let i = 0; i < 400 && inner.inflight.size > 0; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  if (inner.inflight.size > 0) throw new Error("recordPre 未在 800ms 内落地");
}

async function turnWith(
  name: string,
  input: Record<string, unknown>,
  afterDispatch?: (snap: FileSnapshot) => void | Promise<void>,
): Promise<TurnFileEntry[]> {
  const { adapter, events, snapshots } = makeAdapter();
  await adapter.dispatch(toolUse(name, input) as never);
  await settleSnapshots(snapshots);
  await afterDispatch?.(snapshots);
  await adapter.flushFinal();
  return events.filter((e): e is Extract<RuntimeEvent, { type: "turn.files" }> => e.type === "turn.files")
    .flatMap((e) => e.files);
}

console.log("\n① ★ document_tool_call + create_document → turn.files 里出现那个 docx");

const officeFiles = await turnWith("document_tool_call", {
  tool: "create_document",
  app: "docs",
  filePath: docxPath,
  input: { source: join(root, "in.html") },
}, writeDocx);

check("turn.files 非空", officeFiles.length > 0, officeFiles.length);
check(
  "★ 那个 docx 在 turn.files 里",
  officeFiles.some((f) => f.filePath === docxPath),
  officeFiles.map((f) => f.filePath),
);
check(
  "★ kind === created（新建产物，不是 modified）",
  officeFiles.find((f) => f.filePath === docxPath)?.kind === "created",
  officeFiles.find((f) => f.filePath === docxPath),
);

console.log("\n② ★ 拿这份 turn.files 走真身 classifyTurn → 真的建出任务");

const verdict = classifyTurn({
  sessionKind: "chat",
  reason: "end_turn",
  artifacts: officeFiles.map((f) => ({
    path: f.filePath,
    description: `新建文件（+${f.adds} 行）`,
    createdAt: Date.now(),
  })),
});
check("★ create === true", verdict.create === true, verdict);
check("★ failed === false（成功的回合不该记成失败）", verdict.failed === false, verdict);

console.log("\n③ 正控：Write 的既有行为没变");

const writeFiles = await turnWith("Write", { file_path: textPath, content: textBody + "追加一行\n" }, editText);
check("Write 之后 turn.files 非空", writeFiles.length > 0, writeFiles.length);
check(
  "Write 记的是那个文件",
  writeFiles.some((f) => f.filePath === textPath),
  writeFiles.map((f) => f.filePath),
);
check(
  "Write 改已有文件 → kind === modified",
  writeFiles.find((f) => f.filePath === textPath)?.kind === "modified",
  writeFiles.find((f) => f.filePath === textPath),
);

console.log("\n④ ★★ 核心判据：document_tool_call 不在 FILE_MUTATING_TOOLS 里");

check(
  "★ FILE_MUTATING_TOOLS 只有四个文件编辑工具",
  FILE_MUTATING_TOOLS.size === 4,
  [...FILE_MUTATING_TOOLS],
);
check(
  "★ document_tool_call 不在 FILE_MUTATING_TOOLS",
  !FILE_MUTATING_TOOLS.has("document_tool_call"),
  [...FILE_MUTATING_TOOLS],
);
check("build_deck 也不在", !FILE_MUTATING_TOOLS.has("build_deck"), [...FILE_MUTATING_TOOLS]);

console.log("\n⑤ 负控：apply 类工具的 filePath 不该被当成产物");

// `apply_ops` 的 filePath 是**用户当前打开的文档**，不是这一轮的产物。
// 它不在 create 名单里 → 不应产生 turn.files。
const applyFiles = await turnWith("document_tool_call", {
  tool: "apply_ops",
  app: "docs",
  filePath: textPath,
  input: { ops: [] },
});
check("apply_ops 之后 turn.files 为空", applyFiles.length === 0, applyFiles.map((f) => f.filePath));

console.log("\n⑥ 负控：非 create 的 document_tool_call 工具（read 类）同样不进");

const readFiles = await turnWith("document_tool_call", {
  tool: "read_blocks",
  app: "docs",
  filePath: textPath,
});
check("read_blocks 之后 turn.files 为空", readFiles.length === 0, readFiles.map((f) => f.filePath));

console.log(`\nt123-office-artifact-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
