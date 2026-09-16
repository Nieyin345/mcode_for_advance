/**
 * 模版库 IPC。业务逻辑都在 `main/templates/store.ts`,这里只做校验与编排。
 *
 * 与文献库同样的约定:变更类 handler **返回该类目的完整新列表**,渲染端整体替换缓存。
 */
import { shell, type IpcMain } from "electron";
import { log } from "@main/lib/logger.js";
import { openDirectory } from "@main/lib/reveal.js";
import {
  IPC,
  TEMPLATE_ROOT_SETTING_KEY,
  LibrarySetRootSchema,
  TemplateAddSchema,
  TemplateEntryRefSchema,
  TemplateFileRefSchema,
  TemplateKindManifestSchema,
  TemplateListSchema,
  TemplateRenameSchema,
  TemplatesAttachToChatSchema,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import {
  addTemplate,
  attachTemplateToChat,
  ensureTemplateDirs,
  listTemplates,
  listTrashedTemplates,
  notifyTemplatesChanged,
  purgeTemplate,
  renameTemplate,
  restoreTemplate,
  templateEntryDir,
  templatesRoot,
  trashTemplate,
  writeTemplateKindManifest,
  writeTemplateManifest,
} from "@main/templates/store.js";
import { readTemplateFile, resolveTemplateFilePath } from "@main/templates/read.js";

export function registerTemplateHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.TEMPLATES_LIST, (_evt, raw) => {
    const input = TemplateListSchema.parse(raw ?? {});
    return { entries: listTemplates(input.kind) };
  });

  ipcMain.handle(IPC.TEMPLATES_ADD, (_evt, raw) => {
    const input = TemplateAddSchema.parse(raw);
    const res = addTemplate(input.kind, input.name, input.sourcePaths);
    // 重名 / 复制失败都要**如实抛出去** —— 静默返回空列表会让用户以为建成了
    if (!res.ok) throw new Error(res.error);
    // 另一个入口(左栏那一段)的缓存不会自己知道 —— 与文献库同一条广播
    notifyTemplatesChanged(`add:${input.kind}/${input.name}`);
    return { entries: res.entries };
  });

  /**
   * 删除 = **移进回收站**。
   *
   * 与文献库同一条思路:界面上那个删除永远是可逆的,真正的删除只在回收站里做
   * (`TEMPLATES_PURGE`)。模版是一整包文件,误删的代价比一条文献记录大得多 ——
   * 而且模版库是文件系统,没有数据库能替你留一份。
   */
  ipcMain.handle(IPC.TEMPLATES_TRASH, (_evt, raw) => {
    const input = TemplateEntryRefSchema.parse(raw);
    const res = trashTemplate(input.kind, input.dirName);
    // 失败要如实抛:静默返回列表会让用户以为删掉了,而它还在
    if (!res.ok) throw new Error(res.error);
    notifyTemplatesChanged(`trash:${input.kind}/${input.dirName}`);
    return { entries: listTemplates(input.kind), trashed: listTrashedTemplates() };
  });

  /**
   * 给一条模版改名(改的是磁盘上那个目录)。
   *
   * `ok:false` **不抛** —— "这个名字已经有一条了"是用户自己就能解决的正常结果,
   * 抛出去会变成一条带堆栈的报错,而渲染端要做的只是把那句话显示出来(与 restore
   * 同一个处理)。
   */
  ipcMain.handle(IPC.TEMPLATES_RENAME, (_evt, raw) => {
    const input = TemplateRenameSchema.parse(raw);
    const res = renameTemplate(input.kind, input.dirName, input.name);
    if (res.ok) notifyTemplatesChanged(`rename:${input.kind}/${res.dirName}`);
    return {
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      entries: listTemplates(input.kind),
      dirName: res.dirName,
    };
  });

  ipcMain.handle(IPC.TEMPLATES_TRASH_LIST, () => ({ trashed: listTrashedTemplates() }));

  ipcMain.handle(IPC.TEMPLATES_RESTORE, (_evt, raw) => {
    const input = TemplateEntryRefSchema.parse(raw);
    const res = restoreTemplate(input.kind, input.dirName);
    if (res.ok) notifyTemplatesChanged(`restore:${input.kind}/${input.dirName}`);
    // ok:false 不抛 —— "这个类目里已经有同名的一条了"是用户能自己解决的正常结果,
    // 抛出去会变成一条带堆栈的报错,而渲染端要做的只是把这句话显示出来
    return {
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      entries: listTemplates(input.kind),
      trashed: listTrashedTemplates(),
    };
  });

  ipcMain.handle(IPC.TEMPLATES_PURGE, (_evt, raw) => {
    const input = TemplateEntryRefSchema.parse(raw);
    const res = purgeTemplate(input.kind, input.dirName);
    if (res.ok) notifyTemplatesChanged(`purge:${input.kind}/${input.dirName}`);
    return {
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      entries: listTemplates(input.kind),
      trashed: listTrashedTemplates(),
    };
  });

  ipcMain.handle(IPC.TEMPLATES_REVEAL, async (_evt, raw) => {
    const input = TemplateEntryRefSchema.parse(raw);
    // 类目目录与**回收站**都要找 —— 回收站里的那一条也得打得开所在文件夹
    const dir = templateEntryDir(input.kind, input.dirName);
    if (!dir) {
      log.warn(`templates: reveal — directory gone: ${input.kind}/${input.dirName}`);
      return { ok: false, error: "模版目录不在了(可能已在磁盘上被删)" };
    }
    // 用 openDirectory 而不是 Electron 那两个 shell API —— 它们在这台机器上都不成,
    // 原因写在 `main/lib/reveal.ts` 顶部。
    const err = await openDirectory(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle(IPC.TEMPLATES_MANIFEST, (_evt, raw) => {
    const input = TemplateEntryRefSchema.parse(raw);
    return writeTemplateManifest(input.kind, input.dirName);
  });

  /** 整个类目的清单 —— 「全部 LaTeX 模版」那一行挂进对话时用的。 */
  ipcMain.handle(IPC.TEMPLATES_KIND_MANIFEST, (_evt, raw) => {
    const input = TemplateKindManifestSchema.parse(raw);
    return writeTemplateKindManifest(input.kind);
  });

  /**
   * 把一条模版挂到指定会话的输入框上 —— 左栏右键「添加到当前对话」。
   *
   * 与 AI 的 `library_attach_to_chat`(文献库)走同一条路:主进程生成清单,再用
   * `composer:attach` 广播,那个会话的 ChatPane 认领后落成 chip。所以"用户挂的"
   * 与"用户自己点「+ → 模版」挂的"必然是同一种东西。
   */
  ipcMain.handle(IPC.TEMPLATES_ATTACH_TO_CHAT, (_evt, raw) => {
    const input = TemplatesAttachToChatSchema.parse(raw);
    return attachTemplateToChat(input.sessionId, input.kind, input.dirName);
  });

  /**
   * 应用内预览一个模版文件。
   *
   * 只读工具,**不需要确认** —— 它和「在文件夹中打开」是同一类事情,改不了任何东西。
   * 路径的两道围栏在 `resolveTemplateFilePath` 里(见 templates/read.ts 的说明)。
   */
  ipcMain.handle(IPC.TEMPLATES_READ_FILE, (_evt, raw) => {
    const input = TemplateFileRefSchema.parse(raw);
    return readTemplateFile(input.kind, input.dirName, input.relPath);
  });

  /**
   * 用系统默认程序打开一个模版文件。
   *
   * 这是 Word / PPT / PDF 唯一的看法 —— 它们没有应用内预览(见 templates/read.ts
   * 顶部为什么不做)。路径走的是**同一个**围栏函数,不是另写一套。
   */
  ipcMain.handle(IPC.TEMPLATES_OPEN_FILE, async (_evt, raw) => {
    const input = TemplateFileRefSchema.parse(raw);
    let abs: string;
    try {
      abs = resolveTemplateFilePath(input.kind, input.dirName, input.relPath);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // 与文献库的 openFile 同一套:shell.openPath 对**文件**是有效的(reveal.ts 顶部
    // 记的那个坑只出现在**目录**上)
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle(IPC.TEMPLATES_GET_ROOT, () => ({ path: ensureTemplateDirs() }));
  ipcMain.handle(IPC.TEMPLATES_SET_ROOT, (_evt, raw) => {
    // 与文献库同一条规则:只改指向,不搬已有文件(搬文件由用户自己决定)
    const input = LibrarySetRootSchema.parse(raw);
    SettingRepo.set(TEMPLATE_ROOT_SETTING_KEY, input.path);
    return { path: templatesRoot() };
  });
}
