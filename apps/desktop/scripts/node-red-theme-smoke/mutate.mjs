import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
if (!file) throw new Error("expected isolated copy path");
const source = readFileSync(file, "utf8");
const needle = 'editorTheme: { page: { css: process.env.MCODE_ENGINE_THEME_CSS || "" } },';
if (source.split(needle).length !== 2) throw new Error("unexpected bootstrap structure");
writeFileSync(file, source.replace(needle, "// T47 mutation: theme registration removed"), "utf8");
