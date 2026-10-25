# O24｜Docs 真 Electron 主进程强杀→恢复→保存→第三进程重开

更新：2026-10-25。状态：**实现并验证 PASS（限 Windows、本次可复现夹具）**。这是 O21 已落盘的不可变恢复快照/版本冲突逻辑的真实产品级失败路径验收，不另造 GenOffice 运行时或恢复后端。

## 用户场景与边界

Mcode 中的原生 GenOffice Docs WebContentsView 打开受信工作区 DOCX，编辑器通过现有 preload `window.desktop.writeRecoveryCopy` 向 Mcode 主进程登记基于打开版本的 DOCX 恢复字节。假定**恢复副本已经成功提交**，Windows 意外终止承载编辑器的 Electron 主进程；Mcode 在新 OS 进程中再次打开 DOCX，应按用户确认从 recovery root 恢复文稿，而且不覆盖磁盘原件，直到通过 Mcode `saveOpenedFile` CAS 提交。

**不适用**：故障发生在首份恢复副本落盘之前、没有任何已经确认的恢复内容、被编辑器拒绝的 DOCX、加密 DOCX、磁盘/设备断电、全部外部模板兼容性。本任务不宣称覆盖自动恢复频率或端到端真实在线 AI 凭据。生成/打开/杀掉的都是隔离 U1 子进程，绝不碰用户正在使用的 Mcode。

## 核心实现

新增 U1 `step.crashRelaunch`，测试 Electron 子进程保存 `state.json` 的 `crashArmed` 之后，向测试启动器输出**本次进程专属 UUID 挑战标记**，并停留在活着的窗口/编辑器状态；子进程自身不得执行 `app.exit`、宿主 `dispose`、正常 close/save。

在外部 Node 启动器的已有 `runOwnedProcess` 中，只有监听到匹配 UUID 的本轮 stdout 标记时，监督器才调用仓库原有 `terminateOwnedTree`（Windows `taskkill.exe /PID <仅该 Electron PID> /T /F`）；跨平台没有新增用户进程扫描或不受控结束。子进程退出后监督器校验：
- 恰好匹配 `state.json` 中的 PID、generation、stepOffset 和活跃 crashArmed；
- `supervisorKilled === true`（**父进程自己确实执行了强制结束**，不是光看异常 exit code）；
- 退出不是正常的 0/77，也没有 spawn/timeout 错误。否则必须报意外失败而不是重新开始旅程。
- 校验后持久化 `confirmedCrash`，在第二代进程的旅程里独立确认其匹配第一代 PID，再逐项断言恢复文本、原件哈希不变、Mcode 正常 CAS 保存、第三代重新打开后无需恢复提示。

实现位置：`apps/desktop/scripts/lib/owned-test-process.mjs`、`apps/desktop/scripts/electron-u1/{build.mjs,driver/{runner.ts,steps.ts,types.ts}}`、`apps/desktop/scripts/office-perf-u1/journeys/docs-hard-kill-recovery.ts`，加 `journeys/index.ts` 和 `run.mjs` 白名单。**所有变更仅属于测试脚手架，不修改 Mcode/GenOffice 产品 UI 或生产保存通路。**

## 实际验证

1. 初版只看 `exit=1` 时，注入“正常 `app.exit(0)`”反例**竟然误判为通过**（Windows Electron 的退出码不能单独证明强杀）；已废弃初版判据，不能作为验收证据。
2. 完成独立监督器后，以 `MCODE_U1_MUTATE_CRASH_TO_NORMAL_EXIT=1` 注入正常退出，必须得到 `unexpected-failure`、工具 **exit=2**（真实记录 `.tmp/electron-u1/2026-10-25T13-57-42-730Z`）。即使子进程保存了 crashArmed 标记，外部监督器未实际执行 kill 时也不能验收。
3. 不使用反例环境变量，`node apps/desktop/scripts/office-perf-u1/run.mjs --only=docs-hard-kill-recovery` → **PASS；真 Electron 3 个 OS 进程**，父进程对第一代 PID `35756` 执行强制终止，日志显示 `[SIGKILL] verified ... exit=1`；第二代恢复、本体 DOCX 不变，CAS 保存成功；第三代打开保存内容。证据 `.tmp/electron-u1/2026-10-25T14-00-15-905Z`。
4. `node apps/desktop/scripts/electron-u1/build.mjs`：原有 3 条 U1 正常/文件保存重开/故意失败 → 两条通过 + 一条按预期失败，工具 **exit=1**（应有行为），证据 `.tmp/electron-u1/2026-10-25T14-02-05-065Z`。
5. `node apps/desktop/scripts/electron-u1/build.mjs --mutation=unconditional-pass`：按预期故意失败判据翻转为 PASS、套件 **exit=0**，证据 `.tmp/electron-u1/2026-10-25T14-02-32-854Z`。
6. Office 关联 `document-recovery-smoke t0-genoffice-native-tool-roundtrip-smoke o1-three-provider-ai-smoke genoffice-native-view-smoke` **4/4 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792936864756-10192-fC9oVJ`；Desktop/Contracts `tsc --noEmit` PASS。
7. `document-view-host-smoke` 重跑仍 **537/538**，旧内部 IPC 通道数固定断言未更新。其测试文件已有其他执行对话未提交修改，本批次不覆盖。
8. Windows 默认 `bash` 指向缺少 Node 的 WSL，仓库 `electron-u1/run.sh` 在此 shell 中因 `node: command not found` 无法直接跑；因此用 Windows 主机 `node build.mjs` 分别验证同一套正/反两趟，结果如上。此环境问题不等于产品编译失败。

**总控验收范围限制**：只读写临时 U1 数据根；ARC-007 不因本任务通过而标记全面通过。后续真实三 SDK 在线会话、WPS/跨平台、最新 NSIS 安装和被杀之前仍处于内存中的未持久化编辑继续待验。
