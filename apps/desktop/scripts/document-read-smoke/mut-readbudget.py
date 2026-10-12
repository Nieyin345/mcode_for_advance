"""变异验证(台账 MC-065):逐个撤掉「输入资源预算」修复,看新断言真的红,逐字节还原后转绿。

覆盖(每项只改一处,精确 str.replace 且锚点必须恰好 1 次):
  1. readBudget.ts  fold-error         —— 把 READ_ERROR_AFTER_PARTIAL 折叠回 COMPLETE(§34.3 原形)
  2. agentTools.ts  url-outcome        —— 中途失败当成成功正文返回
  3. agentTools.ts  url-input          —— 流层有界读退回 res.text() 整份读
  4. agentTools.ts  content-length     —— 撤掉 Content-Length 前置快速拒绝
  5. agentTools.ts  content-type       —— 撤掉二进制 Content-Type 拒绝
  6. agentTools.ts  redirect           —— 退回 redirect:"follow" 无界跟随
  7. agentTools.ts  child-budget       —— 撤掉子进程输出提前终止
  8. readBudget.ts  clamp-cell         —— 单元格预算夹紧失效(超大稀疏坐标不再夹到 maxCells)
  9. readBudget.ts  zip-inflate        —— checkZipInflation 永远不报超预算
 10. agentTools.ts  zip-guard          —— 撤掉文档读取前的 zip 解压膨胀前置拒绝

用法: python apps/desktop/scripts/document-read-smoke/mut-readbudget.py
退出码 0 = 所有变异都验证出「真红且逐字节还原」。
"""
import io, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
TOOLS = os.path.join(DESK, "src", "main", "mcp", "agentTools.ts")
RBUD = os.path.join(DESK, "src", "main", "lib", "readBudget.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

# (文件, 说明, OLD, NEW)
MUTATIONS = [
    (RBUD, "readBudget.ts fold-error", '''  if (errored) {
    return {
      kind: charsRead > 0 ? "READ_ERROR_AFTER_PARTIAL" : "READ_ERROR",
      text: bounded,
      bytesRead,
      charsRead,
      error,
    };
  }''', '''  if (errored) {
    return { kind: "COMPLETE", text: bounded, bytesRead, charsRead };
  }'''),

    (TOOLS, "agentTools.ts url-outcome", '''    case "READ_ERROR_AFTER_PARTIAL":
      throw new Error(
        `读取 URL 中途失败:${outcome.error ?? "未知错误"};已读到 ${outcome.charsRead} 字符(这是部分内容,不是完整响应)`,
      );
    case "READ_ERROR":
      throw new Error(`读取 URL 失败:${outcome.error ?? "未知错误"}`);''', '''    case "READ_ERROR_AFTER_PARTIAL":
    case "READ_ERROR":
      return `${header}\\n\\n${outcome.text}`;'''),

    (TOOLS, "agentTools.ts url-input", '''    const outcome = await readResponseWithinBudget(res, budget);''', '''    const _full = await res.text();
    const outcome: ReadOutcome = _full.length > budget.maxOutputChars
      ? { kind: "TRUNCATED_BY_BUDGET", text: _full.slice(0, budget.maxOutputChars), bytesRead: Buffer.byteLength(_full), charsRead: _full.length }
      : { kind: "COMPLETE", text: _full, bytesRead: Buffer.byteLength(_full), charsRead: _full.length };'''),

    (TOOLS, "agentTools.ts content-length", '''    if (declared !== null) {''', '''    if (false && declared !== null) {'''),

    (TOOLS, "agentTools.ts content-type", '''    if (classifyContentType(contentType) === "binary") {''', '''    if (false && classifyContentType(contentType) === "binary") {'''),

    (TOOLS, "agentTools.ts redirect", '''      res = await fetch(current, { signal: controller.signal, redirect: "manual" });''', '''      res = await fetch(current, { signal: controller.signal, redirect: "follow" });'''),

    (TOOLS, "agentTools.ts child-budget", '''      if (outBytes > maxOutputBytes) return overflow();''', '''      if (false) return overflow();'''),

    # clampCellBudget 失效:永远按请求返回,不做 maxCells 夹紧。
    (RBUD, "readBudget.ts clamp-cell", '''  const rows = Math.max(1, Math.floor(reqRows));
  const cols = Math.max(1, Math.floor(reqCols));
  if (rows * cols <= maxCells) return { maxRows: rows, maxCols: cols, cellBudgetTruncated: false };
  // 先保列(较窄的维),按剩余预算折行;再据折后的行数反推列数,保证 行×列 ≤ maxCells。
  // 列本身超出预算的单列极端情形由最后一步继续折列兜住;两者都 ≥1。
  const effRows = Math.min(rows, Math.max(1, Math.floor(maxCells / cols)));
  const effCols = Math.min(cols, Math.max(1, Math.floor(maxCells / effRows)));
  return { maxRows: effRows, maxCols: effCols, cellBudgetTruncated: true };''', '''  const rows = Math.max(1, Math.floor(reqRows));
  const cols = Math.max(1, Math.floor(reqCols));
  return { maxRows: rows, maxCols: cols, cellBudgetTruncated: false };'''),

    # checkZipInflation 失效:永远不报超预算(等价于撤掉解压膨胀前拒)。
    (RBUD, "readBudget.ts zip-inflate", '''export function checkZipInflation(fileBytes: Buffer, budgetBytes: number): ZipInflationCheck {
  const none: ZipInflationCheck = { declaredBytes: 0, exceededBudget: false };''', '''export function checkZipInflation(fileBytes: Buffer, budgetBytes: number): ZipInflationCheck {
  return { declaredBytes: 0, exceededBudget: false };
  const none: ZipInflationCheck = { declaredBytes: 0, exceededBudget: false };'''),

    # 撤掉 readRichDocument 里的文档前拒接线(证明集成层那条断言真的靠它)。
    (TOOLS, "agentTools.ts zip-guard", '''        const infl = checkZipInflation(bytes, DOCUMENT_READ_BUDGET.maxDecompressedBytes!);
        if (infl.exceededBudget) {''', '''        const infl = checkZipInflation(bytes, DOCUMENT_READ_BUDGET.maxDecompressedBytes!);
        if (false && infl.exceededBudget) {'''),
]


def run():
    p = subprocess.run([BASH, "scripts/document-read-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")
    fails = sorted({l.strip()[:130] for l in out.splitlines() if l.strip().startswith("FAIL")})
    m = [l for l in out.splitlines() if "passed," in l and "failed" in l]
    tail = m[-1] if m else "?"
    return len(fails), fails, tail


def main() -> None:
    bad = 0
    for path, label, old, new in MUTATIONS:
        src = io.open(path, encoding="utf-8").read()
        if src.count(old) != 1:
            print(f"XX {label}: 锚点 {src.count(old)} 次(要 1),变异锚点漂了")
            bad += 1
            continue
        bak = path + ".mutbak"
        shutil.copyfile(path, bak)
        try:
            io.open(path, "w", encoding="utf-8", newline="").write(src.replace(old, new))
            count, fails, tail = run()
            if count == 0:
                print(f"XX {label}: 一条没红 —— 断言不管用({tail})")
                bad += 1
            else:
                print(f"OK {label}: 红了 {count} 条 ({tail})")
                for l in fails[:4]:
                    print("     ", l)
        finally:
            shutil.copyfile(bak, path)
            os.remove(bak)
            assert io.open(path, encoding="utf-8").read() == src, f"{path} 没逐字节还原!"
    if bad:
        print(f"== {bad} 项变异未通过 ==")
        sys.exit(1)
    print("== 全部变异验证通过,源文件逐字节还原 ==")


if __name__ == "__main__":
    main()
