# O21–O23｜GenOffice 三项后端功能主线：原生 DOCX 恢复、AI 编辑事务、复杂 Office 内容保真

更新：2026-10-25。本卡为已实现与已验收功能的证据登记，不标记 ARC-007 整体验收完成；保持 O0/O1 以及其它并行任务所有原有结论。

## O21：Docs 二进制恢复（新增真实实现）

- Mcode `DocumentViewHost` 仅接受绑定的真实 DOCX sender、已提交文件会话和受信工作区，原厂 `mcode-view.ts` 把已有 `writeRecoveryCopy(path,ArrayBuffer)` 转交 Mcode 的 `mcode:document-view:write-recovery`。页面声称路径只作同一会话匹配，不构成可任意写盘授权。
- `documentRecovery.ts` 以 SHA256 文件身份将原厂 DOCX ZIP 恢复副本及受信原始内容版本写到 Mcode `dataRoot/docs/recovery`，限制大小、魔数/哈希及版本；并行写盘继续复用 `withOsFileLease` 和 `atomicReplaceFile`，不向 vendor 自己的 userData 写第二份文件。原 DOCX 只允许经 `saveOpenedFile` 版本检查 + 原子替换修改。
- 重新打开时，用户选择取消／恢复／丢弃；未经配置提示端口拒绝隐式恢复。旧快照被恢复而磁盘已改变时，**恢复会话携带快照的原始 `baseRevision`**，正常保存返回 `conflict`，不覆盖新磁盘版本。保存成功后清理旧副本，但不删已按新磁盘版本建立的新副本。用户明确放弃脏文件才清理旧缓存；页面自认干净的恢复稿关闭后依然保留。
- 原厂 fork commit `9cec29e38a972f60bec2e9d956f1aa2c8a02f085`，序列化补丁 `patches/genoffice/0031-feat-docs-mcode-guarded-crash-recovery.patch`；Mcode lock/校验器更新到 **31 补丁、tree 58381c33953f5255f7721b6a5f7e6c99fe860c4d**。
- `node apps/desktop/scripts/run-smokes.mjs document-recovery-smoke` PASS；真 Electron `node apps/desktop/scripts/office-perf-u1/run.mjs --only=docs-crash-recovery-mcode` PASS，**3 个不同 OS 进程**，证据 `.tmp/electron-u1/2026-10-25T08-39-49-643Z`。
- 外部写者的反例：`--only=docs-recovery-external-conflict` PASS，**2 个独立进程**，重开旧稿后正常保存必须报 conflict 且磁盘新版 SHA 保持不变；证据 `.tmp/electron-u1/2026-10-25T10-42-13-893Z`。

**尚未证明**：加密 DOCX 还原、多窗口同时替换/关闭所有极端调度、真实 OS 异常杀进程而不是独立 relaunch。格式校验为 ZIP 魔数与完整性 SHA，不宣称全量 OOXML 结构有效性。

## O22：Mcode AI 工具→真实编辑→CAS 保存→重开

- `--only=docs-ai-tool-native-transaction` 在真 Docs 渲染器和主进程中使用仅供测试的确定性 SDK **替身**（无在线模型凭据），通过生产 GenOffice Docs 主进程的流式 AI IPC、真实 renderer 受信工具执行与正确 ACK，在 ProseMirror 完成文本修改；伪造 ACK 和伪造文档路径均被拒，修改后的原文件需通过正常 Ctrl+S 和 Mcode `saveOpenedFile` 才会变更。
- 新 OS 进程重新打开真正写盘的 DOCX，改动仍在。2 进程 `1/1 PASS`；证据 `.tmp/electron-u1/2026-10-25T08-49-32-206Z`。
- 现有 `t0-genoffice-native-tool-roundtrip-smoke`、`o1-three-provider-ai-smoke`、`genoffice-ai-ask-smoke` **3/3 PASS**，分别对 Mcode SDK 工具接口和回执协议做无头的限定测试。真实网络/Claude、Pi、Codex 三者各自在线完成工具调用和完整 Mcode ChatPane 用户手势**未验证**，不得算正式 E2E 完成。此轮未另启 vendor AI。

## O23：Office 复杂内容保存保真

