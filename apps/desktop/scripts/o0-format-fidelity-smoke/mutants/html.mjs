/**
 * O0 变异构造器 —— HTML。
 *
 *  - `delete-svg`：删掉内联 `<svg>` 元素 → 期望 `html.inline-svg` 红；
 *  - `relocate-svg`：把 `<svg>` 挪到 `<script>` 之后（内容不变）→ 期望
 *    `html.part-order` 红（部件还在、位置变了）；
 *  - `delete-style-block`：删掉 `<style>` → 期望 `html.style-blocks` 红。
 */
import { readFileSync, writeFileSync } from "node:fs";

export async function buildHtmlMutants(baselineCopy, outDir) {
  const text = readFileSync(baselineCopy, "utf8");
  const cases = [];

  const svgMatch = /<svg\b[\s\S]*?<\/svg>/i.exec(text);
  if (!svgMatch) throw new Error("html 变异：基线没有内联 svg");

  // ── delete svg ──
  {
    const next = text.replace(svgMatch[0], "");
    const out = `${outDir}/svg-deleted.html`;
    writeFileSync(out, next, "utf8");
    cases.push({ mutation: "delete-svg", file: out, expect: ["html.inline-svg"], detail: "删掉内联 <svg> 元素" });
  }

  // ── relocate svg: 从原处拿掉，插到 </script> 之后 ──
  {
    const withoutSvg = text.replace(svgMatch[0], "");
    const scriptEnd = withoutSvg.search(/<\/script>/i);
    if (scriptEnd < 0) throw new Error("html 变异：基线没有内联 <script>");
    const insertAt = scriptEnd + "</script>".length;
    const next = withoutSvg.slice(0, insertAt) + "\n" + svgMatch[0] + withoutSvg.slice(insertAt);
    const out = `${outDir}/svg-relocated.html`;
    writeFileSync(out, next, "utf8");
    cases.push({
      mutation: "relocate-svg",
      file: out,
      expect: ["html.part-order"],
      detail: "内联 <svg> 内容不变，从 <script> 之前挪到之后",
    });
  }

  // ── delete style ──
  {
    const styleMatch = /<style\b[^>]*>[\s\S]*?<\/style>/i.exec(text);
    if (!styleMatch) throw new Error("html 变异：基线没有 <style>");
    const out = `${outDir}/style-deleted.html`;
    writeFileSync(out, text.replace(styleMatch[0], ""), "utf8");
    cases.push({ mutation: "delete-style-block", file: out, expect: ["html.style-blocks"], detail: "删掉 <style> 元素" });
  }

  // ── 内容级：样式表里一个声明改值（<style> 还在、样式变了）──
  {
    const next = text.replace("border: 1px solid #336699", "border: 3px dotted #ff0000");
    if (next === text) throw new Error("html 变异：找不到样式声明");
    const out = `${outDir}/style-declaration-changed.html`;
    writeFileSync(out, next, "utf8");
    cases.push({
      mutation: "change-style-declaration",
      file: out,
      expect: ["html.style-blocks"],
      detail: "样式表里 border 的宽度/样式/颜色改掉（<style> 仍在原处）",
    });
  }

  // ── 内容级：内联脚本改一处（<script> 还在、行为变了）──
  {
    const next = text.replace('return "o0-script-alive"', 'return "o0-script-mutated"');
    if (next === text) throw new Error("html 变异：找不到脚本内容");
    const out = `${outDir}/script-content-changed.html`;
    writeFileSync(out, next, "utf8");
    cases.push({
      mutation: "change-script-content",
      file: out,
      expect: ["html.script-blocks"],
      detail: "内联脚本的返回值改掉（<script> 仍在原处）",
    });
  }

  // ── 内容级：SVG 里圆的半径改掉（<svg> 还在、图形变了）──
  {
    const next = text.replace('r="18"', 'r="9"');
    if (next === text) throw new Error("html 变异：找不到 SVG 圆半径");
    const out = `${outDir}/svg-geometry-changed.html`;
    writeFileSync(out, next, "utf8");
    cases.push({
      mutation: "change-svg-geometry",
      file: out,
      expect: ["html.inline-svg"],
      detail: "内联 SVG 的 circle 半径 18→9（元素结构不变、图形变了）",
    });
  }

  return cases;
}
