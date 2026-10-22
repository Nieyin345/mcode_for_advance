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

### 一、构建前置检查

| 项 | 实测值 |
|---|---|
| `genoffice/node_modules` | 存在，635 个包（与总控一致，未跑 `npm ci`） |
| Node / npm | v22.21.1 / 10.9.4（`engines` 要求 node >=22.12.0，满足） |
| electron-vite / electron | 5.0.0 / 43.7.6 |
| `apps/desktop/build/verify-genoffice-upstream.cjs`（`MCODE_INCLUDE_GENOFFICE_BUNDLE=1`） | PASS：HEAD `635dee2f`、tree `532e6727`、13 补丁链、工作树干净——**补丁链与 pinned HEAD 一致，没有补丁应用问题** |
| 构建前产物状态 | 六家 `out/preload/index.js` 时间戳 2026-10-18/19；`grep aiToolResult` docs renderer = 0 命中（复现了陈旧状态） |
| Rust 工具链 | **本机未安装 cargo/rustc**（见下方 sheets 说明） |

### 二、确切命令、Node 版本与耗时

Node v22.21.1，工作目录 `D:\destop\work_space\work_for_reseach\mcode\genoffice`：

```bash
npm run build -w @genoffice/docs                       # 13s wall，vite 报 6.54s
npm exec -w @genoffice/sheets -- electron-vite build   # 22s wall（见下）
npm run build -w @genoffice/slides                     # 10s wall，2.62s
npm run build -w @genoffice/pdf                        #  6s wall，1.96s
npm run build -w @genoffice/markdown                   # 13s wall，9.78s
npm run build -w @genoffice/html                       #  9s wall，1.54s
```

**sheets 的唯一偏差（如实记录）**：`npm run build -w @genoffice/sheets` 的脚本是 `npm run native:build && electron-vite build`，第一步 `cargo build --release` 因本机无 Rust 工具链失败（EXIT=1，失败点是 `native:build`，**不是** renderer 构建）。核实后改用等价的 `electron-vite build` 构建 renderer/preload，两条依据：

1. 13 个补丁**无一触及 Rust 源**（`grep "^diff --git" patches/genoffice/*.patch | grep -E "\.rs$|Cargo"` → 无输出）；Rust 源自基线 `1f306a2` 未变，`cargo build` 只会重编同一份源码。
2. 所需的 sidecar 二进制已存在，且 SHA-256 = `9e455b56…25a5` 与 `target/release/PROVENANCE.md` 记录的上游 v0.11.0 提取物一致；staging（`stage-genoffice-resources.cjs:487,507`）消费的就是这颗预编译 exe，不依赖本次 cargo 重建。

若要求"六家全部按 build 脚本一字不改地跑绿"，需先在本机装 Rust 工具链后重跑 sheets——但产物内容不会变（Rust 源未变、sidecar 已就位）。

### 三、六家产物清单（构建后）

| 应用 | `out/renderer/index.html` | `out/preload/index.js` | renderer 体积 |
|---|---|---|---|
| docs | 715 B | 29,566 B | 26 MB |
| sheets | 641 B | 140,583 B | 34 MB |
| slides | 844 B | 22,706 B | 8.3 MB |
| pdf | 775 B | 12,731 B | 8.1 MB |
| markdown | 660 B | 13,713 B | 15 MB |
| html | 683 B | 11,500 B | 2.8 MB |

全部存在且非空；所有生成产物 mtime 均为 2026-10-23 06:43–06:48。

### 四、0013 命中证据

**Renderer 半边（必须的判据）——命中：**

```
$ grep -o aiToolResult   genoffice/apps/docs/out/renderer/assets/index-CvCqczP5.js | wc -l   → 1
$ grep -o toolResultAck  genoffice/apps/docs/out/renderer/assets/index-CvCqczP5.js | wc -l   → 9
$ grep -rlo "ai:tool-result\|aiToolResult" genoffice/apps/docs/out/renderer/assets/*.js      → index-CvCqczP5.js
```

构建前的同一断言在旧备份上全部为 0（`.tmp/T25-old/docs-renderer` 四个 JS 均 0 命中）——新旧产物在这个判据上可区分。

