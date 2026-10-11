/**
 * host-action-cancel-smoke —— 【MC-072】工作流取消必须贯穿 code 节点的**宿主后处理**。
 *
 * 从前 `CodeExecutor.execute` 只把 `input.signal` 传给脚本进程,**脚本跑完之后**的
 * `applyHostActions(outcome)` 不带任何取消信号:用户在导入**中途**取消工作流,脚本停得住,
 * 但接下来的「收进库」「挂回 Markdown」「广播」照样做完 —— 界面显示"已停止",资料库却还在变。
 *
 * 直接驱动生产的 `orchestration/adoptFromCode.ts`(它只 type-import 库模块,无 electron/db),
 * 用**内存假 host**记录真实发生的副作用。夹具都是内存里的,不碰任何用户文献。
 */
import assert from "node:assert/strict";
import { applyHostActions, configureCodeNodeLibraryHost } from "@main/orchestration/adoptFromCode.js";
import { CodeExecutor } from "@main/orchestration/codeExecutor.js";
import type { NodeOutcome } from "@contracts/nodeType";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (e) { failures.push(name + ": " + String(e)); console.error("FAIL " + failures.at(-1)); }
}

/** 每次用例前重装一套「记录用」的内存 host。 */
interface Journal {
  events: string[];
  imported: number;
  adopted: number;
  /** 【MC-072】最近一次 `importAnyFiles` 收到的 `opts.signal`(看调用方有没有把取消信号传进来)。 */
  importedSignal?: AbortSignal;
  /** 批量导入收到的 path 列表(逐项循环判据)。 */
  importedPaths?: string[];
}
function installHost(j: Journal, opts: { importGate?: Promise<void> } = {}): void {
  configureCodeNodeLibraryHost({
    importAnyFiles: (async (paths: string[], mode?: { signal?: AbortSignal }) => {
      j.events.push("IMPORT_STARTED");
      j.importedSignal = mode?.signal;
      j.importedPaths = paths;
      // 【MC-072】模拟生产的**逐项循环**:每项提交前查取消(与 pdfImport 同款)。
      for (const _p of paths) {
        if (mode?.signal?.aborted) break;
        if (opts.importGate) await opts.importGate; // 模拟"导入还在进行中"
        j.imported += 1;
        j.events.push(`IMPORT_COMMIT:${_p}`);
      }
      j.events.push("IMPORT_DONE");
      return { added: j.imported, skipped: 0, errors: [], items: paths.slice(0, j.imported).map((p, i) => ({ id: `li_${i}`, title: p })) };
    }) as never,
    adoptMarkdownFile: ((itemId: string) => {
      j.events.push(`ADOPT:${itemId}`);
      j.adopted += 1;
      return { ok: true, relPath: "full.md", imageCount: 0, missing: [] };
    }) as never,
    notifyLibraryChanged: (reason: string) => { j.events.push(`NOTIFY:${reason}`); },
  });
}

/** 一个"脚本已成功"且带 importFiles + adoptMarkdown 的产出。 */
function successOutcome(): NodeOutcome {
  return {
    status: "success",
    summary: "转录完成",
    outputs: {
      importFiles: { paths: ["/tmp/a.pdf", "/tmp/b.pdf"] },
      adoptMarkdown: [
        { itemId: "li_1", path: "/tmp/full1.md" },
        { itemId: "li_2", path: "/tmp/full2.md" },
        { itemId: "li_3", path: "/tmp/full3.md" },
      ],
    },
  };
}

