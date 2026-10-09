import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { agentMcpTools } from "@main/mcp/agentTools.js";
import { fileArchitecturePrompt } from "@main/lib/systemPrompt.js";
import type { ToolResult } from "@main/mcp/sdk.js";

const root = mkdtempSync(path.join(tmpdir(), "mcode-text-contract-"));
const tools = agentMcpTools({ cwdFor: () => root });
const anotherHost = agentMcpTools({ cwdFor: () => root });
async function call(name: string, args: Record<string, unknown>, other = false): Promise<ToolResult> {
  const tool = (other ? anotherHost : tools).find(t => t.name === name)!;
  return tool.handler(z.object(tool.inputSchema).parse(args), { sessionId: "text-smoke" });
}
const body = (r: ToolResult): string => r.content.filter(c => c.type === "text").map(c => c.text).join("\n");
let checks = 0;
function check(name: string, value: unknown): void { assert.ok(value, name); checks++; console.log("PASS " + name); }
try {
  for (let n = 0; n < 10; n++) {
    writeFileSync(path.join(root, "race.txt"), "alpha\nbeta\n");
    const results = await Promise.all([
      call("agent_edit_file", { path: "race.txt", old_string: "alpha", new_string: "ALPHA" }),
      call("agent_edit_file", { path: "race.txt", old_string: "beta", new_string: "BETA" }, true),
    ]);
    check("concurrent edits retain both changes across hosts " + n, results.every(r => !r.isError) && readFileSync(path.join(root, "race.txt"), "utf8") === "ALPHA\nBETA\n");
  }
  writeFileSync(path.join(root, "crlf.txt"), "alpha\r\nomega\r\n");
  await call("agent_edit_file", { path: "crlf.txt", old_string: "alpha", new_string: "first\nsecond" });
  check("single-line replacement preserves CRLF", readFileSync(path.join(root, "crlf.txt"), "utf8") === "first\r\nsecond\r\nomega\r\n");
  const original = "A".repeat(2200) + "TAIL_SENTINEL\r\n" + "中文😀".repeat(700) + "\r\nend";
  writeFileSync(path.join(root, "long.txt"), original);
  let result = await call("agent_read_file", { path: "long.txt", max_chars: 1001 });
  let collected = "", pages = 0, hash = "";
  while (true) {
    check("page succeeds", !result.isError);
    const page = result.structuredContent!;
    check("bounded raw content", typeof page.content === "string" && page.content.length <= 1001);
    collected += page.content; hash = String(page.sha256); pages++;
    if (!page.has_more) break;
    check("pagination progresses", pages < 20);
    result = await call("agent_read_file", { path: "long.txt", offset: page.next_offset, column_offset: page.next_column_offset, expected_sha256: hash, max_chars: 1001 });
  }
  check("lossless long lines, Unicode and CRLF", collected === original);
  const grep = await call("agent_grep", { path: "long.txt", pattern: "TAIL_SENTINEL", literal: true });
  check("grep preview includes actual match", body(grep).includes("TAIL_SENTINEL"));
  check("grep reports preview clipping separately", grep.structuredContent?.line_truncated === true);
  const edit = await call("agent_edit_file", { path: "long.txt", old_string: "TAIL_SENTINEL", new_string: "changed", expected_sha256: hash });
  check("fresh version permits edit", !edit.isError);
  const stale = await call("agent_edit_file", { path: "long.txt", old_string: "changed", new_string: "wrong", expected_sha256: hash });
  check("stale version fails without write", stale.isError && readFileSync(path.join(root, "long.txt"), "utf8").includes("changed"));
  const staleRead = await call("agent_read_file", { path: "long.txt", expected_sha256: hash });
  check("stale continuation fails", staleRead.isError);
  writeFileSync(path.join(root, "budget.txt"), Array.from({ length: 1000 }, () => "x".repeat(1000)).join("\n"));
  const budget = await call("agent_read_file", { path: "budget.txt" });
  check("default content budget", budget.structuredContent?.returned_chars === 30000 && budget.structuredContent.has_more === true);
  check("bounded complete tool payload", JSON.stringify(budget).length < 100000);
  writeFileSync(path.join(root, "batch.txt"), "alpha\nbeta\n");
  const failed = await call("agent_edit_file", { path: "batch.txt", edits: [{ old_string: "alpha", new_string: "changed" }, { old_string: "absent", new_string: "wrong" }] });
  check("batch failure writes nothing", failed.isError && readFileSync(path.join(root, "batch.txt"), "utf8") === "alpha\nbeta\n");
  const afterFailure = await call("agent_edit_file", { path: "batch.txt", old_string: "beta", new_string: "BETA" });
  check("failed edit releases lock", !afterFailure.isError);
  writeFileSync(path.join(root, "empty.txt"), "");
  const empty = await call("agent_read_file", { path: "empty.txt" });
  check("empty file terminates", empty.structuredContent?.content === "" && empty.structuredContent.has_more === false);
  writeFileSync(path.join(root, "bom.txt"), "\ufeff中文\n");
  const bom = await call("agent_read_file", { path: "bom.txt" });
  check("BOM retained in raw content", bom.structuredContent?.content === "\ufeff中文\n");
  writeFileSync(path.join(root, "bad-utf8.txt"), Buffer.from([0x61, 0xc3, 0x28]));
  const invalid = await call("agent_read_file", { path: "bad-utf8.txt" });
  check("invalid UTF-8 is not silently replaced", invalid.isError);
  writeFileSync(path.join(root, "lines.txt"), "one\r\ntwo\r\nthree");
  const limited = await call("agent_read_file", { path: "lines.txt", limit: 1 });
  check("line-limited cursor includes original CRLF", limited.structuredContent?.content === "one\r\n" && limited.structuredContent.next_offset === 2 && limited.structuredContent.next_column_offset === 0);
  const badColumn = await call("agent_read_file", { path: "lines.txt", column_offset: 99 });
  check("invalid column fails explicitly", badColumn.isError);
  const prompt = fileArchitecturePrompt("C:\\fixture", "C:\\fixture\\scripts");
  check("no PDF-is-ZIP claim", !prompt.includes("那四个格式都是压缩包"));
  check("no permanent helper failure claim", !prompt.includes("Windows 上**必崩**"));
  check("no lossless transcription promise", !prompt.includes("公式表格都不丢"));
  // ★ "哪些目录不往里走"的名单**只有一份**(`agentSearchSessions.SKIP_DIRS`)。从前
  //   `agentTools.ts` 与 `agentSearchSessions.ts` 各写一份、且已漂了(前者多了 `coverage`),
  //   于是 `agent_search` 会翻进 `coverage/` 报生成产物的命中,而 `agent_grep` 不会。
  {
    const toolsSrc = readFileSync("src/main/mcp/agentTools.ts", "utf8");
    check(
      "★ agentTools 不再自带一份 SKIP_DIRS(改用 agentSearchSessions 那份)",
      !/const SKIP_DIRS = new Set/.test(toolsSrc) && /import \{[^}]*SKIP_DIRS[^}]*\} from "\.\/agentSearchSessions\.js"/.test(toolsSrc),
    );
  }
  // ★ 搜索起点不存在时,交给模型的那句 `error` 要说人话(中文),不是原始英文 OS 错误。
  //   这条 `error` 经 `agent_search_read` 的 `error` 字段原样回到模型手上,模型再学给
  //   用户。`fs.stat` 在起点不存在时抛 `ENOENT: no such file or directory, stat '…'`,
  //   而孪生的 `agent_grep` 同一处境给的是「路径不存在:…」。判据钉行为。
  {
    const started = await call("agent_search_start", {
      search_type: "content",
      pattern: "anything",
      path: path.join(root, "no-such-dir-xyz"),
    });
    const startedBody = body(started);
    // 起点不存在时,错误可能当场回(同步 stat)或稍后经 read 回(异步)。两条都查:取
    // searchId 去 read 一次,把任一处的 error 拿来断言。
    const idMatch = /"searchId"\s*:\s*"([^"]+)"/.exec(startedBody);
    let errText = startedBody;
    if (idMatch) {
      const read = await call("agent_search_read", { searchId: idMatch[1], offset: 0, length: 10 });
      errText += "\n" + body(read);
    }
    check(
      "★ 搜索起点不存在时的 error 是中文,不是原始 ENOENT 英文",
      /搜索起点不存在/.test(errText) && !/ENOENT/.test(errText),
    );
  }
  console.log(`MCP text contract: ${checks} checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
