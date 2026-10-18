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
import { memoryAddress, visibleMemory, visibleMemoryDiagnostic } from "@main/memory/paths.js";
import { currentAgentMemoryProjectId } from "@main/memory/agentScope.js";
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
  // 【MC-092】agent 经通用 `app_api_call` 调 `memory.*` 时,宿主已把**会话所属项目**装进
  // 作用域(见 `memory/agentScope.ts`);桌面用户走真实 IPC 时没有作用域 → 保留全局管理权限。
  // 这道闸把「通用接口」与「专用记忆工具」的授权拉齐:带作用域时,读写只许**本项目 + 全局**,
  // list 只列可见项 —— 模型不能借 `app_api_call` 绕过专用工具的隔离。
  //
  // `agentVisible` 是**唯一一份**「当前可见集合」判据:无作用域 → `undefined`(桌面用户,不设限);
  // 有作用域 → 只认本项目 + 全局。读写删按**路径**判;`manage`/`review` 这类**列表型**出口把
  // 它当谓词**传进领域函数**,在构建列表**之前**就滤掉不可见项(计数才不撒谎 —— 出参的
  // totalFiles / history 才和列出来的条目对得上)。
  // `agentVisibleDiagnostic` 是同一作用域的**诊断版**:文件走 `visibleMemory`、目录走
  // `visibleMemoryDir` —— review 的 `unreadable` 清单里有目录级漏读(整类目录读不动/被链接
  // 替换),拿文件版判会把它们整批丢掉,agent 就看不到「这一整类没扫到」。
  const agentVisible = (): ((path: string) => boolean) | undefined => {
    const scope = currentAgentMemoryProjectId();
    return scope === undefined ? undefined : (path) => visibleMemory(path, scope);
  };
  const agentVisibleDiagnostic = (): ((path: string) => boolean) | undefined => {
    const scope = currentAgentMemoryProjectId();
    return scope === undefined ? undefined : (path) => visibleMemoryDiagnostic(path, scope);
  };
  const enforceAgentScope = (path: string): void => {
    const visible = agentVisible();
    if (visible === undefined) return; // 桌面用户:全局管理权限。
    if (!visible(path)) {
      throw new Error("记忆不属于本项目或显式全局范围;agent 只能访问当前项目的记忆。");
    }
  };
  // 【MC-092】manage 的 import/preview/history/restore 与 list 的 sources/history 也要按同一份
  // 判据收口 —— 从前这几个出口没纳入闸门(仍走 manage 自己的授权),agent 能借它读写别项目记忆。
  ipcMain.handle(MEMORY_MANAGE_CHANNEL, (_evt, raw) => manageMemory(MemoryManageSchema.parse(raw), agentVisible()));
  ipcMain.handle(MEMORY_LIST_CHANNEL, (_evt, raw) => {
    const input = MemoryListSchema.parse(raw ?? {});
    // 契约是 `{ files: [...] }`(见 `RpcMap["memory.list"]`),不是裸数组 —— 见文件头。
    const all = listMemoryFiles(input.category ? { category: input.category } : undefined);
    // 【MC-092】agent 作用域下只列**本项目 + 全局**的项(桌面用户看到全部)—— 与 read/save/
    // delete/manage/review 共用同一份 `agentVisible` 谓词,不在这里另写一遍同值判据。
    const visible = agentVisible();
    const files = visible === undefined ? all : all.filter((f) => visible(f.path));
    return { files };
  });

  ipcMain.handle(MEMORY_READ_CHANNEL, (_evt, raw) => {
    const input = MemoryPathSchema.parse(raw);
    enforceAgentScope(input.path);
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
    enforceAgentScope(input.path);
    // ★ 一条**新建**的、却漏了作用域前缀的记忆路径(如 `preferences/x.md`)是调用方的
    //   静默作用域升级:他以为在存**项目**记忆,文件却落到 `<数据根>/memory/<类目>/`
    //   (旧布局,`memory.list` 里标 `scope:"legacy"`)—— 不属于任何项目、不会被注入、
    //   只在「导入与恢复」里以旧记忆源露面。agent 经 `app_api_call` 调 `memory.save` 时
    //   正是这种形状。对照:内置的 `memory_write` 工具自己会补 `global/` 或
    //   `projects/<id>/` 前缀并走 `requireMemoryAccess`,所以只有这条裸 RPC 有这个洞。
    //
    //   判据取「是新建」(expectedRevision 缺省),而不是"凡是 legacy 一律拒":**存量**
    //   legacy 记录(升级前的老布局)在记忆面板里仍可**原地编辑** —— 那种调用会带上打开
    //   时读到的 revision,不该被拦。要新建就必须把作用域写全,错误信息直接告诉调用方
    //   两种正确写法(判据与 `main/memory/paths.ts` 的 `memoryAddress` 同一份,不另写正则)。
    const address = memoryAddress(input.path);
    if (address?.scope === "legacy" && input.expectedRevision == null) {
      return {
        ok: false,
        error: `记忆路径缺少作用域前缀:「${input.path}」。项目记忆要写 projects/<项目id>/${address.category}/${address.file};` +
          `要存到所有项目共享的全局记忆就写 global/${address.category}/${address.file}。`,
      };
    }
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
      // 【MC-092】agent 作用域下不许删别的项目/旧布局的记忆 —— 与读写同一道闸。抛出的
      // 拒绝被下面的 catch 转成 `{ ok:false, error }`,契约形状不变。
      enforceAgentScope(input.path);
      deleteMemoryFile(input.path, input.expectedRevision);
      notifyMemoryChanged(`delete:${input.path}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message, ...(err instanceof MemoryConflictError ? { code: "conflict" as const } : {}) };
    }
  });

  ipcMain.handle(MEMORY_CATEGORIES_CHANNEL, () => memoryCategories());

  // 建议生成只读。比普通 list 更慢（要比较正文），仅在用户主动点「整理」时调用。
  // 【MC-092】agent 作用域下只扫描**本项目 + 全局**的记忆(桌面用户扫全部)——把「可见」谓词
  // 传进领域函数,在**构建扫描结果之前**滤掉不可见项:这样 staleTotal / totalFiles 这些
  // 计数与列出来的条目同出一份可见集合,不会出现"计数里带着别项目、列表里却没有"的错位。
  ipcMain.handle(MEMORY_REVIEW_CHANNEL, () => reviewMemoryFiles(agentVisible(), agentVisibleDiagnostic()));

  // 永不按建议自动删：UI 必须勾选 + 二次确认，并交回扫描时的完整内容指纹。
  ipcMain.handle(MEMORY_REVIEW_DELETE_CHANNEL, (_evt, raw) => {
    const input = MemoryReviewDeleteSchema.parse(raw);
    // 【MC-092】与 memory:delete 同一道闸:agent 不能借 reviewDelete 删别的项目/旧布局的记忆。
    // 可见谓词传进领域函数,由它按 `{ok:false,error}` 契约形状拒绝(不抛出去改坏形状)。
    const result = deleteReviewedMemory(input, agentVisible());
    if (result.ok) notifyMemoryChanged(`reviewDelete:${input.path}`);
    return result;
  });
}
