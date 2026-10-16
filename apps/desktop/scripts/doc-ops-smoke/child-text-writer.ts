/**
 * 【MC-024 E1 跨进程夹具】—— 一个**独立 OS 进程**的文本文件编辑者。
 *
 * 由 `main.ts` 用 `spawn(process.execPath, [child.mjs, file, marker, startAtMs])`
 * 各起一个:两个真正独立的进程都对**同一份**文本做「读-改-写」。
 *
 * ## 刻意复刻台账的失败反例形状
 *
 * 台账原文:「A/B 都读旧 X,各自生成 Y/Z,A/B 都在替换前验证 X,然后依次 rename →
 * Y 结果丢失」。所以这里**先读、再验证、留一个窗口、才 rename** —— 两个进程都可能
 * 在对方 rename 之前通过验证。修复前(只有进程内 Map),两条都通过、后 rename 的
 * 覆盖前者 → 一个标记消失;修复后(宿主级租约把整个读-改-写串行),第二个进程要么
 * 排到 A 完成后读到**新内容**、要么自己的版本校验看到变化。
 *
 * ⚠️ 验证用的哈希是**进入租约后立刻读取的**那份 —— 不能在验证后立即 rename(那样
 * 竞态窗口趋近于零、测不出缺锁),也不能省掉验证(那样租约修没修都可能红)。窗口
 * 由 `HOLD_MS` 明确留出。
 *
 * 输出一行 JSON 到 stdout:`{"ok":true,"marker":"PROC_X"}` 或 `{"ok":false,"error":"..."}`。
 */
import { promises as fs } from "node:fs";
import { withAgentTextFileLease } from "@main/mcp/agentTextFiles.js";

const [file, marker, startAtMs] = process.argv.slice(2);
if (!file || !marker) {
  process.stdout.write(JSON.stringify({ ok: false, error: "用法: child-text-writer <file> <marker> [startAtMs]" }) + "\n");
  process.exit(2);
}

/** 验证通过后、rename 之前的停留窗口:让竞态真的可发生(否则测不出缺锁)。 */
const HOLD_MS = 400;

(async () => {
  const at = Number(startAtMs);
  if (Number.isFinite(at)) {
    const wait = at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await withAgentTextFileLease(file, async (real) => {
    // 读 + 验证 + 写临时文件 + 停留 + rename 全在租约内 —— 与生产 `agent_edit_file`
    // 的读-改-写同形状(见 agentTools.ts 的 withAgentTextFileLease 用法)。
    const buf = await fs.readFile(real);
    const content = buf.toString("utf8");
    const next = `${content}${marker}\n`;
    const temp = `${real}.mcode-edit-${marker}`;
    await fs.writeFile(temp, next, { encoding: "utf8", flag: "wx" });
    try {
      // 验证与 rename 之间刻意留窗口(复刻台账反例的时序);租约在,别的进程进不来,
      // 这个窗口是安全的;租约不在,两条都能穿过它 → 后者覆盖前者。
      await new Promise((r) => setTimeout(r, HOLD_MS));
      const now = await fs.readFile(real);
      if (now.toString("utf8") !== content) {
        throw new Error("FILE_VERSION_CONFLICT:文件已被其他操作修改；本次未覆盖");
      }
      await fs.rename(temp, real);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  });
  process.stdout.write(JSON.stringify({ ok: true, marker }) + "\n");
})().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
  process.exitCode = 1;
});