async function main(): Promise<void> {
  // ── A. 基线:不取消 → 导入 + 逐条挂回都发生(修复不能把正常路径也拦了)──
  await test("不取消:导入与全部挂回照常发生", async () => {
    const j: Journal = { events: [], imported: 0, adopted: 0 };
    installHost(j);
    const out = await applyHostActions(successOutcome(), {});
    assert.equal(out.status, "success", JSON.stringify(out));
    assert.equal(j.imported, 2);
    assert.equal(j.adopted, 3);
    assert.equal(j.events.includes("ADOPT:li_2"), true);
  });

  // ── B. ★ 脚本结束后、后处理开始前就取消 → 一项都不做 ──
  await test("★ 后处理开始前取消:既不导入也不挂回", async () => {
    const j: Journal = { events: [], imported: 0, adopted: 0 };
    installHost(j);
    const ac = new AbortController();
    ac.abort();
    const out = await applyHostActions(successOutcome(), { signal: ac.signal });
    assert.equal(out.status, "cancelled", JSON.stringify(out));
    assert.equal(j.imported, 0, "取消后仍导入了");
    assert.equal(j.adopted, 0, "取消后仍挂回了");
    assert.equal(out.outputs?.hostCancelled, true);
  });

  // ── C. ★ 导入**中途**取消 → 批次内部**未提交的项不再提交**(MC-072),已提交的如实保留 ──
  await test("★ 导入中途取消:批次内未开始的项不再提交(MC-072),已提交的保留、不挂回", async () => {
    const j: Journal = { events: [], imported: 0, adopted: 0 };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    installHost(j, { importGate: gate });
    const ac = new AbortController();
    // 三文件批次:A 提交后取消,B/C 不许再提交。
    const outcome = successOutcome();
    (outcome.outputs as { importFiles: { paths: string[] } }).importFiles.paths = ["/tmp/a.pdf", "/tmp/b.pdf", "/tmp/c.pdf"];
    const p = applyHostActions(outcome, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20)); // 让导入进到 A 的 gate
    assert.equal(j.events.includes("IMPORT_STARTED"), true, "导入没开始");
    ac.abort(); // A 提交前取消
    release();  // 放行
    const out = await p;
    assert.equal(out.status, "cancelled", JSON.stringify(out));
    // A 在 gate 上"已在途",放行后仍提交(不该谎称回滚);关键是**B/C 不再提交**。
    assert.equal(j.imported < 3, true, `★ 取消后批次内剩的项仍被提交(imported=${j.imported})`);
    assert.equal(j.adopted, 0, "★ 导入后取消,却仍然挂回了 Markdown");
    assert.equal(j.events.some((e) => e.startsWith("ADOPT")), false, "取消后仍有 ADOPT 副作用");
  });

  // ── C2. ★ 批次内 A 已提交后取消 → B/C 不再提交,但 A 如实保留(不谎称回滚) ──
  await test("★ 批次第 A 项提交后取消:B/C 不再提交,A 如实保留", async () => {
    const j: Journal = { events: [], imported: 0, adopted: 0 };
    const ac = new AbortController();
    configureCodeNodeLibraryHost({
      importAnyFiles: (async (paths: string[], mode?: { signal?: AbortSignal }) => {
        j.importedSignal = mode?.signal;
        const committed: string[] = [];
        for (const p of paths) {
          if (mode?.signal?.aborted) break;
          j.imported += 1; committed.push(p);
          if (j.imported === 1) ac.abort(); // A 提交后取消
        }
        return { added: committed.length, skipped: 0, errors: [], items: committed.map((p, i) => ({ id: `li_${i}`, title: p })) };
      }) as never,
      adoptMarkdownFile: ((itemId: string) => { j.events.push(`ADOPT:${itemId}`); j.adopted += 1; return { ok: true, relPath: "full.md", imageCount: 0, missing: [] }; }) as never,
      notifyLibraryChanged: () => undefined,
    });
    const outcome = successOutcome();
    (outcome.outputs as { importFiles: { paths: string[] } }).importFiles.paths = ["/tmp/a.pdf", "/tmp/b.pdf", "/tmp/c.pdf"];
    const out = await applyHostActions(outcome, { signal: ac.signal });
    assert.equal(j.imported, 1, "★ 取消后 B/C 仍被提交(批次循环没查取消)");
    assert.equal(j.adopted, 0, "取消后不应再挂回");
    assert.equal(out.status, "cancelled", JSON.stringify(out));
    assert.equal((out.outputs?.imported as unknown[] | undefined)?.length, 1, "已提交的 A 应如实留在回执里");
  });

  // ── D. ★ 挂回**第 k 项之后**取消 → 后续项不再执行,已挂上的如实保留 ──
  await test("★ 挂回中途取消:取消点后的项不再挂,已挂的如实保留", async () => {
    const j: Journal = { events: [], imported: 0, adopted: 0 };
    const ac = new AbortController();
    // 一个"挂第一项时触发取消"的 host。
    configureCodeNodeLibraryHost({
      importAnyFiles: (async (paths: string[]) => ({ added: paths.length, skipped: 0, errors: [], items: paths.map((p, i) => ({ id: `li_${i}`, title: p })) })) as never,
      adoptMarkdownFile: ((itemId: string) => {
        j.events.push(`ADOPT:${itemId}`);
        j.adopted += 1;
        if (itemId === "li_1") ac.abort(); // 挂完第一项即取消
        return { ok: true, relPath: "full.md", imageCount: 0, missing: [] };
      }) as never,
      notifyLibraryChanged: (reason: string) => { j.events.push(`NOTIFY:${reason}`); },
    });
    const out = await applyHostActions(successOutcome(), { signal: ac.signal });
    assert.equal(j.adopted, 1, `★ 取消点后仍在挂回(挂了 ${j.adopted} 项)`);
    assert.equal(j.events.includes("ADOPT:li_1"), true);
    assert.equal(j.events.includes("ADOPT:li_2"), false, "取消后仍挂了 li_2");
    assert.equal(out.status, "cancelled", JSON.stringify(out));
  });

  // ── E. 旧调用形态:`applyHostActions(outcome)` 不传 ctx 仍工作(兼容)──
  await test("不传 ctx 的旧调用仍照常(兼容)", async () => {
    const j: Journal = { events: [], imported: 0, adopted: 0 };
    installHost(j);
    const out = await applyHostActions(successOutcome());
    assert.equal(out.status, "success");
    assert.equal(j.adopted, 3);
  });

  // ── F. ★ 端到端:`CodeExecutor.execute` 真的把取消信号贯穿到宿主后处理 ──
  // 这条钉的是 **codeExecutor 的接线**(A–D 直接调 applyHostActions,绕过了它 ——
  // 只撤掉 codeExecutor 里的 signal 传递,A–D 仍会全绿,那正是"断言测的是别人的职责")。
  //
  // ⚠️ 判据不能是"预先把 signal abort 掉":那样 `runCodeNode` 自己就返回 cancelled,
  // `applyHostActions` 也会因 `status !== success` 早退 —— 与信号有没有贯穿无关,变异不会红。
  // 要区分"贯穿了没有",必须让**脚本成功**,再由宿主在导入中途 abort:`importAnyFiles` 里
  // abort 之后若信号真传进来了,`applyHostActions` 会跳过挂回;没传进来则照样挂回。
  await test("★ CodeExecutor.execute:取消信号贯穿到宿主后处理(脚本成功,导入途中取消→不再挂回)", async () => {
    const j: Journal = { events: [], imported: 0, adopted: 0 };
    const ac = new AbortController();
    // host:导入一进来就 abort(模拟"脚本跑完、导入进行中用户点了取消")。
    configureCodeNodeLibraryHost({
      importAnyFiles: (async (paths: string[]) => {
        j.events.push("IMPORT_STARTED");
        ac.abort(); // 在导入期间取消
        j.imported += paths.length;
        j.events.push("IMPORT_COMMITTED");
        return { added: paths.length, skipped: 0, errors: [], items: paths.map((p, i) => ({ id: `li_${i}`, title: p })) };
      }) as never,
      adoptMarkdownFile: ((itemId: string) => { j.events.push(`ADOPT:${itemId}`); j.adopted += 1; return { ok: true, relPath: "full.md", imageCount: 0, missing: [] }; }) as never,
      notifyLibraryChanged: (reason: string) => { j.events.push(`NOTIFY:${reason}`); },
    });
    const code = [
      "const r = { outputs: { importFiles: { paths: ['/tmp/a.pdf'] }, adoptMarkdown: [",
      "  { itemId: 'li_1', path: '/tmp/f1.md' },",
      "] } };",
      'process.stdout.write("@@mcode:result " + JSON.stringify(r) + "\\n");',
    ].join("\n");
    const executor = new CodeExecutor();
    const outcome = await executor.execute({
      node: { id: "n1", type: "mcode.code", title: "t", params: {}, position: { x: 0, y: 0 } },
      input: { code: { code, language: "node", timeoutMs: 20_000 }, signal: ac.signal },
      cwd: process.cwd(),
      metadata: { runId: "run_x", sessionId: "s_x", nodeId: "n1" },
    } as never);
    assert.equal(j.imported, 1, "导入该发生(脚本成功、取消点在导入中)");
    assert.equal(outcome.status, "cancelled", JSON.stringify(outcome));
    assert.equal(j.adopted, 0, "★ 导入途中取消后仍挂回了(取消信号没贯穿到 applyHostActions)");
    assert.equal(j.events.some((e) => e.startsWith("ADOPT")), false, "★ 取消后仍有 ADOPT 副作用(信号没贯穿)");
  });

  console.log(`\nhost-action-cancel: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

void main();
