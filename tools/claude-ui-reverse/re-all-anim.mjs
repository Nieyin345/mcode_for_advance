import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = "C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1";
const files = readdirSync(dir).filter(f => f.endsWith(".css"));

const kf = new Map();
for (const f of files) {
  const txt = readFileSync(join(dir, f), "utf8");
  const re = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let m;
  while ((m = re.exec(txt))) {
    let d = 1, i = re.lastIndex;
    while (i < txt.length && d > 0) { if (txt[i]==="{") d++; else if (txt[i]==="}") d--; i++; }
    if (!kf.has(m[1])) kf.set(m[1], { file: f, body: txt.slice(re.lastIndex, i-1) });
  }
}

// 收集所有 animation: 声明 → 谁用了哪个 keyframes + 时长/缓动
const uses = new Map();
for (const f of files) {
  const txt = readFileSync(join(dir, f), "utf8");
  const re = /([^{}]{0,200})\{([^{}]{0,600}animation[^{}]{0,600})\}/g;
  let m;
  while ((m = re.exec(txt))) {
    const anim = /animation(?:-name)?\s*:\s*([^;]+)/.exec(m[2]);
    if (!anim) continue;
    for (const name of kf.keys()) {
      if (!new RegExp("(^|[\s,])" + name + "([\s,]|$)").test(anim[1])) continue;
      if (!uses.has(name)) uses.set(name, []);
      const sel = m[1].trim().split("}").pop().trim();
      uses.get(name).push({ sel: sel.slice(-120), decl: anim[1].trim().slice(0,140) });
    }
  }
}

const lines = [];
lines.push("# Claude 3.6556.2.0 —— 动画与转场（逆向）");
lines.push("");
lines.push("来源：`ion-dist/assets/v1/*.css`（25 个文件）的 `@keyframes` 与 `animation:` 声明。");
lines.push("生成脚本：`re-all-anim.mjs`。");
lines.push("");
lines.push("**这份数据此前不存在** —— 逆向报告只覆盖了 token / 几何 / 颜色 / 图标，");
lines.push("动画层完全空白。Mcode 的 `live-eq`（回合状态行的三个点）就是凭印象写的：");
lines.push("上一版是竖条 + scaleY，真身是 2.82px 圆点 + 纯不透明度三段式。");
lines.push("");
lines.push("共 " + kf.size + " 个 keyframes。");
lines.push("");
lines.push("## 状态指示器相关的（逐条全文）");
lines.push("");
const interesting = [...kf.keys()].filter(n => /dot|pulse|breath|blink|typing|bounce|eq|caret|cursor|think|shimmer|spin/i.test(n)).sort();
for (const n of interesting) {
  const { file, body } = kf.get(n);
  lines.push("### `" + n + "`");
  lines.push("");
  lines.push("来源：`" + file + "`");
  lines.push("");
  lines.push("```css");
  lines.push("@keyframes " + n + " {" + body.trim() + "}");
  lines.push("```");
  lines.push("");
  const u = uses.get(n) ?? [];
  if (u.length) {
    lines.push("用在：");
    for (const x of u.slice(0, 6)) lines.push("- `" + x.sel + "` → `animation: " + x.decl + "`");
    lines.push("");
  }
}
lines.push("## 全部 keyframes 名（按字母序）");
lines.push("");
lines.push([...kf.keys()].sort().map(n => "`" + n + "`").join(" · "));

writeFileSync("tools/claude-ui-reverse/animations.txt", lines.join("\n"), "utf8");
console.log("wrote tools/claude-ui-reverse/animations.txt");
console.log("keyframes:", kf.size, "| interesting:", interesting.length);