- Slides 原厂真实 `setNotes`、`setTransition`、`addSection`、`addComment`、`undo/redo`、`setAnimations`（文本框淡入，900ms）和 `addChart`（真实柱状图类别/数值），原生保存 PPTX，独立 Electron 进程重开后逐一读取确认。使用生产原厂 preload / 业务主进程，而非 Mcode 旧 fallback 里的静态空值。最新 `--only=slides-native-semantics` **PASS**；证据 `.tmp/electron-u1/2026-10-25T08-53-09-273Z`。
- Sheets 原生 Univer 创建 A1=5、B1=7、C1 `=SUM(A1:B1)`，经原厂 Shell 保存和 Rust sidecar 写 XLSX。独立 CLI 与 XLSX ZIP XML 验证数值与 `<f>SUM(A1:B1)</f>`，重启新进程后原厂计算模型仍有公式。 `--only=sheets-formula-native-roundtrip` **PASS**；证据 `.tmp/electron-u1/2026-10-25T09-01-44-720Z`。此项唯独在测试进程启用原厂 `GENOFFICE_DEBUG_HOOKS=1`，生产用户不暴露私有 Univer Facade。
- **范围约束**：未借助 Microsoft Office / WPS 第三方回读，未覆盖所有动画类型、跨表公式和宏文件，也未证明所有原厂 UI 点击路径。

## 本轮综合验收与待协调事项

- `node apps/desktop/scripts/run-smokes.mjs document-recovery-smoke genoffice-source-smoke genoffice-native-view-smoke slides-edit-smoke slides-preload-abi-smoke`：**5/5 PASS**；日志 `apps/desktop/.tmp/smoke-runs/1792925288414-36620-UYEspM`。
- `node apps/desktop/scripts/run-smokes.mjs t0-genoffice-native-tool-roundtrip-smoke o1-three-provider-ai-smoke genoffice-ai-ask-smoke`：**3/3 PASS**；日志 `apps/desktop/.tmp/smoke-runs/1792925011482-21308-2fMkBJ`。
- Desktop、Contracts `tsc --noEmit` PASS；带 `MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 的来源校验 **31/31** 成功。
- **已知一个历史测试更新需求**：`document-view-host-smoke` 当前 **537/538**，失败项把内部 IPC 通道数量写死为旧的八条；新增受信 `write-recovery` 后应更新该断言及对应安全检查。该测试文件本轮开始时已有其他执行对话的未提交修改，因此没有擅自改动/提交该共享文件；日志 `apps/desktop/.tmp/smoke-runs/1792925001983-31552-CaYSiZ`。这不是零失败整包验收。
- 保留全部其他修改，不使用 `git reset/clean/add .`；ARC-007 整体验收保持未勾选，真实三 SDK 在线凭据 / Office-WPS 交叉兼容 / 完整 NSIS 安装版继续待验。

### 最终回归补充（真实文件保存基准）

新发现并关闭了“页面读到旧字节，`open-committed` 期间外部文件更新，而会话随后采用新磁盘 hash 导致静默覆盖”的竞态：`readOpened` 在完成授权和磁盘版本复核后，将**本次交给页面的字节所基于的版本**存进待打开请求，`settlePendingOpen` 将该版本作为会话初始 CAS revision；恢复旧稿时仍以恢复 manifest 的旧 `baseRevision` 为准。此项增强同时防护普通打开和恢复打开的文件版本基准。

源码增强后顺序重跑全部三个 Docs 真 Electron 旅程：
- `docs-ai-tool-native-transaction` **PASS（2 OS 进程）**：`.tmp/electron-u1/2026-10-25T10-54-41-276Z`
- `docs-recovery-external-conflict` **PASS（2 OS 进程）**：`.tmp/electron-u1/2026-10-25T10-54-51-300Z`
- `docs-crash-recovery-mcode` **PASS（3 OS 进程）**：`.tmp/electron-u1/2026-10-25T10-54-59-059Z`
- `document-recovery-smoke` 补充新旧版本恢复副本清理的幂等与保留判据后 **PASS**：`apps/desktop/.tmp/smoke-runs/1792925619174-5184-ZanLlh`。
- `Desktop/Contracts tsc --noEmit`、**31 份** GenOffice fork 补丁签名/完整树校验再次 PASS。


### 2026-10-25 追加安全修复：恢复读写租约与丢弃确认的 TOCTOU

- 发现原 `inspectDocRecovery` 在**没有共享租约**时先读恢复 manifest 再读独立 DOCX bytes；另一个自动保存可能在两次读取之间替换快照，导致新旧配对的 SHA 不符而返回 `null`，让打开流程错过应有的恢复提示。现在整段检查、大小上限和 SHA256 校验全部处于既有 `withOsFileLease(filePath)` 之内，**没有新建第二层锁，也不允许更改源文件**。
- 如果获取读取租约超时（`FILE_VERSION_CONFLICT`），则显式向 Mcode `readOpened` 传播错误，而不再假装没有恢复副本。异常仍 fail-closed。
- 用户明确选“丢弃恢复副本”后，在获取同一租约时重新验证当前磁盘 revision；若确认期间外部文件变化则拒绝丢弃，保存恢复副本供重新决定。已确认丢弃的既有操作语义不变。
- `document-recovery-smoke` 新增 **4 项**：过期丢弃被拒、原快照保留、恢复读取在正在写入的 OS 租约之后排队、解除锁后读回完整原稿。**故意删除读取锁的反例**：19/20 通过、唯一 FAIL“recovery manifest and bytes inspection waits for active writer's OS lease”，日志 `apps/desktop/.tmp/smoke-runs/1792926923610-42748-1S2AwS`；逐字恢复保护后 **20/20 PASS**，关联 5 套 Office smoke **5/5 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792926992212-35732-kzxYzw`；Desktop / Contracts 两包 tsc **PASS**。
- 一次单独的 Desktop tsc 曾在并行 UI 修改期间报告 `WorkflowLibraryView.tsx` 的翻译键错误；未改其他对话的 UI 文件，随后的完整双包 tsc 已通过。
- 新代码的真实 Electron U1 最初被其他对话持有的 Mcode 重型测试锁阻止（`PID 7820`）；该次**未运行**，不能冒称通过。上文已经记录的 2–3 OS 进程成功旅程属于此补丁之前，需要在资源释放后重测。

