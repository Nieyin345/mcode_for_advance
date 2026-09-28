/**
 * maint-audit-smoke —— 全计划回访(2026-09-27)中直接修掉的两个跨任务遗留项的回归网。
 *
 * ## §1 MinerU 转录脚本的 itemId 落点消毒(M33 报告 §4-1 → M28 域,回访时仍未修)
 *
 * `MINERU_PY` 的 `transcribe_one` 用**载荷里的** itemId 拼结果目录
 * (`Path.cwd()/"mineru"/item_id`),而载荷可以被 code 节点 / 外部触发器喂进来:
 * `"../x"` 会把结果目录写到 cwd/mineru 之外("../../x" 写出工作目录)。与
 * mineru-py-smoke 同法:把字面量落成真 .py、用真 python 跑 —— 只是把 `http_json`
 * 换成一炸就停的桩,单测 `transcribe_one` 走到网络之前的那几行。
 *
 * ## §2 覆盖旧提问时,旧 requestId 的 Deferred 不能悬空(M22 报告 → M23,未接)
 *
 * `reduceQuestionAsk` 直接覆盖 `pendingQuestionBySession[sid]`:旧卡片没人能再
 * 回答,而主进程 ApprovalBridge 里旧 requestId 的 Deferred 还在等 —— provider 那头
 * 永远收不到答案。修法与 `dismissQuestion` 同一条:覆盖前先把旧请求按 dismissed
 * 回掉,让那一轮继续走。
 *
 * 只用 fixture(临时目录 + api 流水桩),不触任何真实服务与用户数据。
 *
 * Run: scripts/maint-audit-smoke/run.sh
 */
import { apiCalls } from "./prelude.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ──────────────── §1 MINERU_PY · itemId 只认单个路径分量 ──────────────── */

console.log("\n1. MinerU 转录脚本:itemId 含路径分隔符要在建目录之前拒绝");
{
  const { MINERU_PY } = (await import("@main/workflows/assets.js")) as { MINERU_PY: string };
  check("拿到了 MINERU_PY", typeof MINERU_PY === "string" && MINERU_PY.length > 1000, MINERU_PY?.length);

  const TMP = mkdtempSync(join(tmpdir(), "mcode-audit-mineru-"));
  const CWD = join(TMP, "cwd");
  mkdirSync(CWD, { recursive: true });
  writeFileSync(join(TMP, "mineru_transcribe.py"), MINERU_PY, "utf8");
  const src = join(TMP, "源文件.pdf");
  writeFileSync(src, "%PDF-1.4 假的", "utf8");

  /** 在 CWD 里跑一个探针:桩掉 http_json,调 transcribe_one,打出结果标记。 */
  const probe = (itemId: string): { out: string; escaped: boolean; insideOk: boolean } => {
    const py = [
      "import sys, json",
      `sys.path.insert(0, ${JSON.stringify(TMP)})`,
      "import mineru_transcribe as m",
      "def _boom(*a, **k): raise RuntimeError('SENTINEL_NET')",
      "m.http_json = _boom",
      "try:",
      `    m.transcribe_one({"itemId": ${JSON.stringify(itemId)}, "filePath": ${JSON.stringify(src)}}, 1)`,
      "    print('@@no-raise')",
      "except RuntimeError as e:",
      "    print('@@raised:' + str(e))",
    ].join("\n");
    const probeFile = join(TMP, "probe.py");
    writeFileSync(probeFile, py, "utf8");
    const res = spawnSync("python", ["-u", probeFile], { cwd: CWD, encoding: "utf8", timeout: 60_000 });
    const out = (res.stdout ?? "") + (res.stderr ?? "");
    return {
      out,
      // "../逃逸x" 的落点是 cwd/逃逸x(出了 mineru);写出去就是越界证据。
      escaped: existsSync(join(CWD, "逃逸x")) || existsSync(join(TMP, "逃逸x")),
      insideOk: existsSync(join(CWD, "mineru", "好条目")),
    };
  };

  const evil = probe("../逃逸x");
  check("★ 越界 itemId 被拒(错误里点名 itemId)", evil.out.includes("@@raised:") && evil.out.includes("itemId"), evil.out.slice(0, 300));
  check("★ 没有在 mineru/ 之外建出目录", !evil.escaped);

  const evil2 = probe("..");
  check("★ `..` 同样被拒", evil2.out.includes("@@raised:") && evil2.out.includes("itemId"), evil2.out.slice(0, 300));

  const good = probe("好条目");
  check("正常 itemId 走到网络那一步(桩炸出 SENTINEL_NET,守门没有误伤)", good.out.includes("SENTINEL_NET"), good.out.slice(0, 300));
  check("正常 itemId 的落点建在 mineru/ 之下", good.insideOk);

  rmSync(TMP, { recursive: true, force: true });
}

/* ──────────────── §2 sessionStore · 覆盖旧提问先放掉旧 Deferred ──────────────── */

console.log("\n2. 新提问顶掉旧提问时,旧 requestId 要按 dismissed 回给主进程");
{
  const { useSessionStore } = await import("@renderer/stores/sessionStore.js");
  const ask = (requestId: string | undefined, question: string): void => {
    useSessionStore.getState().ingestEvent({
      type: "question.ask",
      sessionId: "s_audit",
      ...(requestId !== undefined ? { requestId } : {}),
      questions: [{ header: "", question, multiSelect: false, options: [] }],
    } as never);
  };
  const dismissCalls = () =>
    apiCalls.filter((c) => c.path === "claude.respondQuestion" && (c.arg as { dismissed?: boolean })?.dismissed === true);

  ask("q_old", "先问的甲?");
  eq("第一问落卡", (useSessionStore.getState().pendingQuestionBySession as Record<string, { requestId?: string }>)["s_audit"]?.requestId, "q_old");
  eq("只有一问时没有 dismiss 流水", dismissCalls().length, 0);

  ask("q_new", "顶上来的乙?");
  const calls = dismissCalls();
  eq("★ 顶掉旧提问时给主进程回了一笔 dismissed", calls.length, 1);
  const arg = calls[0]?.arg as { sessionId?: string; requestId?: string } | undefined;
  eq("★ 回的是旧 requestId", arg?.requestId, "q_old");
  eq("★ 回在同一个会话上", arg?.sessionId, "s_audit");
  eq("卡片换成了新一问", (useSessionStore.getState().pendingQuestionBySession as Record<string, { requestId?: string }>)["s_audit"]?.requestId, "q_new");

  // 同一 requestId 重投(断线重发/重广播)不算"顶掉",不许多回一笔。
  ask("q_new", "顶上来的乙?");
  eq("★ 同 requestId 重投不再回 dismissed", dismissCalls().length, 1);

  // 哨兵形态(没有 requestId)没有 Deferred 可放,顶掉它不该胡编一个 id 去回。
  useSessionStore.setState((s: { pendingQuestionBySession: Record<string, unknown> }) => ({
    pendingQuestionBySession: { ...s.pendingQuestionBySession, s_audit: { questions: [], requestId: undefined } },
  }) as never);
  ask("q_after_sentinel", "哨兵之后的丙?");
  eq("★ 顶掉无 requestId 的哨兵提问不多回一笔", dismissCalls().length, 1);
}

/* ──────────────── 收尾 ──────────────── */

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