**Preload 半边——一个需要更正的认知**：`grep toolResultAck genoffice/apps/docs/out/preload/index.js` → **0 命中，且重建前后该文件逐字节相同**（`diff` 无输出，29,566 B 不变）。原因不是构建失败，而是 0013 的 preload 改动落在 `apps/docs/src/preload/mcode-view.ts`，vendor 自己的 `src/preload/index.ts` 从不 import 它（`git log -- apps/docs/src/preload/index.ts` 停在基线 `1f306a2`）；这份 `mcode-view.ts` 由 **Mcode 的生产构建**经 `electron.vite.config.ts:371` 的 alias 编入 `out/main/documentViewPreload.js`（T23 交付路径）。实测 `apps/desktop/out/main/documentViewPreload.js` 含 `ai:tool-result`×2、`aiToolResult`×1。`transport.ts:7` 的注释也明说 "The original standalone preload intentionally does not expose aiToolResult"。

所以任务卡里「`out/preload` 必须有 0013 命中」这一条按字面**不成立**，正确的等价判据是：**Docs renderer 含 ACK 标记**（本卡已满足）**且 Mcode 的 `documentViewPreload.js` 含 ACK 桥**（T23 的 `production-build-preload-smoke` 18/18 覆盖，其中一条断言要求 `mcode:docs:ai-tool-result` 出现在产物里）。六家 `out/preload/index.js` 全部存在且非空（上表）。

### 五、digest 变更

**`genoffice-upstream.lock.json` 无需改动。** 查清后的依据：该 lock 只钉源码身份（revision/tree/13 补丁的 SHA-256/字节数），**不含任何构建产物哈希**。产物 digest 由 staging 在打包时现场计算并写入 `<appDir>/.tmp/genoffice-release/availability.json`（`editorAssetsSha256` / `editorPreloadSha256`），该文件在 `.gitignore`（`.tmp/`）内，不入库；afterPack 再对同一份 stage 复算比对。仓库里没有第二处提交了旧 digest（`grep 8840c3d1\|920d8dbf` 无命中）。因此本次无 digest 文件变更，重建后的新 digest 在下次 staging 时自然生成。

刷新后的 renderer digest（供 staging 现场消费，仅记录）：
docs `7f895e93…5705`、sheets `f9833eff…eceb8`、slides `b1c5b642…0178`、pdf `bb57aaab…976a`、markdown `9482d94a…78ab`、html `60081e8a…9f03`。

**产物是否入库**：`genoffice/` 在 Mcode 根 `.gitignore:70` 被整体忽略，`out/` 也在嵌套仓 `.gitignore:2` 忽略——产物不入库，本次只提交 smoke 代码与回写。

### 六、freshness 断言（新增套件）

新建 `apps/desktop/scripts/genoffice-vendor-freshness-smoke/`（`main.cjs` + `run.sh`，命名符合 `run-smokes.mjs` 的发现正则，`discoverSuites()` 实测已收录，总套件数 537）。三条腿，机器可判、不靠人眼：

1. 六家 `out/renderer/index.html` 与 `out/preload/index.js` 存在且非空。
2. 六家的**生成产物**（`index.html`、`renderer/assets/**`、`out/preload/**`）逐一比对 mtime ≥ pinned HEAD 的提交时间戳（`git show -s --format=%ct 635dee2f`，即 0013 的时间线；阈值取自 lock 的 revision 而非硬编码日期，重新 pin 时自动跟随）。`out/renderer/pdfjs/**` 显式排除——那是 `viteStaticCopy` 从 `pdfjs-dist` 原样拷贝的静态资源，保留上游包的 mtime（实测 cmaps/LICENSE 为 2026-10-17），由 lockfile 而非补丁链决定，任何补丁都不改它。
3. Docs renderer 必须含 staging 同一组 `DOCS_ACK_MARKERS`（`aiToolResult`、`toolResultAck`），并断言语料非平凡（>100KB，防空过）。

`genoffice/` 缺失时显式打印 skip 行并 exit 0（与 `document-view-renderer-smoke` 的既有先例一致，不假装验过）。

**结果**：`genoffice-vendor-freshness-smoke: 29/29 通过`（六家 × 4 条 + lock/HEAD 2 条 + docs marker 3 条）。

### 七、变异证据