**测试资源释放后的三条真实 Electron 补测（均针对本次读锁/丢弃保护源码）：**
- `docs-recovery-external-conflict` → **PASS / 2 独立 OS 进程**，`.tmp/electron-u1/2026-10-25T11-21-04-979Z`。
- `docs-crash-recovery-mcode` → **PASS / 3 独立 OS 进程**，`.tmp/electron-u1/2026-10-25T11-21-45-999Z`。
- `docs-ai-tool-native-transaction` → **PASS / 2 独立 OS 进程**，`.tmp/electron-u1/2026-10-25T11-22-04-417Z`。

备注：`document-view-host-smoke` 重跑仍为 **537/538**，唯一失败是旧 IPC 清单中固定内部通道数量（8）与新增 `write-recovery` 通道不符，见 `apps/desktop/.tmp/smoke-runs/1792926625324-33220-MmnUyv`。该测试文件正在其他执行对话中修改，本次不更改其内容；其余相关 5 smoke 与三套真实 U1 通过不代表这套旧验收已绿。


## 2026-10-25 最终交付前主线批次：强制崩溃存储 + Microsoft Office 真回读 + 32 号 PPTX 修复

### 恢复副本 v2 的真实崩溃边界

旧 Mcode 恢复存储 v1 顺次对固定 `key.docx` 和 `key.json` 两个目标原子替换：进程若在**新 payload 替换成功而清单尚未写入**时死亡，旧 manifest 会指向已经被覆盖的新 payload，旧恢复稿损坏或被静默遗漏。新 `documentRecovery.ts` 将 payload 置为 SHA256 内容寻址的**不可变文件**，确保新 payload 先 fsync 落盘，最后原子替换唯一有效 manifest 指针。清理仅在完整提交后按 hash 白名单执行；保留 v1 旧格式的读取和清理兼容。任何已提交清单损坏、清单指向的字节缺失或哈希校验错误**必须拒绝打开并保留证据**，不把恢复失败解释为“没有恢复稿”。Mcode `DocumentViewHost.readOpened` 将拒绝转换为可见 `ok:false/reason`，避免未经确认静默载入旧文件。

`document-recovery-smoke` 新增崩溃中断注入、原快照留存、新快照切换、旧文件迁移读取、损坏清单 fail closed，以及**独立 Node OS writer 进程**在新 snapshot fsync 完成后、manifest 提交前被父进程 `SIGKILL` 真终止，主进程随后自动回收死进程文件租约、旧恢复稿与原始 DOCX 均完好。**32/32 PASS**（`apps/desktop/.tmp/smoke-runs/1792934895195-10844-giPGVb/document-recovery-smoke.log`；后续完整关联 `6/6` 独立组合 PASS，见日志 `1792933269903-9464-1mWuE9`）。这是恢复 writer 的真实进程终止，**并非对生产 Electron 主进程直接 kill**，两者范围不可混淆。

v2 写盘修复后真 Electron：`docs-crash-recovery-mcode` 3 个 OS 进程 PASS（`.tmp/electron-u1/2026-10-25T13-02-51-850Z`）、`docs-recovery-external-conflict` 2 进程 PASS（`.tmp/electron-u1/2026-10-25T13-03-01-736Z`）、`docs-ai-tool-native-transaction` 2 进程 PASS（`.tmp/electron-u1/2026-10-25T13-03-09-049Z`）。所用是真正 Mcode 受信 session + GenOffice 原生 Docs，但 AI 工具由确定性 SDK 替身驱动，不冒充在线 Claude/Pi/Codex。

