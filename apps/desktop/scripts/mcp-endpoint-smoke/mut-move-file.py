"""变异验证(台账 MC-068):把 agent_move_file 的 handler 退回「先删目标再 rename」的危险顺序,
看新加的数据保全断言真的红。逐字节还原后须转绿。"""
import io, os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
DESK = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(DESK, "src", "main", "mcp", "agentTools.ts")
GIT_BASH = r"C:\Program Files\Git\usr\bin\bash.EXE"
BASH = GIT_BASH if os.path.exists(GIT_BASH) else "bash"

OLD = '''      handler: (args: { source: string; destination: string; overwrite?: boolean }, ctx) =>
        attemptStructured(async () => {
          const source = pOf(ctx, args.source);
          const destination = pOf(ctx, args.destination);
          // 安全移动协议(预检 → 暂存旧目标 → 提交 → 失败恢复)只有一份,见 moveFileSafe。
          const r = await moveFileSafe(source, destination, { overwrite: args.overwrite === true });
          const fields: Record<string, unknown> = {
            committed: r.committed,
            sourcePreserved: r.sourcePreserved,
            destinationPreserved: r.destinationPreserved,
            recoverable: r.recoverable,
            phase: r.phase,
            commitOutcome: r.commitOutcome,
            operationId: r.operationId,
          };
          if (r.backupRef) fields.backupRef = r.backupRef;
          if (r.reason) fields.reason = r.reason;
          // 成功 = 内容已稳定 durable 且没有需要人工收拾的残留(源/目标相同这类 no-op 也算成功)。
          // 部分完成(PARTIALLY_APPLIED)、不确定(UNCERTAIN)走 isError,但结构化字段照带 —— 调用者
          // 能据此看出「目标其实已经出现了」,不会误当完全没发生而重跑。
          const ok = isMoveDurable(r);
          return { text: r.message, structured: fields, isError: !ok };
        }),'''

NEW = '''      handler: (args: { source: string; destination: string; overwrite?: boolean }, ctx) =>
        attempt(async () => {
          const source = pOf(ctx, args.source);
          const destination = pOf(ctx, args.destination);
          const src = await fs.lstat(source).catch(() => null);
          if (!src) throw new Error(`原路径不存在:${source}`);
          const dest = await fs.lstat(destination).catch(() => null);
          if (dest && !args.overwrite) throw new Error(`目标已存在:${destination}；确认覆盖时传 overwrite=true`);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          if (dest) await fs.rm(destination, { recursive: true, force: true });
          try {
            await fs.rename(source, destination);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
            await fs.cp(source, destination, { recursive: true, force: true });
            await fs.rm(source, { recursive: true, force: true });
          }
          return `已移动 ${source} -> ${destination}`;
        }),'''

def run():
    p = subprocess.run([BASH, "scripts/mcp-endpoint-smoke/run.sh"], cwd=DESK, capture_output=True)
    out = p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")
    fails = sorted({l.strip() for l in out.splitlines() if l.strip().startswith("✗")})
    return len(fails), fails, ("通过" in out and "/" in out), out

src = io.open(SRC, encoding="utf-8").read()
n = src.count(OLD)
if n != 1:
    print(f"!! 锚点 {n} 次(要 1) —— 变异锚点随源码漂移了"); sys.exit(2)
bak = SRC + ".mutbak"; shutil.copyfile(SRC, bak)
try:
    io.open(SRC, "w", encoding="utf-8", newline="").write(src.replace(OLD, NEW))
    c, f, ok, out = run()
    if not ok:
        print(f"XX 没跑出结论\n{out[-400:]}"); sys.exit(1)
    if c == 0:
        print("XX 一条没红 —— 断言不管用"); sys.exit(1)
    print(f"OK 还原危险 rm-before-rename: 红了 {c} 条")
    for l in f[:6]:
        print("   ", l[:130])
finally:
    shutil.copyfile(bak, SRC); os.remove(bak)
    assert io.open(SRC, encoding="utf-8").read() == src, "没逐字节还原!"
    print("已逐字节还原 agentTools.ts")
