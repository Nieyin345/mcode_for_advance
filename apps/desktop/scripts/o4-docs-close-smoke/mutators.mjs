/**
 * O4 变异验证 —— 卡 §四 的三个变异，逐一执行、取证、逐字节还原。
 *
 * | # | 变异 | 期望 |
 * |---|---|---|
 * | 1 | 把 `wrapped.on` 删掉（包装层退回修复前形态） | **主判据（真 Electron 关闭）必须红**；无头 A1/A2/A3 红 |
 * | 2 | `on` 的回调去掉 `awaitDb()`（直接执行） | **A3（2.2 第 3 条）必须红，而主判据仍绿** —— 证明两条断言互相独立 |
 * | 3 | 把 B 的警告改成静默 | **B6（2.3 第 5 条）必须红**；主判据不受影响（包装层有 on，走不到那条分支） |
 *
 * ## 纪律（与 `t29-document-view-close-u1/mutate-t29.mjs` 相同）
 *
 *  - 只改一行/一处：`str.replace` 先数出现次数，**恰好 1 次**才动手；
 *  - 改完立刻核对**字节真的变了**（防「脚本在写文件前退出、被读成跑过了」）；
 *  - 跑段之前先看日志里有没有 `X [ERROR]` —— 那是**套件构建崩了**，不是断言红，
 *    两种形态必须分开（本仓库踩过多次）；
 *  - `finally` 里写回原字节并 `cmp`；期间若有别的进程改了源码则拒绝覆盖。
 *
 * 用法（在 apps/desktop 下）：
 *   node scripts/o4-docs-close-smoke/run.mjs --mutate
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const guardedPath = join(desktop, "src/main/ipc/dbGuardedIpc.ts");
const documentViewPath = join(desktop, "src/main/ipc/documentView.ts");

const results = [];
let failures = 0;
function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${title}`);
  if (detail !== undefined) console.log("      " + JSON.stringify(detail).slice(0, 1500));
}

/** 跑一段套件，返回 { exit, log }。`mode` ∈ { "headless", "electron" }。 */
function runSegment(mode) {
  const r =
    mode === "electron"
      ? spawnSync(process.execPath, [join(suite, "run.mjs")], {
          cwd: desktop,
          encoding: "utf8",
          timeout: 600_000,
          maxBuffer: 64 * 1024 * 1024,
          env: process.env,
        })
      : spawnSync("bash", [join(suite, "run.sh"), "--headless"], {
          cwd: desktop,
          encoding: "utf8",
          timeout: 600_000,
          maxBuffer: 64 * 1024 * 1024,
          env: process.env,
        });
  return {
    exit: r.status === null ? 1 : r.status,
    log: (r.stdout ?? "") + (r.stderr ?? ""),
    signal: r.signal ?? null,
    error: r.error ? String(r.error) : null,
  };
}

/** 构建崩了（`X [ERROR]`）或进程没起来 —— 与"断言红"是两种形态，必须分开。 */
function buildBroke(seg) {
  return seg.error !== null || seg.log.includes("X [ERROR]") || seg.log.includes("Build failed with");
}

/**
 * 一个变异：读原字节 → 精确替换、计数校验 → 落盘核对 → 跑各段 → 收集 → 还原核对。
 * `expect(trial)` 返回 { ok, detail }，由调用方定义「红得对不对」。
 */
function withMutation({ id, file, from, to, segments, expect }) {
  const original = readFileSync(file);
  const text = original.toString("utf8");
  // 仓库里两种换行并存（`core.autocrlf=true` 检出的是 CRLF；新写入的可能是 LF）。
  // 锚点按 LF 写，这里**跟随目标文件自己的换行风格**再匹配 —— 否则 CRLF 文件上
  // count 恒 0，变异会以「锚点不唯一」静默拒绝动手（本仓库记过这个形态）。
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const norm = (s) => (eol === "\n" ? s : s.replaceAll("\n", "\r\n"));
  const fromText = norm(from);
  const toText = norm(to);
  const count = text.split(fromText).length - 1;
  if (count !== 1) {
    record(id, "变异点必须唯一（否则拒绝动手）", false, { count, file: file.slice(desktop.length + 1) });
    return;
  }
  const mutated = Buffer.from(text.replace(fromText, toText));
  if (mutated.equals(original)) {
    record(id, "替换必须真的改变字节（否则等于没变异过）", false, { file: file.slice(desktop.length + 1) });
    return;
  }
  const trials = {};
  try {
    writeFileSync(file, mutated);
    if (!readFileSync(file).equals(mutated)) {
      record(id, "变异必须落盘（写后读回核对）", false, {});
      return;
    }
    for (const mode of segments) {
      const trial = runSegment(mode);
      trial.crashed = buildBroke(trial);
      trials[mode] = trial;
    }
  } finally {
    if (!readFileSync(file).equals(mutated)) {
      throw new Error(`${id}: 变异期间有别的写者改了 ${file}，拒绝覆盖`);
    }
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) {
      throw new Error(`${id}: 还原后字节不一致 —— 先停手查磁盘`);
    }
  }
  const verdict = expect(trials);
  record(id, verdict.title, verdict.ok, verdict.detail);
}

