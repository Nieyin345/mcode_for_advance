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

    // ★ expandCollection 必须**幂等**(已是展开态就不动),而 toggleExpanded 是纯翻转。
    //   新建笔记那条路要用前者:它先确保展开、之后再 setActive —— 用两次 toggleExpanded
    //   会互相抵消,库反而**收起**,用户看不到刚建的那篇。
    {
      const st = () => useLibraryStore.getState();
      st().expandCollection(docsId);
      equal("expandCollection 把库展开", st().expandedIds[docsId], true);
      st().expandCollection(docsId);
      equal("★ expandCollection 再调一次仍是展开(幂等,不是翻转)", st().expandedIds[docsId], true);
      // 对照:toggleExpanded 两次就翻回收起 —— 这正是那个 bug 的机理。
      st().toggleExpanded(docsId);
      equal("对照:toggleExpanded 会把展开态翻掉", st().expandedIds[docsId], false);
      st().toggleExpanded(docsId);
      equal("对照:再 toggle 一次回到展开", st().expandedIds[docsId], true);
    }

    // ★ 无参方法:`library.convert` 的 schema 全字段可选(ids/collectionId/force),
    //   而 `app_api_call` 对无参方法**明确让模型省略 input**(tools.ts 的 `input` 是
    //   `.optional()`),那时 handler 收到 `undefined`。`Schema.parse(undefined)` 会抛
    //   "Required" —— 渲染端走 `{}` 掩盖了它,模型调 `library.convert` 时会拿到一句
    //   zod 报错而不是转换结果。同 `context.get` 的 ?#115。这里只验"不炸",
    //   不真跑转换(库里没有条目,转换是空跑)。
    {
      const res = (await invoke(IPC.LIBRARY_CONVERT, undefined)) as { converted: number };
      equal("library.convert 接受省略的 input(undefined)", typeof res.converted, "number");
      console.log("  ok   library.convert 接受省略的 input(undefined)");
    }

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
