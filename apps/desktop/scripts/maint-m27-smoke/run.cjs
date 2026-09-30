/**
 * MAINT-2026-09 / M27 · 打包前置脚本的「失败必须是失败」冒烟
 *
 * 被测的是 `apps/desktop/build/` 下两个**打包前置**脚本的真实文件本身:
 *   - dereference-workspace-symlinks.cjs
 *   - fix-node-pty-conpty.cjs
 *
 * 为什么要测它们:`apps/desktop/package.json` 的 `package` 脚本是
 *   pnpm run build && ... && node build/dereference-workspace-symlinks.cjs && electron-builder
 * —— 用 `&&` 串起来的,**退出码就是闸门**。这两个脚本干的都是"产物能不能用"的
 * 活(工作区包实体化、conpty.dll 回填),它们一旦把失败咽下去还退 0,
 * electron-builder 就会照常打出一个缺东西的包:装上能启动,用到那部分才崩。
 *
 * 做法:把**真实脚本原文**复制进 mkdtemp 出来的假工程树里跑,不打桩、不改被测代码、
 * 不碰仓库的 node_modules,也不跑 electron-builder。
 */
"use strict";
const { spawnSync } = require("node:child_process");
const {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const buildDir = resolve(__dirname, "..", "..", "build");
let pass = 0;
let fail = 0;
const lines = [];
function check(name, cond, detail = "") {
  const text = cond ? `  ok   ${name}` : `  FAIL ${name}${detail ? ` — ${detail}` : ""}`;
  if (cond) pass++; else fail++;
  lines.push(text);
  console.log(text);
}

function runScript(scriptPath, env = {}) {
  const r = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf-8", timeout: 60000, env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 把真实脚本复制进假工程树的 build/ 下(`__dirname/..` 就是那棵树的根)。 */
function plant(root, name) {
  mkdirSync(join(root, "build"), { recursive: true });
  const dest = join(root, "build", name);
  copyFileSync(join(buildDir, name), dest);
  return dest;
}

const temps = [];
function linkEntryExists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}
function newTree(tag) {
  const d = mkdtempSync(join(tmpdir(), `mcode-maint-m27-${tag}-`));
  temps.push(d);
  return d;
}

/* ── A. dereference-workspace-symlinks.cjs ───────────────────────────── */

function derefFixture(withTarget) {
  const root = newTree("deref");
  const app = join(root, "app");
  const pkgSrc = join(root, "packages", "contracts");
  mkdirSync(join(app, "node_modules", "@mcode"), { recursive: true });
  mkdirSync(pkgSrc, { recursive: true });
  writeFileSync(join(pkgSrc, "package.json"), JSON.stringify({ name: "@mcode/contracts" }), "utf8");
  // pnpm 在 Windows 上用 junction;junction 建立时目标必须存在
  symlinkSync(pkgSrc, join(app, "node_modules", "@mcode", "contracts"),
    process.platform === "win32" ? "junction" : "dir");
  if (!withTarget) rmSync(pkgSrc, { recursive: true, force: true });
  return { app, link: join(app, "node_modules", "@mcode", "contracts"), pkgSrc };
}

{
  // A1 正常:工作区符号链接被换成真实目录拷贝
  const fx = derefFixture(true);
  const script = plant(fx.app, "dereference-workspace-symlinks.cjs");
  const r = runScript(script);
  check("deref:正常情况退出码为 0", r.code === 0, `code=${r.code} ${r.out.slice(0, 200)}`);
  check("deref:工作区包变成了真实拷贝",
    existsSync(join(fx.link, "package.json")) &&
      JSON.parse(readFileSync(join(fx.link, "package.json"), "utf8")).name === "@mcode/contracts",
    r.out.slice(0, 200));
}

{
  // A2 失败:拷贝失败(目标已不在)时必须是**硬失败**,而且不能把原来的链接删掉后不管
  const fx = derefFixture(false);
  const script = plant(fx.app, "dereference-workspace-symlinks.cjs");
  const r = runScript(script);
  check("deref:实体化失败时退出码非 0(否则 electron-builder 会照常打包)",
    r.code !== 0, `code=${r.code},输出:${r.out.trim().slice(0, 200)}`);
  check("deref:失败时不留下一个既没链接也没拷贝的空洞",
    // 注意用 lstat:目标已被删掉的 junction,existsSync 会跟随链接而返回 false,
    // 这里要问的是「那个链接条目本身还在不在」。
    linkEntryExists(fx.link), `${fx.link} 已经不存在了 —— 工作区包被删掉且没补上`);
}

/* ── B. fix-node-pty-conpty.cjs ──────────────────────────────────────── */

function conptyFixture(opts) {
  const root = newTree("conpty");
  const app = join(root, "app");
  const pty = join(app, "node_modules", "node-pty");
  mkdirSync(pty, { recursive: true });
  writeFileSync(join(pty, "package.json"), JSON.stringify({ name: "node-pty", main: "index.js" }), "utf8");
  writeFileSync(join(pty, "index.js"), "", "utf8");
  for (const folder of opts.versionFolders) {
    const dir = join(pty, "third_party", "conpty", folder.name, `win10-${opts.arch}`);
    if (folder.complete) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "conpty.dll"), "dll", "utf8");
      writeFileSync(join(dir, "OpenConsole.exe"), "exe", "utf8");
    } else if (folder.emptyDir) {
      mkdirSync(join(pty, "third_party", "conpty", folder.name), { recursive: true });
    } else {
      mkdirSync(dir, { recursive: true }); // 目录在,两个文件缺失
    }
  }
  return { app, pty, dest: join(pty, "build", "Release", "conpty") };
}

