# T25｜按 pinned HEAD 重建 GenOffice 六家 vendor 产物

- Status: ready-for-agent
- Category: build
- Priority: **P0 发行前置**（不重建则 staging 必然 fail-closed，打不出包）
- Depends on: T23（已交付 `239eb863`）
- Exclusive writable files: `genoffice/apps/*/out/`（构建产物）、`apps/desktop/build/genoffice-upstream.lock.json`（若 digest 需要刷新）、相关校验脚本。**不改** `genoffice/` 源码、`patches/`。

## Required Skills
- `research`: 确认构建命令与 pinned HEAD 的关系，不要凭猜测跑构建。
- `mcode-smoke`: 建「产物 freshness」的断言，并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T23-production-preload-staging.md`（**回写里说明了 C 只在检测层修好**）、`docs/planning/product-roadmap/T13-genoffice-baseline.md` **§2 发现 C** 与 **§12 T-C**、`apps/desktop/build/genoffice-upstream.lock.json`、`apps/desktop/build/verify-genoffice-upstream.cjs`、`genoffice/package.json`。

## 事实（T13 + T23 已核实）

- GenOffice 嵌套仓 HEAD `635dee2f`，tree `532e6727`，锁定于 `genoffice-upstream.lock.json`（`format: mcode.genoffice.upstream-lock.v2`）。
- 13 个 Mcode 补丁（`patches/genoffice/0001..0013`）已被 `verify-genoffice-upstream.cjs` 钉死 revision/parent/SHA-256。
- **但 `genoffice/apps/*/out/` 的构建产物时间戳是 2026-10-18/10-19，而补丁 0013（ACK 协议）是 2026-10-22 落地的。**
- 证据：`grep -r "ai:tool-result" genoffice/apps/docs/out/renderer/assets/*.js` → **0 命中**；而源码 `apps/docs/src/renderer/ai/transport.ts:7-10` 已在用 `window.desktop.aiToolResult`。
- 六家 `out/renderer` 均早于 T29/T54/0011/0012 的改动。

**后果**：任何用现有 `out/` 产物的真实验证，都没验到 0013 的 renderer 半边。T23 已让 staging 对此 fail-closed——**所以现在打不出包，这是正确行为，但必须解决。**

## 目标

按 pinned HEAD 重建六家 renderer 与 preload，让产物包含全部 13 个补丁的效果，并让 freshness 可被机器校验。

### 必须做到

1. **先确认构建前置**：`genoffice/` 的依赖是否已装、构建工具链（vite/tsc/esbuild）是否齐备。**不要盲目 `npm ci`**——那会改动 `node_modules` 且可能耗时很长。先检查 `node_modules` 是否存在、版本是否匹配 lock。
2. **按 pinned HEAD 构建六家**：`docs` / `sheets` / `slides` / `pdf` / `markdown` / `html` 的 renderer 与 preload。
   - 参考 `genoffice/package.json` 的 `build:all` 脚本。
   - **构建必须可复现**：记录确切命令、Node 版本、构建耗时。
3. **验证产物包含 0013**：
   - `grep ai:tool-result` / `aiToolResult` 在 `apps/docs/out/renderer` 与 `out/preload` 里**必须命中**。
   - 六家的 `out/preload/index.js` 都存在。
4. **刷新 digest**：如果 `genoffice-upstream.lock.json` 或 staging 的资源 digest 依赖产物哈希，同步更新。
5. **建 freshness 断言**：新增一套 smoke，断言「产物的 mtime 或内容标记不早于 pinned HEAD 的补丁时间线」。**不能只靠人眼看时间戳。**
6. **变异验证**：把某家的产物恢复成旧版本 → freshness 断言必须变红 → 逐字节还原（`cmp`）。

## 硬约束

- **不改** `genoffice/` 源码、`patches/genoffice/`。
- **不改** `apps/desktop/electron.vite.config.ts`、`build/stage-genoffice-resources.cjs`（T23 刚交付；只在你确实需要联动时说明）。
- **不跑 `git clean` / `git reset`** 在 `genoffice/` 里。
- 构建耗时可能很长（六家 renderer）。**如果超过合理时间，分批构建并记录进度**，不要让它静默卡死。
- **必须提交**，但产物本身是否入库要看 `.gitignore`——若 `genoffice/` 被忽略，只提交 digest/lock 与 smoke 代码，产物不入库。

## 验收判据

1. 六家 `out/renderer/index.html` 与 `out/preload/index.js` 都存在且非空。
2. `ai:tool-result` 在 Docs 的 renderer 与 preload 产物里**命中**。
3. `production-build-preload-smoke` 与 `genoffice-editors-release-smoke` 仍绿。
4. 新增的 freshness smoke 能检出「产物早于补丁」的状态（变异证明）。
5. 记录构建命令、耗时、Node 版本，可复现。
6. **不得**宣称 T7（六编辑器 U1）完成。

## 结果回写（2026-10-23）

（执行者在此追加：构建前置检查结果、确切命令、六家产物清单与大小、0013 命中证据、digest 变更、freshness smoke 结果、变异证据、提交 SHA、耗时）

## 风险提示

构建六家 renderer 可能需要数分钟到数十分钟。如果发现某家构建失败：
- **先报告失败原因**，不要跳过它继续
- 如果是依赖缺失，先解决依赖
- 如果是补丁应用不上，停下报告——那意味着补丁链与 pinned HEAD 不一致
