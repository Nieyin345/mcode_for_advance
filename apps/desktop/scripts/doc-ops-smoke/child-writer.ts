/**
 * 【MC-069 E1 跨进程夹具】—— 一个**独立 OS 进程**的 Excel 写入者。
 *
 * 由 `main.ts` 用 `spawn(process.execPath, [child.mjs, file, range, value])` 各起一个:
 * 两个真正独立的进程都对**同一份** Excel 做「读-改-写不同单元格」。断言「两份修改都在」。
 * 走的是与生产同一份 `editExcelRange`(不重写机制),这样才证明跨进程文件租约真的生效。
 *
 * 输出一行 JSON 到 stdout:`{"ok":true}` 或 `{"ok":false,"error":"..."}`。
 */
import { editExcelRange } from "@main/mcp/agentDocumentOps.js";

const [file, range, value] = process.argv.slice(2);
if (!file || !range || value === undefined) {
  process.stdout.write(JSON.stringify({ ok: false, error: "用法: child-writer <file> <range> <value>" }) + "\n");
  process.exit(2);
}

editExcelRange({ path: file, range, content: [[value]] })
  .then(() => { process.stdout.write(JSON.stringify({ ok: true }) + "\n"); })
  .catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
    process.exitCode = 1;
  });