/* ═══════════════ 变异 1：删掉 wrapped.on（包装层退回修复前形态） ═══════════════ */

withMutation({
  id: "M1",
  file: guardedPath,
  from: `    on(channel, listener) {
      return addGuardedListener("on", channel, listener);
    },
`,
  to: "",
  segments: ["electron"],
  expect(trials) {
    const electron = trials.electron;
    const failedAtClose = electron.log.includes("failedStep=close-succeeds-within-2s") ||
      (electron.log.includes("UNEXPECTED FAILURE") &&
        (electron.log.includes("关闭被拒") || electron.log.includes("编辑器未响应关闭检查")));
    return {
      title: "★ 删掉 wrapped.on 后，主判据（真 Electron 关闭）红在 close-succeeds-within-2s",
      ok: electron.exit !== 0 && failedAtClose,
      detail: { exit: electron.exit, failedAtClose, tail: electron.log.slice(-1200) },
    };
  },
});

/* ══════════════ 变异 2：on 回调去掉 awaitDb()（应只红 A3，主判据绿） ══════════════ */

withMutation({
  id: "M2",
  file: guardedPath,
  from: "      void awaitDb().then(",
  to: "      void Promise.resolve().then(",
  segments: ["headless", "electron"],
  expect(trials) {
    const headless = trials.headless;
    const electron = trials.electron;
    const a3Red = /FAIL A3a/.test(headless.log);
    // 独立性：主判据必须**仍绿** —— 否则这条变异证明不了两条断言各验各的。
    const mainGreen = electron.exit === 0 && electron.log.includes("literal=PASS");
    // 顺便确认注册与调用那几条仍绿（变异只动了闸，没动注册与调用）。
    const registrationGreen = !/FAIL A1 |FAIL A2 ★/.test(headless.log);
    return {
      title: "★ 去掉 on 的 awaitDb 闸后：A3 红、主判据仍绿（两条断言互相独立）",
      ok: headless.exit !== 0 && a3Red && mainGreen,
      detail: { headlessExit: headless.exit, a3Red, mainGreen, registrationGreen, electronExit: electron.exit,
        headlessTail: headless.log.slice(-900) },
    };
  },
});

/* ══════════════════ 变异 3：把 B 的警告改成静默（应红 B6） ══════════════════ */

withMutation({
  id: "M3",
  file: documentViewPath,
  from: `  if (typeof ipc.on === "function") {
    ipc.on("mcode:document-view:close-check-result", onCloseCheckResult);
  } else {`,
  to: `  if (typeof ipc.on === "function") {
    ipc.on("mcode:document-view:close-check-result", onCloseCheckResult);
  } else if (false) {`,
  segments: ["headless"],
  expect(trials) {
    const headless = trials.headless;
    const b6Red = /FAIL B6 ★/.test(headless.log) || /FAIL B6b/.test(headless.log);
    return {
      title: "★ B 的警告改成静默后，2.3 第 5 条（B6）红",
      ok: headless.exit !== 0 && b6Red,
      detail: { exit: headless.exit, b6Red, tail: headless.log.slice(-900) },
    };
  },
});

/* ═══════════════════════════════ 收尾 ═══════════════════════════════ */

console.log("");
const passed = results.filter((r) => r.ok).length;
console.log(`O4 mutators: ${passed}/${results.length} 通过`);
if (failures > 0) {
  console.log("O4 mutators: FAIL");
  process.exitCode = 1;
} else {
  console.log("O4 mutators: PASS");
}
