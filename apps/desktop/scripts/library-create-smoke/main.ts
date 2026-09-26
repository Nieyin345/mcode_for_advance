/**
 * 左栏「大类右键 → 新建分类」的回归：渲染端 store → 真 IPC → 真 sqlite。
 * 仅数据根是临时目录；API 桩只负责把渲染端调用转发到注册的 handler。
 * 同时重启一次库，确认旧版留下的 NULL / 空串归属可恢复显示。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";
import type { LibraryCollection } from "@contracts/library";
import type { CollectionCreateInput } from "@contracts/ipc/library";
import { IPC } from "@contracts/ipc";
import { useBackend } from "./stubs/api.js";

function equal(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name);
  console.log(`  ok   ${name}`);
}

if (process.argv.includes("--recover")) {
  // 通过新进程重新 initDb()，不能靠同进程调用 closeDb/initDb（其就绪 Promise 不重置）。
  const { initDb, closeDb } = await import("@main/store/db.js");
  const { CollectionRepo } = await import("@main/store/repositories.js");
  await initDb();
  const byName = (name: string) => CollectionRepo.list().find((c) => c.name === name);
  equal("旧的 NULL 归属在首次运行的默认大类下可见", byName("旧版无归属")?.groupId, "templates");
  equal("旧迁移写出的空串归属也被找回", byName("旧版空串归属")?.groupId, "templates");
  equal("已有明确归属的不被恢复逻辑挪走", byName("文档分类")?.groupId, "docs");
  closeDb();
} else {
  const data = mkdtempSync(join(tmpdir(), "mcode-library-create-"));
  process.env.MCODE_SMOKE_DATA_ROOT = data;
  try {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    const fakeIpc = {
      handle(channel: string, fn: (event: unknown, input: unknown) => unknown) { handlers.set(channel, fn); },
    } as unknown as IpcMain;
    const { initDb, closeDb } = await import("@main/store/db.js");
    const { CollectionRepo } = await import("@main/store/repositories.js");
    await initDb();
    const { registerLibraryHandlers } = await import("@main/ipc/library.js");
    registerLibraryHandlers(fakeIpc);

    const invoke = (channel: string, input: unknown): Promise<unknown> => {
      const fn = handlers.get(channel);
      assert.ok(fn, `${channel} must be registered`);
      return Promise.resolve(fn(null, input));
    };
    const create = (input: CollectionCreateInput) =>
      invoke(IPC.LIBRARY_CREATE_COLLECTION, input) as Promise<{ collections: LibraryCollection[] }>;
    useBackend({
      createCollection: create,
      listCollections: () =>
        invoke(IPC.LIBRARY_LIST_COLLECTIONS, {}) as Promise<{ collections: LibraryCollection[] }>,
    });
    const { useLibraryStore } = await import("@renderer/stores/libraryStore.js");
    await useLibraryStore.getState().loadCollections();

    equal("首次加载尚未选中过任何大类", useLibraryStore.getState().activeGroupId, null);
    const docsId = await useLibraryStore.getState().createCollection("  文档分类  ", "docs");
    assert.ok(docsId);
    equal("首次新建记录挂在右键的文档大类", CollectionRepo.list().find((c) => c.id === docsId)?.groupId, "docs");
    equal("输入前后空白会按裁剪后的名字显示", CollectionRepo.list().find((c) => c.id === docsId)?.name, "文档分类");
    equal("新分类立即进左栏数据源", useLibraryStore.getState().collections.filter((c) => c.groupId === "docs").map((c) => c.id).includes(docsId), true);

    useLibraryStore.getState().setActiveCollection(docsId);
    equal("上次选中的是文档大类", useLibraryStore.getState().activeGroupId, "docs");
    const templateId = await useLibraryStore.getState().createCollection("模版分类", "templates");
    assert.ok(templateId);
    equal("右键模版时不沿用上次选中的文档大类", CollectionRepo.list().find((c) => c.id === templateId)?.groupId, "templates");
    equal("另一段的树会立即找到新分类", useLibraryStore.getState().collections.filter((c) => c.groupId === "templates").some((c) => c.id === templateId), true);

    const legacy = await create({ name: "旧客户端省略大类" });
    equal("旧客户端省略 groupId 时按契约落到第一个大类", legacy.collections.find((c) => c.name === "旧客户端省略大类")?.groupId, "templates");
    await assert.rejects(() => create({ name: "无效归属", groupId: "not-a-group" }), /大类不存在/);
    equal("错误大类不留下新的隐形分类", CollectionRepo.list().some((c) => c.name === "无效归属"), false);
    await assert.rejects(() => useLibraryStore.getState().createCollection("模版分类", "templates"), /已经有叫/);
    console.log("  ok   重名失败会抛给 UI，而不是静默返回成功");

    // 模拟此前创建成功却看不见的记录，以及旧回填写出的空串记录。
    CollectionRepo.create("旧版无归属");
    CollectionRepo.create("旧版空串归属", null, "");
    closeDb();
    const recovered = spawnSync(process.execPath, [process.argv[1]!, "--recover"], {
      env: process.env, encoding: "utf8", timeout: 30000,
    });
    if (recovered.stdout) process.stdout.write(recovered.stdout);
    if (recovered.stderr) process.stderr.write(recovered.stderr);
    equal("重启后恢复隐藏记录的进程通过", recovered.status, 0);
    console.log("library-create-smoke: passed");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}
