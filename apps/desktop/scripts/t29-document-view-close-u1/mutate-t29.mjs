/**
 * T29 变异验证：撤掉宿主里的 vendor 关闭守卫分支 → **真 Electron** 旅程必须变红
 * → 逐字节还原 → 复绿。
 *
 * ## 为什么变异点是这一行
 *
 * 缺陷的判据是「原厂四编辑器关闭时宿主去问谁」。修复把它们转给 vendor 的
 * `request*Close`；把它短路成 `false && …` 就退回修复前形态（发 close-check
 * 探针、vendor 不订阅、2 秒超时拒绝）。这正是 T7 实测录下的原话。
 *
 * ## 只动一行、只动一次
 *
 * `str.replace` 计数出现次数（CRLF 文件），改完立刻 `cmp` 确认**真的变了**；
 * 跑完在 `finally` 里写回原字节并 `cmp` 确认**逐字节还原**。中途任何别的
 * 进程改了源码 → 拒绝覆盖并报错（与 `document-view-host-smoke/mutate-t22.mjs`
 * 同一纪律）。
 *
 * 用法：
 *   node apps/desktop/scripts/t29-document-view-close-u1/mutate-t29.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const source = join(desktop, "src/main/document/documentViewHost.ts");
const original = readFileSync(source);
const text = original.toString("utf8");

const needle = "    if (vendorEditor !== null) {";
const count = text.split(needle).length - 1;
if (count !== 1) throw Error(`T29 mutation: 变异点不唯一（出现 ${count} 次）`);
const mutated = Buffer.from(text.replace(needle, "    if (false && vendorEditor !== null) {"));
if (mutated.equals(original)) throw Error("T29 mutation: 替换没有改变文件");

/** 跑一条 T29 旅程，返回 { exit, log }。 */
function runJourney(name) {
  const r = spawnSync(process.execPath, [
    join(suite, "run.mjs"), `--only=${name}`,
  ], { cwd: desktop, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  return { exit: r.status ?? 1, log: (r.stdout ?? "") + (r.stderr ?? "") };
}

let caught = false;
try {
  writeFileSync(source, mutated);
  if (!readFileSync(source).equals(mutated)) throw Error("T29 mutation: 变异没有落盘");
  const trial = runJourney("t29-close-markdown-after-unsaved-guard");
  // 必须是「意外失败」且停在 clean-close-succeeds —— 不是构建错误、不是超时。
  caught = trial.exit === 2 &&
    trial.log.includes("failedStep=clean-close-succeeds") &&
    trial.log.includes("UNEXPECTED FAILURE");
  console.log(`T29 MUTATION detected=${caught} suiteExit=${trial.exit}`);
  if (!caught) console.error(trial.log.slice(-4000));
} finally {
  if (!readFileSync(source).equals(mutated)) {
    throw Error("T29 mutation: 变异期间有别的写者改了源码，拒绝覆盖");
  }
  writeFileSync(source, original);
  if (!readFileSync(source).equals(original)) throw Error("T29 mutation: 还原后字节不一致");
  console.log("T29 MUTATION source restored byte-identical");
}
if (!caught) process.exitCode = 1;
