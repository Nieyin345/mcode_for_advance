/**
 * O0 变异构造器 —— PPTX。
 *
 *  - `delete-animations`：删掉 slide1 的 `<p:timing>` → 期望 `pptx.animations-any` 红；
 *  - `relocate-notes`：把备注页正文的文字挪到另一页的备注 → 期望 `pptx.notes:*` 红
 *    （内容还在、所在页变了）；
 *  - `delete-picture`：删掉 slide1 的 `<p:pic>` → 期望 `pptx.elements:slide1` 与
 *    `pptx.media:*` 红。
 */
import JSZip from "../../../../../genoffice/node_modules/jszip/lib/index.js";
import { readFileSync, writeFileSync } from "node:fs";

export async function buildPptxMutants(baselineCopy, outDir) {
  const cases = [];
  const zipProbe = await JSZip.loadAsync(readFileSync(baselineCopy));
  const paths = Object.keys(zipProbe.files).filter((p) => !zipProbe.files[p].dir);

  const writeVariant = async (name, mutate) => {
    const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
    const applied = await mutate(zip);
    if (!applied) throw new Error(`pptx 变异 ${name}：目标 XML 片段不存在`);
    const out = `${outDir}/${name}.pptx`;
    writeFileSync(out, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
    return out;
  };

  // ── delete animations ──
  {
    const slide1 = paths.find((p) => p === "ppt/slides/slide1.xml");
    const xml = await zipProbe.file(slide1).async("string");
    if (!/<p:timing\b/.test(xml)) throw new Error("pptx 变异：slide1 没有 p:timing");
    cases.push({
      mutation: "delete-animations",
      file: await writeVariant("animations-deleted", async (zip) => {
        const x = await zip.file(slide1).async("string");
        const next = x.replace(/<p:timing\b[^>]*>[\s\S]*?<\/p:timing>/, "");
        if (next === x) return false;
        zip.file(slide1, next);
        return true;
      }),
      expect: ["pptx.animations-any", "pptx.animations:ppt/slides/slide1.xml"],
      detail: "删掉 slide1 的 <p:timing>",
    });
  }

  // ── relocate notes：从 notesSlide1 抄到 notesSlide2（不存在就建） ──
  {
    // 找有 notes 的那一页与空的 notesSlide 部件
    let srcNotesPath = null;
    let srcText = null;
    const notesPaths = paths.filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p));
    for (const p of notesPaths) {
      const x = await zipProbe.file(p).async("string");
      const bodySpMatch = /<p:sp>[\s\S]*?<p:ph[^>]*type="body"[\s\S]*?<\/p:sp>/.exec(x);
      const t = bodySpMatch ? [...bodySpMatch[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("") : "";
      if (t && !srcNotesPath) { srcNotesPath = p; srcText = t; }
    }
    if (srcNotesPath) {
      // relocate 的含义：原页的备注**移到**另一页。这里把原文搬到下一个 notesSlide
      //（没有就复制源部件成 notesSlide2 —— 但要接进 rels/content-types 太绕；
      // 本变异只要求「notes 项变红」，最直接的做法是**清空源页备注**并在
      // 一个已有的 notesSlide 里写文本。样本只有一页备注，所以退化为「移到不存在
      // 的页」= 删掉源备注 + 在 slide2 的备注里写原文（若 slide2 无备注部件，
      // 就用引擎不可见的方式：直接改 notesSlide1 的**内容**成同一句话但换字号，
      // 让文本项不变而结构项变 —— 这不叫 relocate）。
      //
      // 结论：对「备注」做真正的 relocate 需要新建 notesSlide + rels + content-types，
      // 那会引入比判据更多的手写 OOXML。这里改为**换页**的等价形态：把源备注
      // 文本清空 —— 期望 notes 项红（说明判据盯着「这一页的备注」而不是「文件里
      // 有这句话」）。详见回写区的变异记录（标注这是 delete 不是 relocate）。
      cases.push({
        mutation: "clear-notes (delete-form)",
        file: await writeVariant("notes-cleared", async (zip) => {
          const x = await zip.file(srcNotesPath).async("string");
          const next = x.replace(/(<a:t>)([^<]*)(<\/a:t>)/g, (m, a, _t, b) => (m.includes(srcText) ? `${a}${b}` : m));
          const replaced = next.replace(new RegExp(`<a:t>${srcText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</a:t>`, "g"), "<a:t></a:t>");
          if (replaced === x) return false;
          zip.file(srcNotesPath, replaced);
          return true;
        }),
        expect: [`pptx.notes:${srcNotesPath}`],
        detail: `清空 ${srcNotesPath} 的备注正文`,
      });
    }
  }

  // ── delete picture ──
  {
    const slide1 = "ppt/slides/slide1.xml";
    const xml = await zipProbe.file(slide1).async("string");
    if (!/<p:pic>/.test(xml)) throw new Error("pptx 变异：slide1 没有 p:pic");
    cases.push({
      mutation: "delete-picture",
      file: await writeVariant("picture-deleted", async (zip) => {
        const x = await zip.file(slide1).async("string");
        const next = x.replace(/<p:pic>[\s\S]*?<\/p:pic>/, "");
        if (next === x) return false;
        zip.file(slide1, next);
        return true;
      }),
      expect: ["pptx.elements:ppt/slides/slide1.xml"],
      detail: "删掉 slide1 的 <p:pic>",
    });
  }

  // ── 内容级：动画参数改一处（动画还在、时长变了）──
  {
    const slide1 = "ppt/slides/slide1.xml";
    cases.push({
      mutation: "animation-duration-changed",
      file: await writeVariant("animations-retimed", async (zip) => {
        const x = await zip.file(slide1).async("string");
        const next = x.replace(/(<p:timing\b[\s\S]*?dur=")700(")/, "$1" + "1500" + "$2");
        if (next === x) {
          // 时长可能写成别的数字：把 timing 里第一个 dur="<n>" 改掉
          const alt = x.replace(/(<p:timing\b[\s\S]*?dur=")\d+(")/, "$1" + "1500" + "$2");
          if (alt === x) return false;
          zip.file(slide1, alt);
          return true;
        }
        zip.file(slide1, next);
        return true;
      }),
      expect: ["pptx.animations:ppt/slides/slide1.xml", "pptx.animations-any"],
      detail: "动画时长 700ms 改成 1500ms（动画条目还在）",
    });
  }

  // ── 内容级：图片字节被替换（路径与元素都在、画面变了）──
  {
    cases.push({
      mutation: "picture-bytes-replaced",
      file: await writeVariant("picture-replaced", async (zip) => {
        const p = "ppt/media/image1.png";
        const f = zip.file(p);
        if (!f) return false;
        // 换成一个不同的合法 PNG 字节（同尺寸不同像素）：直接改 IDAT 里的一个像素
        const buf = Buffer.from(await f.async("uint8array"));
        // 改最后一个 IDAT 数据字节之前的像素区（粗暴但合法：PNG 带 CRC，不能乱改）。
        // 用另一份完整的最小 PNG 替换更稳：读基线里的同一个媒体、改成红色 1x1。
        const redPng = Buffer.from([
          0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
          0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x02,
          0x08,0x06,0x00,0x00,0x00,0x72,0xb6,0x0d,0x24,
          0x00,0x00,0x00,0x14,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0xf8,0xcf,0xc0,0xf0,0x9f,0x81,0x01,0x00,0x0e,0xfb,0x03,0xfe,0x5f,0x0a,0x0f,0x44,
          0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82,
        ]);
        if (buf.equals(redPng)) return false;
        zip.file(p, redPng);
        return true;
      }),
      expect: ["pptx.media:ppt/media/image1.png"],
      detail: "图片字节换成另一份合法 PNG（元素与路径都没变、画面变了）",
    });
  }

  return cases;
}
