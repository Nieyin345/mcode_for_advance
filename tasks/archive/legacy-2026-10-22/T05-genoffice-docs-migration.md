# T05｜GenOffice Docs 全功能迁移（第二轮）

| 项目 | 值 |
|---|---|
| 编号 | T05 |
| 类型 | ARC-007（用户拍板：在 vendor 源码上直接二开） |
| 优先级 | 高 |
| 建议并发 | 可与 T01–T04 并行，但**不要**与任何改 `src/main/document/` 的任务并行 |
| 预计规模 | 大 |

---

## 为什么做这个任务

第一轮（提交 `d6f0f320` / `499b0cc8`，上游 `8d379b1d`）已经完成：

- GenOffice 分支 `mcode/integration`（基线 `73ba918`）
- Vendor Docs 受限 preload `genoffice/apps/docs/src/preload/mcode-view.ts`
- Mcode 侧 `docsVendorPreload.ts` / `docsVendorIpc.ts`，vendor 缺失时回退旧安全桩
- 四套 document-view smoke 全绿

**但第一轮自己写清楚了 remaining**：

> 1. Vendor 主进程目前只迁入了字体度量和拼写语言相关的 **3 个**受控 IPC handler。
>    原厂完整 `docs-main.ts` 业务注册尚未逐功能完成安全适配。
> 2. Mcode 原手写 Docs 桥仍作为 fallback，没有彻底删除。
> 3. 原厂完整菜单、受控导出、附件、加密及文档内 AI 操作尚未达到功能等价。

本任务就是把这三条做完（**只做 Docs，不碰 sheets/slides/pdf**）。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）+ `docs/planning/arc007-genoffice-native-integration-map.md`
   全文（这是路线图，尤其是「2026-10-20 用户拍板」那一节）。
2. `apps/desktop/src/main/document/documentViewHost.ts`、`docsVendorIpc.ts`、
   `docsVendorPreload.ts`（三个文件都不长，全读）。
3. `genoffice/apps/docs/src/main/mcode-ipc.ts` 与 `genoffice/apps/docs/src/preload/mcode-view.ts`
   —— 第一轮写的边界层。
4. `genoffice/apps/docs/src/main/docs-main.ts` —— **要迁的就是它**，先通读并列出
   所有 IPC handler 与其权限需求。
5. `patches/genoffice/0001-*.patch` —— 第一轮补丁，理解它的形式（上游改动必须以
   patch 形式同时存在于 Mcode 仓库）。

---

## 执行内容

### 1. 逐 handler 迁移（核心）

把 `docs-main.ts` 里注册的 IPC handler 分成三类并**逐条**处理：

| 类别 | 处理方式 | 判据 |
|---|---|---|
| **纯文档操作**（读写当前打开的文件、渲染、导出、查找替换） | 迁入 `mcode-ipc.ts`，走 Mcode 的路径围栏与 `DocumentViewHost` | 必须能在**隔离虚构文件**上跑通 |
| **需要新权限的**（附件、外部链接、剪贴板写入、加密） | **默认拒绝**，除非用户在 Mcode 的审批 UI 里明确授权 | 拒绝路径必须有断言 |
| **明确不要的**（云 AI、用户身份、遥测、任意路径访问） | 不迁，在 `mcode-ipc.ts` 里显式注释"为什么不要" | 源码可查，不是靠约定 |

**逐条记录**：在 `docs/planning/arc007-genoffice-native-integration-map.md` 里
追加一张表，每行一个 handler：`handler 名 | 类别 | 处理结果 | 验证它的 smoke/断言`。
**没有验证方式的行，视为未完成。**

### 2. 删除 fallback

第一轮保留了「vendor 缺失时回退到 Mcode 手写桥」。现在判断：

- 如果 vendor preload 已经能覆盖手写桥的全部能力 → 删掉手写桥
  （`documentViewPreload.ts` 里对应的部分），并在启动时对 vendor 缺失给出**显式错误**
  （不是静默降级）。
- 如果还有能力没覆盖 → 保留 fallback，但在回写区逐条列出**哪一项**没覆盖。

⚠️ 删除前先确认 `apps/desktop/electron.vite.config.ts` 的打包逻辑不依赖它。

### 3. 功能等价验收

新增 `apps/desktop/scripts/docs-vendor-parity-smoke/`：

用**真实 vendor Docs 页面 + 真实 Electron**（复用 `document-view-electron-smoke`
的脚手架，不另造）验证：

1. 打开一个 `.docx` → 编辑 → 保存 → 关闭 → 重开 → 字节回读一致
2. 打开一个 `.md` → 同上
3. 编辑期间另一进程修改磁盘文件 → 保存时**拒绝写入**并给出冲突提示
   （这是 `DocumentViewHost` 已有的 expectedRevision 机制，验证它在 vendor 路径上真的生效）
4. 「不改只关闭」**不得重写文件**（对比 mtime 与 hash）
5. 附件/外部链接/剪贴板写入：**默认拒绝**，且拒绝原因可读

### 4. 更新上游补丁

所有对 `genoffice/` 的改动必须同步产出 patch 到 `patches/genoffice/`，
并在 `docs/planning/arc007-genoffice-native-integration-map.md` 记录：
上游基线 SHA、新提交 SHA、patch 文件名。

---

## 边界（不要碰）

- **不要**碰 `genoffice/ee/`（企业条款）。
- **不要**碰 sheets / slides / pdf / markdown / html 五个 app。
- **不要**改 renderer（Mcode 渲染端）。
- **不要**改 `apps/desktop/src/main/document/documentViewHost.ts` 的接口签名
  （别的任务可能依赖）；可以改实现。
- **不要** push 到任何远程（包括 genoffice 的 origin）。
- 不要引入 GenOffice 的 agent loop / 聊天 UI / 云 AI / 第二个 MCP 写盘通道。

---

## 验收判据

1. `docs-vendor-parity-smoke` 五条全绿，其中第 3、4 条必须有**变异验证**：
   撤掉 expectedRevision 检查 → 冲突断言变红；撤掉"不改不写"判据 → mtime 断言变红。
2. handler 迁移表里**每一行都有验证方式**，没有空行。
3. 现有四套 `document-view-*` smoke 全绿。
4. 双包 tsc + GenOffice Docs 的 tsc 全绿。
5. `patches/genoffice/` 下的 patch 能干净地应用到基线 SHA 上（用 `git apply --check` 证明）。

---

## 你要在回写区回答的问题

- 一共有多少个 handler？分类后各多少？没迁的有哪些、为什么？
- fallback 删了没有？没删的话缺哪一项能力？
- 有哪些 Docs 功能是**上游本来就没有**、需要 Mcode 侧补的？（这决定下一轮）
- 文档内 AI 操作这条线，现在是什么状态？（上游有 AI 面板，但用户要求对话必须由
  Mcode 三引擎驱动 —— 如果没接，明确说没接）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