if (process.platform !== "win32") {
  check("conpty:非 Windows 上跳过(本套件的 conpty 部分只在 Windows 有意义)", true);
} else {
  const arch = "x64";
  {
    // B1 正常
    const fx = conptyFixture({ arch, versionFolders: [{ name: "1.0.0", complete: true }] });
    const script = plant(fx.app, "fix-node-pty-conpty.cjs");
    const r = runScript(script, { npm_config_arch: arch });
    check("conpty:正常情况退出码为 0", r.code === 0, `code=${r.code} ${r.out.slice(0, 200)}`);
    check("conpty:两个运行时文件都被回填",
      existsSync(join(fx.dest, "conpty.dll")) && existsSync(join(fx.dest, "OpenConsole.exe")),
      r.out.slice(0, 200));
  }
  {
    // B2 源文件缺失 —— 正是这个脚本存在的理由(否则终端起不来),不能悄悄放过
    const fx = conptyFixture({ arch, versionFolders: [{ name: "1.0.0", complete: false }] });
    const script = plant(fx.app, "fix-node-pty-conpty.cjs");
    const r = runScript(script, { npm_config_arch: arch });
    check("conpty:源文件缺失时退出码非 0(否则打出来的包终端起不来)",
      r.code !== 0, `code=${r.code},输出:${r.out.trim().slice(0, 200)}`);
  }
  {
    // B3 多个版本目录:必须挑真正含 win10-<arch> 的那个,不能撞运气取第一个
    const fx = conptyFixture({
      arch,
      versionFolders: [{ name: "0.9.0", emptyDir: true }, { name: "1.0.0", complete: true }],
    });
    const script = plant(fx.app, "fix-node-pty-conpty.cjs");
    const r = runScript(script, { npm_config_arch: arch });
    check("conpty:有多个版本目录时挑出真正带 win10-<arch> 的那个",
      r.code === 0 && existsSync(join(fx.dest, "conpty.dll")),
      `code=${r.code},输出:${r.out.trim().slice(0, 240)}`);
  }
}

/* ── C. CI 工作流:测试步骤不能被静默放过 ────────────────────────────── */
{
  const ci = readFileSync(resolve(__dirname, "..", "..", "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  check("ci:测试步骤没有 continue-on-error", !/continue-on-error:\s*true/i.test(ci));
  check("ci:没有用 `|| true` 把失败吞掉", !/\|\|\s*true/.test(ci));
  // 上传日志那一步用 always() 是对的,别的步骤不该用。每个 job 各有自己的一步上传
  // (Linux 关键关卡 + Windows 全量),所以判据是"每一处 always() 都挨着 upload-artifact"。
  const alwaysCount = (ci.match(/if:\s*always\(\)/g) ?? []).length;
  const alwaysUses = [...ci.matchAll(/if:\s*always\(\)[^\n]*\n\s*uses:\s*(\S+)/g)].map((m) => m[1] ?? "");
  check("ci:只有上传日志那一步用 always()",
    alwaysCount > 0 && alwaysUses.length === alwaysCount && alwaysUses.every((u) => u.startsWith("actions/upload-artifact")),
    `出现 ${alwaysCount} 次,其中紧跟 upload-artifact 的 ${alwaysUses.filter((u) => u.startsWith("actions/upload-artifact")).length} 次`);
}

const summary = `\nmaint-m27-smoke: ${pass} passed, ${fail} failed`;
console.log(summary);
try {
  const logDir = resolve(__dirname, "..", "..", ".tmp");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "maint-m27-smoke.log"), lines.join("\n") + summary + "\n", "utf8");
} catch { /* 日志写不了不影响判定 */ }
for (const d of temps) rmSync(d, { recursive: true, force: true });
process.exitCode = fail === 0 ? 0 : 1;
