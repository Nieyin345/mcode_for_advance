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
