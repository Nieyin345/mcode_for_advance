/**
 * O0 变异构造器 —— XLSX。
 *
 *  - `delete-conditional-format`：删掉 `<conditionalFormatting>` → 期望
 *    `xlsx.conditional-formats-any` 红；
 *  - `delete-merge`：删掉 `<mergeCell>` → 期望 `xlsx.merges-any` 红；
 *  - `relocate-chart-anchor`：图表锚点从 E2 挪到 G20 → 期望 `xlsx.drawing:*` 红
 *    （图表还在、内容没变、位置变了）。
 *
 * 直接改 worksheet / drawing 的 XML 字节。
 */
import JSZip from "../../../../../genoffice/node_modules/jszip/lib/index.js";
import { readFileSync, writeFileSync } from "node:fs";

export async function buildXlsxMutants(baselineCopy, outDir) {
  const cases = [];
  const entries = Object.keys((await JSZip.loadAsync(readFileSync(baselineCopy))).files).filter(Boolean);

  const writeVariant = async (name, mutate) => {
    const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
    const applied = await mutate(zip);
    if (!applied) throw new Error(`xlsx 变异 ${name}：目标 XML 片段不存在`);
    const out = `${outDir}/${name}.xlsx`;
    writeFileSync(out, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
    return out;
  };

  // 找条件格式所在的 worksheet（内容里带 conditionalFormatting）
  let cfPart = null;
  let mergePart = null;
  {
    const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
    for (const p of entries.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))) {
      const xml = await zip.file(p).async("string");
      if (xml.includes("<conditionalFormatting")) cfPart = p;
      if (xml.includes("<mergeCell ")) mergePart = p;
    }
  }
  if (!cfPart) throw new Error("xlsx 变异：找不到带条件格式的 worksheet");
  if (!mergePart) throw new Error("xlsx 变异：找不到带 mergeCell 的 worksheet");

  cases.push({
    mutation: "delete-conditional-format",
    file: await writeVariant("cf-deleted", async (zip) => {
      const xml = await zip.file(cfPart).async("string");
      const next = xml.replace(/<conditionalFormatting\b[\s\S]*?<\/conditionalFormatting>/g, "");
      if (next === xml) return false;
      zip.file(cfPart, next);
      return true;
    }),
    expect: ["xlsx.conditional-formats-any", "xlsx.features"],
    detail: `删掉 ${cfPart} 里的 conditionalFormatting`,
  });

  cases.push({
    mutation: "delete-merge",
    file: await writeVariant("merge-deleted", async (zip) => {
      const xml = await zip.file(mergePart).async("string");
      const next = xml.replace(/<mergeCells\b[\s\S]*?<\/mergeCells>/g, "");
      if (next === xml) return false;
      zip.file(mergePart, next);
      return true;
    }),
    expect: ["xlsx.merges-any", "xlsx.features"],
    detail: `删掉 ${mergePart} 里的 mergeCells`,
  });

  // ── 公式挪到别的单元格（卡 §4 的原例：内容不变、位置变了）──
  {
    // 找到写 `=B2*C2` 的 worksheet，把它换成 `=C2*D2` 放在 E2 —— 公式**文本**没变，
    // 所在地址与引用的列变了；`xlsx.formula-cells` 的 ref/formula 都必须红。
    let formulaPart = null;
    {
      const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
      for (const p of entries.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))) {
        const xml = await zip.file(p).async("string");
        if (xml.includes("<f>B2*C2</f>") || xml.includes("<f B2*C2</f>")) { formulaPart = p; break; }
        if (/<f[^>]*>B2\*C2<\/f>/.test(xml)) { formulaPart = p; break; }
      }
    }
    if (formulaPart) {
      cases.push({
        mutation: "relocate-formula-cell",
        file: await writeVariant("formula-moved", async (zip) => {
          const xml = await zip.file(formulaPart).async("string");
          // 把 D2 的公式单元格整段搬成 E2 —— **必须留在同一 <row> 里**：`<c>` 是
          // `<row>` 的子元素，直接插到 </sheetData> 前会造出非法工作簿（引擎报
          // `XML Error: invalid digit found in string`，那样的红证明不了判据）。
          const cellRe = /<c r="D2"([^>]*)>([\s\S]*?)<\/c>/;
          const match = cellRe.exec(xml);
          if (!match) return false;
          const moved = `<c r="E2"${match[1]}>${match[2]}</c>`;
          let next = xml.replace(cellRe, "");
          const rowEnd = next.indexOf("</row>", next.indexOf('<row r="2"'));
          if (rowEnd < 0) return false;
          next = next.slice(0, rowEnd) + moved + next.slice(rowEnd);
          if (next === xml) return false;
          zip.file(formulaPart, next);
          return true;
        }),
        expect: ["xlsx.formula-cells"],
        detail: "公式 =B2*C2 从 D2 挪到同一行的 E2（公式文本不变，地址变了）",
      });
    }
  }

  // 图表锚点：drawing1.xml 的 <xdr:from><xdr:col>4</xdr:col><xdr:row>1</xdr:row> → 挪到 (6,20)
  let drawPart = null;
  {
    const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
    for (const p of entries.filter((x) => /^xl\/drawings\/drawing\d+\.xml$/.test(x))) {
      const xml = await zip.file(p).async("string");
      if (/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)/.test(xml)) drawPart = p;
    }
  }
  if (drawPart) {
    cases.push({
      mutation: "relocate-chart-anchor",
      file: await writeVariant("chart-anchor-moved", async (zip) => {
        const xml = await zip.file(drawPart).async("string");
        const fromMatch = /<xdr:from>[\s\S]*?<\/xdr:from>/.exec(xml);
        if (!fromMatch) return false;
        const moved = "<xdr:from><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>25</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>";
        zip.file(drawPart, xml.replace(fromMatch[0], moved));
        return true;
      }),
      expect: [`xlsx.drawing:${drawPart}`],
      detail: `图表锚点从原格挪到 (col 8, row 25)`,
    });
  }

  // ── 内容级：交叉 sheet 公式改一处（公式单元格还在、语义变了）──
  {
    const zip0 = await JSZip.loadAsync(readFileSync(baselineCopy));
    let formulaSheet = null;
    for (const p of entries.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))) {
      const xml = await zip0.file(p).async("string");
      if (xml.includes("SUM(") || xml.includes("Data!")) formulaSheet = p;
    }
    if (formulaSheet) {
      cases.push({
        mutation: "change-cross-sheet-formula",
        file: await writeVariant("formula-changed", async (zip) => {
          const xml = await zip.file(formulaSheet).async("string");
          const next = xml.replace(/<f>([^<]*Data!D2:D4[^<]*)<\/f>/, "<f>SUM(Data!D2:D3)</f>");
          if (next === xml) return false;
          zip.file(formulaSheet, next);
          return true;
        }),
        expect: ["xlsx.formula-cells"],
        detail: "跨 sheet 公式 SUM(Data!D2:D4) 改成 SUM(Data!D2:D3)（地址不变、语义变了）",
      });
    }
  }

  return cases;
}
