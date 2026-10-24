/**
 * O0 变异构造器 —— Markdown。
 *
 *  - `delete-code-block`：删掉围栏代码块 → 期望 `md.code-blocks` 红；
 *  - `relocate-image`:把图片引用挪到文件末尾（内容不变）→ 期望 `md.part-order` 红
 *    （部件还在、位置变了）。
 */
import { readFileSync, writeFileSync } from "node:fs";

export async function buildMarkdownMutants(baselineCopy, outDir) {
  const text = readFileSync(baselineCopy, "utf8");
  const cases = [];

  // ── delete code block ──
  {
    const next = text.replace(/```[\s\S]*?```\n?/g, "");
    if (next === text) throw new Error("markdown 变异：基线没有代码块");
    const out = `${outDir}/code-block-deleted.md`;
    writeFileSync(out, next, "utf8");
    cases.push({ mutation: "delete-code-block", file: out, expect: ["md.code-blocks"], detail: "删掉 ``` 围栏代码块" });
  }

  // ── relocate image ──
  {
    const imgLine = text.split(/\r?\n/).find((l) => /!\[[^\]]*\]\([^)]*\)/.test(l));
    if (!imgLine) throw new Error("markdown 变异：基线没有图片引用");
    const next = text.replace(imgLine + "\n", "") + "\n" + imgLine + "\n";
    if (next === text) throw new Error("markdown 变异：移动图片引用没有产生字节变化");
    const out = `${outDir}/image-relocated.md`;
    writeFileSync(out, next, "utf8");
    cases.push({
      mutation: "relocate-image",
      file: out,
      expect: ["md.part-order"],
      detail: "图片引用内容不变，挪到文件末尾",
    });
  }

  // ── 内容级：表格单元格改一个词（表格还在、内容变了）──
  {
    const next = text.replace("O0-MD-R1A", "O0-MD-R1A-EDITED");
    if (next === text) throw new Error("markdown 变异：找不到表格单元格标记");
    const out = `${outDir}/table-cell-changed.md`;
    writeFileSync(out, next, "utf8");
    cases.push({ mutation: "change-table-cell", file: out, expect: ["md.tables"], detail: "表格单元格文字改一个词" });
  }

  // ── 内容级：嵌套列表的缩进被抹平（条目都在、层级变了）──
  {
    const next = text.replace(/^  - /m, "- ");
    if (next === text) throw new Error("markdown 变异：找不到嵌套列表缩进");
    const out = `${outDir}/nested-list-flattened.md`;
    writeFileSync(out, next, "utf8");
    cases.push({
      mutation: "flatten-nested-list",
      file: out,
      expect: ["md.nested-list"],
      detail: "内层列表项的缩进被抹掉（文字都在、层级从 1 变 0）",
    });
  }

  return cases;
}
