# T13｜GenOffice 六原生编辑器功能与接线基线矩阵

- Status: ready-for-agent
- Category: task
- Priority: P1 strategic baseline; release/license risks are P0 where applicable
- Depends on: none
- Exclusive writable files: only new report docs/planning/product-roadmap/T13-genoffice-baseline.md. Read source freely; do not edit GenOffice nested repo, patches, license notices, tasks/README.md, or other reports.
## Required Skills
- research: collect source-backed version, upstream, license and implementation evidence.
- code-review: verify each claimed integration against the real call path and tests.
- mcode-smoke: classify existing smoke evidence and avoid overclaiming GUI coverage.
- Read each named Skill's SKILL.md before work.
- Read before work: CLAUDE.md, audit-ledgers/README.md, audit-ledgers/Mcode_统一审查台账.md, .scratch/mcode-product-roadmap/spec.md, archived legacy T71/T76/T87/T89/T90/T92, and current T0/T7/T9/T11 cards.
- Goal: produce a six-editor matrix for Docs, Sheets, Slides, PDF, Markdown and HTML, grounded in the nested Git SHA and exact source paths.
- Execute: record outer Mcode HEAD, nested GenOffice HEAD/status and full outer git status; preserve all dirty state. For each editor map native UI, business/core packages, preload/Host bridge, open/edit/save/reopen, import/export, AI interactions, native resources/sidecars, existing tests, license provenance and U1 evidence. Read-only only.
- Acceptance: each of six formats has source path, actual integration path, proven behavior, missing/unknown features, tests and real U1 status; separate CLI/API success from GUI integration; list version-specific release blockers without changing any license policy; recommend next bounded tasks and non-overlapping file owners.
- Do not: edit nested GenOffice or license files, run destructive tests on user documents, or claim six-editor acceptance without real Electron evidence.
- Result writeback: report path, both Git SHAs/statuses, sources/commands inspected, U1 gaps, release blockers, commit SHA.

## 结果回写（2026-10-23）

### 报告

- `docs/planning/product-roadmap/T13-genoffice-baseline.md`（六类 × 源码路径 / 调用链 / 已验证行为 / AI / 资源 / 测试 / 许可 / U1，另含三个跨格式发现、保存所有权对照、AI 矩阵、10 项精确许可阻塞、7+2 条未解问题、8 条后续建议）。

### Git 快照（保留全部 dirty，未 reset/clean）

