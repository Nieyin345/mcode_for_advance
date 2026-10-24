/**
 * O10 —— `stagedAtomicWrite` 的**失败路径**断言（纯 Node，不启动 Electron）。
 *
 * ## 为什么这条比正常路径重要
 *
 * 第一版把 `rm(staging)` 写在 `finally` 里。正常路径完全看不出问题；
 * 而 `rename` 因 Windows 的 EBUSY/EPERM（杀毒、索引器、OneDrive 同步锁住目标）
 * 失败时，`finally` 会删掉**刚刚写好的唯一一份完整新内容** —— 用户看到
 * 「保存失败」，编辑全没了。这比改动前更坏（那时盘上至少还有被截断的文件可捞）。
 *
 * **失败路径没有任何正常路径的断言能覆盖它**：O2 套件只跑「能写就成功」的世界，
 * 默认透传负控只验「没装守卫时行为不变」，真并发只验「两个保存同时跑」。
 * 三条都在「事情能成」的世界里。所以这条必须单独写，并且喂**假的 replace/remove**。
 *
 * ## 它验什么（两条）
 *
 * 1. **替换失败 + 原地写也失败** → 抛错，且**暂存没有被删**（新内容还在盘上某处）；
 * 2. 对照：**写暂存失败** → 暂存**应当被删**（里面没有完整内容，留着是垃圾）。
 *
 * 第 2 条是对照组：没有它，「永远不删暂存」也能让第 1 条绿 —— 那是另一种错。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { stagedAtomicWrite } from "../../../../genoffice/packages/electron-utils/src/document-save-guard";

/** 一个可观察的假文件系统：只记「哪个路径被写了什么」与「谁被删了」。 */
function fakeFs(opts: { failWriteTo?: string; failReplace?: boolean } = {}) {
  const written: Array<{ path: string; content: string }> = [];
  const removed: string[] = [];
  const onDisk = new Map<string, string>();
  return {
    written,
    removed,
    onDisk,
    deps: {
      target: "/docs/deck.pptx",
      staging: "/docs/.deck.pptx.abc.mcode-saving",
      writeTo: async (path: string) => {
        if (opts.failWriteTo === path) throw new Error("disk full");
        onDisk.set(path, `NEW-CONTENT@${path}`);
        written.push({ path, content: `NEW-CONTENT@${path}` });
      },
      replace: async (from: string, to: string) => {
        if (opts.failReplace) throw new Error("EBUSY: target locked by another program");
        const content = onDisk.get(from);
        if (content === undefined) throw new Error("ENOENT staging");
        onDisk.set(to, content);
        onDisk.delete(from);
      },
      remove: async (path: string) => {
        removed.push(path);
        onDisk.delete(path);
      },
    },
  };
}

test("替换失败 + 原地写也失败 → 抛错，且**暂存里的新内容没有被删**", async () => {
  // 写暂存成功；替换失败；退回原地写也失败（模拟目标始终被锁住）。
  const fs = fakeFs({ failReplace: true });
  fs.deps.writeTo = (async (path: string) => {
    if (path === fs.deps.target) throw new Error("EBUSY: still locked");
    fs.onDisk.set(path, "NEW-CONTENT");
    fs.written.push({ path, content: "NEW-CONTENT" });
  }) as never;

  await assert.rejects(() => stagedAtomicWrite(fs.deps), /EBUSY: still locked/);

  // ★ 核心：暂存**必须还在**，而且里面是完整的新内容。
  assert.ok(fs.onDisk.has(fs.deps.staging), "暂存被删了 —— 用户的新内容丢了");
  assert.equal(fs.onDisk.get(fs.deps.staging), "NEW-CONTENT");
  assert.ok(
    !fs.removed.includes(fs.deps.staging),
    `暂存被 remove 了：${JSON.stringify(fs.removed)}`,
  );
});

test("替换失败但原地写成功 → 目标拿到新内容，暂存被清理", async () => {
  const fs = fakeFs({ failReplace: true });
  await stagedAtomicWrite(fs.deps);
  assert.equal(fs.onDisk.get(fs.deps.target), `NEW-CONTENT@${fs.deps.target}`);
  assert.ok(fs.removed.includes(fs.deps.staging), "原地写成功后应当清理暂存");
});

test("对照：写暂存就失败 → 删暂存（里面没有完整内容）", async () => {
  const fs = fakeFs({ failWriteTo: "/docs/.deck.pptx.abc.mcode-saving" });
  await assert.rejects(() => stagedAtomicWrite(fs.deps), /disk full/);
  // 对照组：这一条**必须**删 —— 否则「永远不删暂存」也能让上一条绿。
  assert.ok(fs.removed.includes(fs.deps.staging), "写暂存失败时应当删掉它");
  assert.ok(!fs.onDisk.has(fs.deps.target), "目标不该被碰过");
});

test("正常路径：替换成功，暂存消失（没有残留 .mcode-saving）", async () => {
  const fs = fakeFs();
  await stagedAtomicWrite(fs.deps);
  assert.equal(fs.onDisk.get(fs.deps.target), `NEW-CONTENT@${fs.deps.staging}`);
  assert.ok(!fs.onDisk.has(fs.deps.staging), "替换成功后暂存不该留在盘上");
  assert.deepEqual(fs.removed, [], "成功路径不该调用 remove（rename 已把名字换走）");
});

test("错误信息里点名暂存路径（用户/我们能捞回来）", async () => {
  const fs = fakeFs({ failReplace: true });
  fs.deps.writeTo = (async (path: string) => {
    if (path === fs.deps.target) throw new Error("EBUSY");
    fs.onDisk.set(path, "NEW-CONTENT");
  }) as never;
  await assert.rejects(
    () => stagedAtomicWrite(fs.deps),
    (error: Error) => error.message.includes("/docs/.deck.pptx.abc.mcode-saving"),
  );
});
