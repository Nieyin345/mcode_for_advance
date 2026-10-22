# T17｜文件类型路由统一：四份判据收成一份

- Status: ready-for-agent
- Category: bug
- Priority: P0 foundation
- Depends on: none
- Exclusive writable files: `packages/contracts/src/documentKind.ts`、`packages/contracts/src/genofficeFileRoute.ts`、`packages/contracts/src/ipc/onlyoffice.ts`、`apps/desktop/src/renderer/components/ide/fileEditorKinds.ts`，以及这些函数的调用点（逐个确认后写进回写区）。**不改** `genoffice/`、`patches/`、`arc005-visual-baseline/`、`workflowEngines/`。

## Required Skills
- `codebase-design`: 判断「统一路由」该放在哪一层、接口该多窄。
- `mcode-smoke`: 给每条扩展名判据建回归，并做变异验证。
- `code-review`: 确认旧函数只是变薄封装，行为一个字没变。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`packages/contracts/src/documentKind.ts`、`packages/contracts/src/genofficeFileRoute.ts`、`packages/contracts/src/ipc/onlyoffice.ts`、`apps/desktop/src/renderer/components/ide/fileEditorKinds.ts`、`apps/desktop/src/renderer/components/library/FilePreview.tsx`、`apps/desktop/src/renderer/stores/sessionStoreHelpers.ts`。

## 总控核实过的现状（不要凭印象重来）

已经存在三个契约层工具，但**没有把上层判据收干净**：

- `packages/contracts/src/documentKind.ts` —— `documentExtension()` / `documentKindOf()` / `isTextualDocumentKind()` / `isOfficeDocumentKind()`
- `packages/contracts/src/genofficeFileRoute.ts` —— `genofficeAppForPath()`
- `packages/contracts/src/ipc/onlyoffice.ts:109` —— `isOnlyOfficeSupportedPath()`（也在契约层，不是主进程）

仍在各自判定的地方（**至少三处**，执行时请核实是否更多）：

| 位置 | 判据 |
|---|---|
| `apps/desktop/src/renderer/components/ide/fileEditorKinds.ts` | `isPdfFile` / `isMarkdown` / `isImage` / `isUnsupported` / `languageForExt` |
| `apps/desktop/src/renderer/components/library/FilePreview.tsx:42` | `const extOf = documentExtension`（已部分统一） |
| `apps/desktop/src/renderer/stores/sessionStoreHelpers.ts:69` | `isMarkdownPath()` |

**注意**：`isOnlyOfficeSupportedPath` **已经在契约层**，不需要搬。这条事实推翻「四份判据都在上层」的旧假设——执行时以实际 `grep` 结果为准，不要照抄本表。

**这不是「再造一个路由表」的任务**——契约层已有三个入口。任务是：**把剩下散落的上层判据改为委托给契约层，并且证明行为没变。**

## 目标

1. 枚举**所有**仍在做「这个扩展名属于哪类」判定的位置（用 `grep` 找 `.docx` `.pptx` `.xlsx` `.pdf` `.md` `.html` 这类字面量与 `endsWith`/`extname`）。把完整清单写进回写区——**漏一个就算没完成**。
2. 判断每一处该委托给契约层的哪个函数；如果契约层缺能力，**在契约层加**，不要在调用方各自打补丁。
3. 把调用方改成薄封装（转调契约层），并**保持导出名与签名不变**，避免制造大面积 diff。
4. 给契约层建回归：一张扩展名 → 期望路由的表格，覆盖六类文档 + 图片 + 二进制 + 无扩展名 + 大写扩展名 + 多点文件名（`a.tar.gz`）。
5. **行为等价证明**：对一组代表性路径，改造前后的判定结果必须逐条相同。写一个脚本同时跑旧实现（备份）与新实现做对照。

## 关键风险

- `onlyoffice.ts` 在**主进程**，`fileEditorKinds.ts` 在**渲染端**。两者不能互相 import。统一只能落在 `packages/contracts`。
- 渲染端已经被拆过一次（`fileEditorKinds.ts` 的注释说「纯搬迁，函数体逐字节一致」）。**不要重演那种搬迁**——这次要真的收敛判据，不是再搬一次家。
- 大小写：Windows 上 `.DOCX` 与 `.docx` 必须等价，但 Linux 上不一定。契约层要给明确策略并测试。

## 验收判据

1. 回写区列出**全部**判据位置（含 `grep` 命令与命中数），无遗漏。
2. 契约层新增/扩展的判定函数有完整回归，覆盖上述边界。
3. 改造前后对照脚本输出「逐条相同」。
4. 变异验证：把契约层某条判定改错（如把 `.pptx` 判成 docx），对应回归必须变红；逐字节还原（`cmp`）。
5. 双包 typecheck 通过。
6. 不得为了统一而改变任何用户可见行为——如果发现某处行为本来就是错的，**单独记录，不在本卡修**。

## 结果回写（2026-10-23）

（执行者在此追加：完整判据清单、契约层改动、对照脚本输出、变异证据、提交 SHA、发现的既有 bug 候选）
