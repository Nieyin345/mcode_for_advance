import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
if (!file) throw new Error("expected isolated copy path");
const source = readFileSync(file, "utf8");

/* 【AUTO/Q9b】`editorTheme.page.css` 从单值改成了数组（宿主主题 + 画布外壳样式）。
 * 变异要跟着改形状，否则它会抛「unexpected bootstrap structure」——
 * 那样 run.sh 里"变异必须变红"仍然成立，但红的是脚本自己，而不是外观判据
 * （CLAUDE.md 第十六条：红了但红错地方）。
 *
 * 变异做的事情没变：**把宿主主题从 page.css 里拿掉**。 */
const needle = "process.env.MCODE_ENGINE_THEME_CSS || \"\"";
if (source.split(needle).length !== 2) throw new Error("unexpected bootstrap structure");
writeFileSync(file, source.replace(needle, '""'), "utf8");
