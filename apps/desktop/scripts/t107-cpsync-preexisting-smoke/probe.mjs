/**
 * 【T107】子进程探针：复现「非 ASCII 源 + 目标已有同名文件」的 cpSync 失败，
 * 并在同一个夹具上对比三种修法。
 *
 * 用法：`probe.mjs <base> <fix>`
 *   base —— 一个目录，探针在里面建 `src/` 与 `dst/`。**base 是否含非 ASCII 由调用方决定**。
 *   fix  —— `none` / `delete-first` / `temp-rename` / `manual`
 *
 * 输出一行 `key=value | key=value ...`，父进程解析。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [base, fix] = process.argv.slice(2);
if (!base || !fix) {
  console.error("用法：probe.mjs <base> <fix>");
  process.exit(2);
}

const SRC = join(base, "src");
const DST = join(base, "dst");
rmSync(base, { recursive: true, force: true });

// 源：目录 + 嵌套文件，内容是 NEW
mkdirSync(join(SRC, "sub"), { recursive: true });
writeFileSync(join(SRC, "top.txt"), "NEW");
writeFileSync(join(SRC, "sub", "inner.txt"), "NEW");

// 目标：**已存在**同名文件（触发条件），内容是 OLD
mkdirSync(join(DST, "sub"), { recursive: true });
writeFileSync(join(DST, "top.txt"), "OLD");
writeFileSync(join(DST, "sub", "inner.txt"), "OLD");

/** 手写递归 —— 不碰 cpSync 的 native 路径。 */
function manualCopy(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) manualCopy(join(from, name), join(to, name));
  } else {
    copyFileSync(from, to);
  }
}

let result = "OK";
try {
  if (fix === "none") {
    cpSync(SRC, DST, { recursive: true, filter: () => true });
  } else if (fix === "delete-first") {
    rmSync(DST, { recursive: true, force: true });
    cpSync(SRC, DST, { recursive: true, filter: () => true });
  } else if (fix === "temp-rename") {
    const staging = `${DST}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(SRC, staging, { recursive: true, filter: () => true });
    rmSync(DST, { recursive: true, force: true });
    renameSync(staging, DST);
  } else if (fix === "manual") {
    manualCopy(SRC, DST);
  } else {
    result = "UNKNOWN_FIX";
  }
} catch (error) {
  const err = error;
  // 注意：这个错的信息可能是「The operation completed successfully」——
  // 上游 #54476 的同一族缺陷。把 code/errno 都打出来，别只信 message。
  result = `THREW code=${err.code ?? "?"} errno=${err.errno ?? "?"}`;
}

const top = existsSync(join(DST, "top.txt")) ? readFileSync(join(DST, "top.txt"), "utf8") : "missing";
const inner = existsSync(join(DST, "sub", "inner.txt")) ? readFileSync(join(DST, "sub", "inner.txt"), "utf8") : "missing";
const srcIntact = existsSync(join(SRC, "top.txt")) && readFileSync(join(SRC, "top.txt"), "utf8") === "NEW";
const leftovers = readdirSync(base).filter((n) => n !== "src" && n !== "dst");

console.log(`${result} | top=${top} | inner=${inner} | srcIntact=${srcIntact} | leftovers=${JSON.stringify(leftovers)}`);
rmSync(base, { recursive: true, force: true });