- **Mcode 外层 HEAD（开工）**：`2c93f70ef863084426790c46c11e916644b43904`（`master`，领先 `origin/master` 332）。开工 dirty（7 项，他人）：
  `.aoci/baseline.json`、`.gitignore`、`apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts`、`apps/desktop/scripts/orchestration-ipc-smoke/run.sh`、`apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs`、`apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`apps/desktop/src/main/ipc/settingsTransfer.ts`。
- **调查期间外层 HEAD 被并行会话推进**到 `eb3f1e0b5d9f5ec79e4c9f16fa2d6ee18c6506ed`，并出现并行 T0 施工的 dirty：`apps/desktop/src/main/document/docsAiPorts.ts`、`nativeEditorToolTransport.ts`、`tasks/T0-genoffice-native-tool-roundtrip.md`、`apps/desktop/scripts/smokes-for.py`、`osFileLease.ts`、`fileExecutorOwnershipStore.ts`，以及未跟踪目录 `apps/desktop/scripts/executor-owner-cross-process-cas-smoke/`、`apps/desktop/scripts/t0-genoffice-native-tool-roundtrip-smoke/`。全部原样保留。
- **GenOffice 嵌套仓**：HEAD `635dee2f6a38d7f0a3aec31a487afc3e2369a5cf`，分支 `mcode/integration`，工作树**干净**；tree `532e6727eb1f4e94e686cee1ab55a99bddf8f6f0`，与 `genoffice-upstream.lock.json` v2 及 `verify-genoffice-upstream.cjs` 常量一致。

### 读了什么 / 跑了什么

- 读：`CLAUDE.md`、`tasks/T13`、`tasks/README.md`、`audit-ledgers/README.md` 与统一台账相关段、`docs/planning/mcode-product-roadmap.md`、`.scratch/mcode-product-roadmap/spec.md`、归档 T71/T76/T87/T89/T90/T92，当前 T0/T7/T9/T11，以及 `research`/`code-review`/`mcode-smoke` 三份 `SKILL.md`。
- 读源码：Mcode `documentViewHost.ts`、`genofficeViewFactories.ts`、`genofficeNativeVendor.ts`、`ipc/documentView.ts`、`ipc/document.ts`、`ipc/index.ts`、`electron.vite.config.ts`、`docsAiPorts.ts`、`nativeEditorToolTransport.ts`、`docsPrivilegedPorts.ts`、`slidesBridge.ts`、`slidesExecutor.ts`、`GenofficeViewHostPane.tsx`、`FileEditor.tsx`、`release-readiness-smoke/check-unpacked.cjs`、`build/stage-genoffice-resources.cjs`、`build/verify-genoffice-editors-after-pack.cjs`、`build/verify-genoffice-upstream.cjs`、`genoffice-upstream.lock.json`、许可证 manifest；vendor 六家 `src/{main,preload,renderer,shared}` 关键文件、`packages/{agent-core,electron-utils}`、`patches/genoffice/0001..0013` 的 touched-file 清单。
- 只读命令：`git rev-parse/status/log/show/grep/diff`、`Read/Grep`、`bash apps/desktop/scripts/smokes-for.sh --uncovered`、`node -e` 读文件、读 `.tmp/smoke-runs/**` 与 `.tmp/genoffice-ai-ask-*/checks.json`。
- **唯一越界（非破坏）**：误执行一次默认 `run-smokes.mjs`（17 套 critical）→ 16 PASS，`mcp-endpoint-smoke` FAIL 于 esbuild 无 `.node` loader（sherpa-onnx，与 GenOffice 无关）；只写 `.tmp`。已如实记录在报告 §0.4。

### 三个跨格式发现（E2 + 构建产物）

1. **生产构建不产出 `documentViewPreload.js`**：`resolveViewPreload()` 指向 `out/main/documentViewPreload.js`，但 `electron.vite.config.ts` 的 main/preload 入口从未声明它（22 个历史版本逐版 grep 零命中），`apps/desktop/out/` 也无该产物。四个真 Electron 套件各自把该文件 esbuild 到探针目录，故全绿而发行面可能无桥。
2. **发行 staging 只复制 sheets/slides preload**（`stage-genoffice-resources.cjs`、`verify-genoffice-editors-after-pack.cjs` 均 `["sheets","slides"]`），而工厂对六种 kind 都要求 `out/preload/index.js` → 安装包内 PDF/Markdown/HTML 原生视图 `status=false`，显式降级。
3. **vendor `out/renderer|preload` 产物旧于 0013**（`ai:tool-result` 在 Docs 产物中 0 命中），任何用现有产物的 harness 都没验到 0013 的 renderer 半边。

### 六类真实 U1 状态（均无 U1(shipped)）

| 格式 | U1 状态 | 最大缺口 |
|---|---|---|
| Docs | U1(harness) 正控（open 39/39、electron 17/17、vendor-page 9/9、AI Ask 20/20 mock）；U1(shipped) 缺失 | 发现 1（构建缺 preload）；T0 同轮工具在 HEAD 仍 fail-closed |
| Sheets | E1 only | 无任何真 Electron 打开/编辑/保存/重开 |
| Slides | U1(harness) 正控（open 段 + slides-edit 12/12，后者用 vendor 全量 preload）；U1(shipped) 缺失 | 生产 native 路线保存走 vendor 直写、无 Mcode CAS；双路线打开时序未验 |
| PDF | E1/E2 only | 无 GUI U1；发现 2（preload 未 staging）；pdfium/hb-subset WASM 路径不一致 |
| Markdown | E1/E2 only | 无 GUI U1；发现 2；`md-asset://` 特权未注册（E3） |
| HTML | E1/E2 only | 无 GUI U1；发现 2；`html-asset://`/`html-preview://` 特权未注册（E3） |

### 发行阻塞（精确版本，不改策略）

- 许可证：manifest `8/18 verified、10 blocked、releaseEligible=false`。10 项：`@electron-internal/extract-zip@1.0.5`、`lazy-val@1.0.5`、`ot-text-unicode@4.0.0`（ISC/MIT 冲突）、`react-remove-scroll-bar@2.3.8`（权利方必补）；`fastdom@1.0.12`、`hash.js@1.1.7`、`isarray@1.0.0`、`ot-json1@1.0.2`、`strictdom@1.0.1`、`unicount@1.1.0`（取证完成，取决于载体政策裁决）。T11 未开始。
- 技术：发现 1（Docs preload）、发现 2（三格式 preload staging）、发现 3（vendor 产物重建）、PDF WASM 布局、T0 未提交、六类无安装包 U1。

### 提交

- 提交 SHA：`03e30e73dece1940dce028fa3b6fe94ba6c226ba`（只含 `docs/planning/product-roadmap/T13-genoffice-baseline.md` 与本卡回写；其余并行 dirty 未暂存、未改动）。
- 提交后外层 HEAD：`03e30e73`；GenOffice 嵌套仓仍为 `635dee2f`（干净）。