备份：旧 docs 产物（含旧 mtime）在 `.tmp/T25-old/`，新产物快照在 `.tmp/T25-mutation/new-docs-renderer/`；变异/还原用 `node .tmp/T25-mutation/mutate.cjs old|new|verify`（精确整树替换，非手改）。

| 变异 | 改法 | 结果 | 还原 |
|---|---|---|---|
| A：整树换回 2026-10-18 旧产物 | `mutate.cjs old`（旧 renderer 43 文件，mtime 保留） | `FAIL docs: no emitted output predates the pinned HEAD commit`（oldest `renderer/index.html` mtime 2026-10-18T01:50Z vs pinned 2026-10-22T07:29Z）+ `FAIL docs renderer carries patch 0013 marker "aiToolResult"` + `FAIL …"toolResultAck"`，**26/29，EXIT=1** | `mutate.cjs verify` → **43 文件逐字节一致**；复跑 29/29 |
| B：旧内容 + `utimes` 伪造新 mtime | 旧产物全部 touch 到当前时间 | mtime 腿转绿，但两条 marker 断言仍 `FAIL`，**27/29，EXIT=1**——证明内容标记独立于时间戳，`touch` 造不出假绿 | 同上；staging 重算的 docs renderer digest 与变异前记录值 `7f895e93…5705` 相等 |

另做一次真实 staging 负控（`node .tmp/T25-mutation/stage-real.cjs`，临时 appDir，不写仓库）：对**真实 vendor 树**跑生产 staging 函数 → `editorsBundled:true`、`editorAssetsSha256` 六家齐、`editorPreloadSha256` 五家（docs 按 T23 设计不 stage）；同一函数指向旧 docs renderer 备份 → `GenOffice docs renderer predates patch 0013 (missing aiToolResult, toolResultAck)` 拒绝。**T23 的 fail-closed 门禁在重建后由红转绿，负控仍红。**

### 八、测试结果

- `genoffice-vendor-freshness-smoke`（新建）：**29/29 PASS**
- `production-build-preload-smoke`：**18/18 PASS**（含 `documentViewPreload.js` 携带 vendor ACK 桥的断言）
- `genoffice-editors-release-smoke`：**29/29 PASS**
- `t76-vendor-release-integrity-smoke`：**24/24 PASS**
- `t98-docs-tool-result-ack-smoke`：**55/55 PASS**
- `document-view-renderer-smoke`：**172/172 PASS**（含"真实产物相对路径"断言）
- `document-view-vendor-page-smoke`（真 Electron，真实 vendor docs+slides 页）：**9/9 PASS**——重建后的页面在最小 preload 下首帧零异常
- `run-smokes.test.mjs`（发现规则自测）：0 fail；`discoverSuites()` = 537 套
- 双包 typecheck：`apps/desktop` EXIT=0、`packages/contracts` EXIT=0
- `verify-genoffice-upstream.cjs`（opt-in）：重建后复跑仍 PASS，嵌套仓 `git status` 干净（构建未碰源码）

### 九、提交与边界

- 只提交：`apps/desktop/scripts/genoffice-vendor-freshness-smoke/{main.cjs,run.sh}` 与 `tasks/T25-vendor-rebuild.md` 回写。`genoffice/` 产物被忽略，不入库（见 §五）。
- **未碰**：`genoffice/` 源码（`git status` 为空）、`patches/genoffice/`、`electron.vite.config.ts`、`stage-genoffice-resources.cjs`。未用 worktree/junction，未跑 `rm -rf`（变异还原走整树拷贝 + `cmp` 等价的逐字节校验）。
- 提交 SHA：见本回写提交本身（`fix(T25): rebuild six GenOffice vendor products at pinned HEAD and assert freshness`）。
- **不宣称 T7（六编辑器 U1）完成**——本卡只证明产物新鲜、0013 renderer 半边入产物、staging 门禁放行；安装包形态下的真实打开/编辑/保存/重开仍是 T7 与 T-E 的范围。

## 风险提示

构建六家 renderer 可能需要数分钟到数十分钟。如果发现某家构建失败：
- **先报告失败原因**，不要跳过它继续
- 如果是依赖缺失，先解决依赖
- 如果是补丁应用不上，停下报告——那意味着补丁链与 pinned HEAD 不一致