### 真实 Microsoft PowerPoint 拒绝打开的产品缺陷（本轮已修）

1. 真实 Mcode Slides 保存的含备注/动画/图表 PPTX 可被 GenOffice 自身和 Python `python-pptx` 读取，但 `PowerPoint.Application.Presentations.Open(..., ReadOnly=True, WithWindow=False)` 报错。已有官方 Microsoft Office 安装于当前 Windows 系统（仅未列入 PATH），通过 `DispatchEx` 独立只读 COM 实例完成验证。
2. 新增 U1 `slides-ms-office-interop-isolation`（真实原厂 native renderer/main/preload + Mcode Host）逐步保存独立的 **7 份 PPTX**：baseline、notes、transition、section、comment、animation、chart，按次序操作、真实落盘。修复前真实 Microsoft PowerPoint **仅 baseline PASS，其他 6 份 FAIL**（`.tmp/electron-u1/2026-10-25T13-14-57-047Z`）。
3. 验证 ZIP CRC 无损、XML 语法有效、内部 relationship target 存在；重新压缩、`python-pptx` 重保存仍失败，原始 baseline 能被微软打开。用 OOXML 手术对照证明只移动 `ppt/presentation.xml` 内的 `p:notesMasterIdLst`，使其在 `p:sldIdLst` **之后**而非原厂的 `p:sldMasterIdLst` 之后，就能让微软 PowerPoint 打开并访问备注。
4. **修复 GenOffice 真源码** `packages/pptx-engine/src/notes.ts`：新生成和已有自闭合空列表均需插在正确的 slide ID list 后，而不是原位替换或直接删除元素。添加 `speaker-notes.test.ts` 失败优先的反例，旧代码 **11/12、唯一 FAIL**（`notesStart=365` 早于 `slideEnd=479`），修改后连 `notes-comments.test.ts` 共 **20/20 PASS**，PPTX engine + Slides 两套 TypeScript PASS，Slides 生产 electron-vite 构建 PASS。
5. **真正的跨软件绿证据**：用同一个 U1 + Microsoft PowerPoint `ppt_matrix.py` 重跑，`7/7` 全 PASS（`.tmp/electron-u1/2026-10-25T13-23-13-170Z`）。微软 COM 读取到 `Interop stage notes` 正文、1 条动画、图表对象及一个数据系列，不只是 PowerPoint 启动成功。原厂 fork commit `f174a91f27c3f499fc5be1d6aa7cc3f63204addd`，tree `5164ed29fb33cc6d6dd7fc6939861c553648d94c`，第 32 条源代码补丁 `patches/genoffice/0032-fix-pptx-notes-master-order-powerpoint.patch`，SHA256 `65437076a8725f341bae7200f18a340b6f3b12f95da0dd1ed48b1f3583f1d672`，**32/32 来源校验通过**。
6. 独立第三方 Office 样本交叉回读：真 AI 修改 DOCX、真 XLSX `A1=5 B1=7 C1=SUM(A1:B1)`、真 PPTX 带备注动画图表，`readback.py --with-office` → `openpyxl/python-pptx/zipfile` **3/3 PASS**，真正安装的 Microsoft Word、Excel、PowerPoint 的只读 COM **3/3 PASS**。环境未发现 WPS、LibreOffice；只表示这三份样本及这台机器通过。可复跑说明位于 `apps/desktop/scripts/office-interop/README.md`。
7. `node apps/desktop/scripts/run-smokes.mjs o3-packaged-smoke` → 现有 `win-unpacked` 解压版六格式验收 PASS（`apps/desktop/.tmp/smoke-runs/1792933338935-27572-g4Hgbg`），**但此旧构建不含本轮源码修复**；现有 `release/Mcode-0.1.62-x64.exe` Authenticode **NotSigned**；未申请证书、未擅自重打包、未运行 NSIS 安装/升级/卸载，故正式发布未达到验收。
8. Office smokes 源码、SDK 协议、native view、release 输出等已分别验证；尝试一次含复杂 `o0-format-fidelity-smoke` 的十套合集因执行时间长超时，不能把整批写为 10/10 PASS，必要日志分别保留于 `apps/desktop/.tmp/smoke-runs/1792934895195-10844-giPGVb`。双包 Mcode `tsc --noEmit` PASS。
9. `document-view-host-smoke` 旧的 8 通道数目硬编码仍导致 537/538；该套已有并行对话的未提交修改，故本批次不擅自覆盖。仍未得到三在线 SDK 真凭据；WPS、跨 OS、全面复杂格式与 **最新源码**的安装版验收仍需继续。**ARC-007 整体验收不得勾选**。
