/**
 * T46 变异验证：逐个撤掉 `ApprovalPrompt` 的生产守卫，确认对应的 U1 组**真的变红**，
 * 然后逐字节还原。
 *
 * 为什么必须做：本卡大量断言是「**不该发生**」（焦点不进卡、Enter 不决策、settings
 * 打开时不决策）。这类断言最容易空过 —— 全绿可能只是「场景没造出来」。T24 的 59/59
 * 漏掉 T40 就是这个形状。所以每一组「不该发生」都配了同源的「该发生」正控，并且
 * 这里再用变异证明判据真的挂在生产代码上。
 *
 * 三个变异点（都是 `ApprovalPrompt.tsx` 里的真守卫）：
 *
 *  1. `hasTopmostForeignDialog(cardRef.current)` → `false`
 *     → 模态组必须红（后到的卡抢焦点）。
 *  2. `const promptActive = active && !settingsOpen` → `active`
 *     → settings 组必须红（设置打开时卡片仍拿焦点/决策）。
 *  3. `cardRef.current.focus(...)` → 聚焦卡片外元素
 *     → 挂载聚焦组必须红（卡不再拿焦点）。
 *
 * 每个变体：备份 → Python 精确替换（LF，计数=1）→ 跑旅程 → 必须 `exit 2` 且
 * `failedStep` 命中预期组 → `cp` 还原 + `cmp` 逐字节。
 *
 * 用法：node apps/desktop/scripts/t46-approval-card-u1/mutate-t46.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const source = join(desktop, "src/renderer/components/chat/ApprovalPrompt.tsx");
const original = readFileSync(source);
const text = original.toString("utf8");
const eol = text.includes("\r\n") ? "\r\n" : "\n";

const variants = [
  {
    name: "modal-guard-removed",
    from: "        hasTopmostForeignDialog(cardRef.current)) return;",
    to: "        false) return; /* MUTATION: modal guard removed */",
    expectStep: "modal-open-later-card-yields-control-works",
  },
  {
    name: "settings-pause-removed",
    from: "  const promptActive = active && !settingsOpen;",
    to: "  const promptActive = active; /* MUTATION: settings pause removed */",
    expectStep: "settings-open-pauses-and-resuming-works",
  },
  {
    name: "card-focus-removed",
    from: "    cardRef.current.focus({ preventScroll: true });",
    to: "    document.getElementById('outside-focus-target')?.focus(); /* MUTATION */",
    expectStep: "card-takes-focus-on-mount",
  },
].map((v) => ({ ...v, from: v.from.replaceAll("\n", eol), to: v.to.replaceAll("\n", eol) }));

let failed = false;
for (const variant of variants) {
  if (!readFileSync(source).equals(original)) throw Error("T46 mutation: 开始前源码已被改动（并行写者？）");
  const count = text.split(variant.from).length - 1;
  if (count !== 1) throw Error(`T46 mutation: ${variant.name} 变异点不唯一（${count} 次）`);
  const mutated = Buffer.from(text.replace(variant.from, variant.to));
  if (mutated.equals(original)) throw Error(`T46 mutation: ${variant.name} 没有改变文件`);
  let caught = false;
  try {
    writeFileSync(source, mutated);
    if (!readFileSync(source).equals(mutated)) throw Error(`T46 mutation: ${variant.name} 没有落盘`);
    const r = spawnSync(process.execPath, [join(suite, "run.mjs")], {
      cwd: desktop, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    });
    const log = (r.stdout ?? "") + (r.stderr ?? "");
    caught = (r.status ?? 1) === 2 && log.includes(`failedStep=${variant.expectStep}`);
    console.log(`T46 MUTATION ${variant.name}: detected=${caught} (exit=${r.status}, expect failedStep=${variant.expectStep})`);
    if (!caught) console.error(log.slice(-3000));
  } finally {
    if (!readFileSync(source).equals(mutated)) throw Error(`T46 mutation: ${variant.name} 期间源码被第三方改动，拒绝覆盖`);
    writeFileSync(source, original);
    if (!readFileSync(source).equals(original)) throw Error("T46 mutation: 还原后字节不一致");
  }
  if (!caught) failed = true;
}
if (failed) process.exitCode = 1;
else console.log("T46 MUTATION: all 3 variants detected; source restored byte-identical");
