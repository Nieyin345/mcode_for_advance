import { manageMemory } from "@main/memory/manage.js";
import { MEMORY_MANAGE_CHANNEL, MemoryManageSchema } from "@contracts/memory";
/**
 * 记忆库 IPC(MEM-01 的界面通道)。业务全在 `main/memory/store.ts`,这里只做
 * zod 校验与编排 —— 与 `templates.ts` 同一条约定。
 *
 * 渠道字符串来自 `@contracts/memory` 的 `MEMORY_*_CHANNEL`(与 preload 的 invoke
 * 字符串同一份);R 侧 runtime 契约里的 `IPC.MEMORY_*` 常量应取同样的值。
 *
 * ## ⚠️ 出参形状必须跟着 `RpcMap` 走,不是"store 回什么就转什么"
 *
 * 这一层是契约与 store 的**接缝**,而 store 的返回值是按"谁调它方便"定的
 * (`memory-smoke` 直接调 store,读的就是那几个形状)。两边原来对不上,于是**面板的
 * 每一个动作都是坏的**——三个都实测过:
 *
 *  1. `memory:list` —— `RpcMap` 要 `{ files: MemoryFileMeta[] }`,这里原来直接把
 *     `listMemoryFiles()` 的**裸数组**转出去了。面板读 `res.files` 拿到 `undefined`,
 *     `byCategory` 里 `for (const f of files)` 直接抛 → 设置→记忆库**整块打不开**。
 *  2. `memory:save` —— 契约要 `{ ok: boolean }`,原来转的是 store 的
 *     `{ updatedAt }`。面板读 `res.ok` 拿到 `undefined` → 走进失败分支、把
 *     `res.error ?? t("common.error")` 摆出来:每存一次成功,顶栏都显示一个「错误」,
 *     而且「有改动还没保存」永远不消。
 *  3. `memory:read` —— store 返回的正文带着 frontmatter 分隔行留下的**那个换行**
 *     (存的时候写的是 `---\n…\n---\n\n<正文>`),而 `memory:save` 会把给它的正文
 *     原样再写一遍。于是「读出来 → 存回去」每来一轮,文件就多一个空行,正文越漂越远
 *     (实测三轮:`"A"` → `"\nA"` → `"\n\nA"` → `"\n\n\nA"`)。
 *
 * 三条都在下面就地收口,**不动 store**(它的形状别处还在用,而且 `memory-smoke`
 * 钉着)。`memory-codex-smoke` 那套按契约断形状,改回裸数组/裸时间戳就会红。
 */
import type { IpcMain } from "electron";
import {
  MEMORY_CATEGORIES_CHANNEL,
  MEMORY_DELETE_CHANNEL,
  MEMORY_LIST_CHANNEL,
  MEMORY_READ_CHANNEL,
  MEMORY_REVIEW_CHANNEL,
  MEMORY_REVIEW_DELETE_CHANNEL,
  MEMORY_SAVE_CHANNEL,
  MemoryDeleteSchema,
  MemoryListSchema,
  MemoryPathSchema,
  MemoryReviewDeleteSchema,
  MemorySaveSchema,
} from "@contracts/memory";
import { notifyMemoryChanged } from "@main/memory/broadcast.js";
import { deleteReviewedMemory, reviewMemoryFiles } from "@main/memory/review.js";
import {
  MemoryConflictError,
  deleteMemoryFile,
  listMemoryFiles,
  memoryCategories,
  readMemoryFile,
  saveMemoryFile,
} from "@main/memory/store.js";

export function registerMemoryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(MEMORY_MANAGE_CHANNEL, (_evt, raw) => manageMemory(MemoryManageSchema.parse(raw)));
  ipcMain.handle(MEMORY_LIST_CHANNEL, (_evt, raw) => {
    const input = MemoryListSchema.parse(raw ?? {});
    // 契约是 `{ files: [...] }`(见 `RpcMap["memory.list"]`),不是裸数组 —— 见文件头。
    const files = listMemoryFiles(input.category ? { category: input.category } : undefined);
    return { files };
  });

  ipcMain.handle(MEMORY_READ_CHANNEL, (_evt, raw) => {
    const input = MemoryPathSchema.parse(raw);
    // 正文**去掉首尾空行**:store 吐回来的是 frontmatter 之后那一整段,前面带着
    // 分隔行留下的换行;而 store 写回去时会把尾部空白 `trimEnd` 掉。一读一存就长胖。
    //
    // ⚠️ 这里换来的是"**读出来的就是能原样存回去的**"这条不动点。代价是正文开头
    // 故意留的空行(手写的 markdown 里少见,但存在)会被吃掉 —— 而写回去那一步
    // 本来就会吃掉它,所以这个代价在改动之前就已经在付了,只是没人说得清。
    const { content, revision } = readMemoryFile(input.path);
    return { content: content.replace(/^\n+|\n+$/g, ""), revision };
  });

  ipcMain.handle(MEMORY_SAVE_CHANNEL, (_evt, raw) => {
    const input = MemorySaveSchema.parse(raw);
    // 契约是 `{ ok, error? }`,store 回的是 `{ updatedAt }`;这里转形状,并且
    // **别把异常抛出去**:契约写了"`ok: false` 时 `error` 是给人看的句子,不是异常",
    // 面板也是按这个读的(`res.error ?? t("common.error")` 那一行)。
    try {
      const { revision } = saveMemoryFile(input);
      notifyMemoryChanged(`save:${input.path}`);
      return { ok: true, revision };
    } catch (err) {
      return { ok: false, error: (err as Error).message, ...(err instanceof MemoryConflictError ? { code: "conflict" as const } : {}) };
    }
  });

  ipcMain.handle(MEMORY_DELETE_CHANNEL, (_evt, raw) => {
    // 删除还要携带用户确认时的版本；不在执行时偷偷重读并替换它。
    const input = MemoryDeleteSchema.parse(raw);
    // 同 save:契约是 `{ ok, error? }` 而不是"抛",拒绝也要走 `ok: false` 这条路。
    try {
      deleteMemoryFile(input.path, input.expectedRevision);
      notifyMemoryChanged(`delete:${input.path}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message, ...(err instanceof MemoryConflictError ? { code: "conflict" as const } : {}) };
    }
  });

  ipcMain.handle(MEMORY_CATEGORIES_CHANNEL, () => memoryCategories());

  // 建议生成只读。比普通 list 更慢（要比较正文），仅在用户主动点「整理」时调用。
  ipcMain.handle(MEMORY_REVIEW_CHANNEL, () => reviewMemoryFiles());

  // 永不按建议自动删：UI 必须勾选 + 二次确认，并交回扫描时的完整内容指纹。
  ipcMain.handle(MEMORY_REVIEW_DELETE_CHANNEL, (_evt, raw) => {
    const input = MemoryReviewDeleteSchema.parse(raw);
    const result = deleteReviewedMemory(input);
    if (result.ok) notifyMemoryChanged(`reviewDelete:${input.path}`);
    return result;
  });
}
