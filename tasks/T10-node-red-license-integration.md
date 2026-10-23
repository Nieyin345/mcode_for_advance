# T10｜Node-RED 已核验许可证材料接入与发行门禁

- Status: done（2026-10-23 执行回写，见文末）
- Category: bug
- Priority: P0 release blocker
- Depends on: prior T91/T88 evidence; verify exact current ledger before modifying files
- Exclusive writable files: only the dedicated Node-RED third-party notice/manifest integration paths and tests confirmed from source; do not touch GenOffice notices or shared release gate without explicit coordination.
## Required Skills
  - `research`: confirm the precise upstream package/version/license evidence.
  - `mcode-smoke`: run targeted release-readiness and notice validation checks.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, release ledger, archived T76/T88/T91.
- Acceptance: integrate only verified original license material (including pause@0.0.1 if still applicable); unknown license data continues to block release. Verify notice/manifest consistency and negative gate behavior.
- Execute: inspect current dirty state and exact source provenance first; do not overwrite unrelated release-readiness edits.
- Result writeback: verified source, touched paths, smoke results, unresolved blockers, commit SHA.

## 结果回写（2026-10-23）

**实现提交 SHA：`782b08fc`**（`fix(T10): integrate verified pause@0.0.1 MIT license material into the Node-RED notice`）。

开工时 HEAD `187fc2f0`；执行期间并行会话推进到 `14063450`（T26/T19），提交建立在当时工作树之上。所有他人未提交修改均保留、未暂存、未覆盖。

### 一、阻塞项枚举（改动前，用生产 inventory 逻辑在隔离副本上实算）

| 项 | 值 |
|---|---|
| 总包数 | **420**（`node_modules` 生产依赖 + `packages/node_modules` 运行时） |
| manifest entry（已 verified 映射） | **15** |
| manifest blocker | **1** |
| `releaseEligible` | **false** |
| 未 collected 的包 | 仅 `pause@0.0.1 [release-blocker]`（`license=null`、`licenseTextPresent=false`） |

其余统计全 0：`unknownLicenseMetadata=1`、`missingLicenseText=1`、`conflictingLicenseMetadata=0`、`unknownSpdxExpressions=0`、`unmatchedLicenseManifestEntries=0`、`unmatchedReleaseBlockers=0`、锁版本/锁来源不匹配 0。

**改动后：** blockers **0**、entry **16**、`unknownLicenseMetadata=0`、`missingLicenseText=0`、`reviewedExternalLicenseMappings=16`、**`releaseEligible=true`**（隔离副本上）。

### 二、整合了哪些（只有 pause@0.0.1）

**独立复核了 T91 的证据链（未直接采信）：**

1. `https://api.github.com/repos/stream-utils/pause/git/refs/tags/v0.0.1` → annotated tag object `2d97aade35125ba0868be19fe36f0cdb82823f80`。
2. tag object：tagger **TJ Holowaychuk**、**2012-07-19T18:00:26Z**、message `0.0.1`、指向 commit **`11d0dcaca51ee8cdf09915be0ba14c41871009b5`**（npm 发布时间 `18:00:32Z`，相差 6 秒）。
3. Contents API 精确 commit 取 `Readme.md`：1146 字节、SHA-256 **`d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505d`**——与本地 stage 内 `node_modules/pause/Readme.md` **逐字节相同**。`index.js` `3de77f38…`、`package.json` `a731c9eb…` 同样与 stage 内文件一致。
4. `## License` 节（到 EOF、trim）独立提取 SHA-256 **`0227b62b5ea9cf05a0e0f828c5e29138f4c36a233e38574d8ccc956e0e5147dd`**（1116 字节），与 T91 记录一致。
5. npm registry `pause/0.0.1` 元数据复核：`license`/`repository`/`homepage`/`gitHead` 均缺失；tarball SHA-1 `1d408b3f…`、SRI `sha512-KG8UEiEV…` 与 lock 一致。

> 环境备注：本机 `raw.githubusercontent.com` TLS 链被中间设备破坏（`SEC_E_UNTRUSTED_ROOT` / `SELF_SIGNED_CERT_IN_CHAIN`），改用 `api.github.com` Contents API 取同一字节；`curl` 的 schannel 与 `node fetch` 均受影响，但 `api.github.com`、`registry.npmjs.org` 正常。

**写入了什么：**

- `materials/pause/0.0.1/Readme.md`：完整上游 Readme（不是提取段），SHA-256 `d568e893…`，与上游、stage 内包文件三方逐字节一致。
- `manifest.json`：`pause@0.0.1` 从 `blockers` 移入 `entries`，`licenseExpression="MIT"`、`revision=11d0dcac…`、`repositoryUrl=https://github.com/stream-utils/pause`、`tarballUrl/Integrity/Sha1` 原样保留；`licenseSourceNote` 记录「元数据缺失 + tag→commit→逐字节匹配」的完整推理。
- `metadataOverride`（reviewed）：`fileName="Readme.md"`、`licenseTextFile=false`、`sha256=d568e893…`、`sourceRevision=11d0dcac…`，明示授权在非许可命名的文件里。
- `THIRD-PARTY-LICENSES.txt`：由 `renderNodeRedLicenseNotice` 从 manifest 重生成（幂等），pause 段带 MIT 全文，**不再有 `RELEASE BLOCKER` 段**。

**生产脚本改动（最小、不放宽 gate）：**

1. `stage-node-red-resources.cjs`：`metadataOverride` 支持 `licenseTextFile:false`——跳过「必须存在许可命名文件」这一条，但**仍强制**包内 `Readme.md` 存在且 SHA-256 等于引用值；schema 仍要求 `licenseSourceNote`。去掉该标记，readme-only 的包会被拒（有断言）。
2. `safeLicenseMaterialPath`：祖先目录缺失时抛 `Node-RED license material is missing: <pkg> <file> (<rel>)`，而不是裸 `ENOENT`（信息可定位，仍 fail-closed）。
3. 删除一段在非 override 分支上永远不可达的 backfill（变异验证发现它是死代码，已删，不留「假保护」）。

**未做：** 没有替任何包猜 SPDX；`cli-table@0.3.11` 的 reviewed override 与既有证据保持原样；没有改 GenOffice、没有改共享 release gate 语义、没有跑 `npm ci`/installer。

### 三、dependency-license-audit 交叉结果

工具：`license-checker@25.0.1`（`--version` 非零退出是该版本怪癖；装到仓库外临时目录，只读审计）。命令：

```bash
node_modules/.bin/license-checker --json --production --start . --out <tmp>/node-red-licenses.json
node_modules/.bin/license-checker --json --production --unknown --start . --out <tmp>/node-red-licenses-unknown.json
```

**分布（384 条记录）：** MIT 246、ISC 86、BSD-2-Clause 15、BlueOak-1.0.0 12、Apache-2.0 10、BSD-3-Clause 6、MIT* 2、Python-2.0 1、Artistic-2.0 1、`Apache 2.0` 1、CC-BY-3.0 1、CC0-1.0 1、0BSD 1、`(MIT OR CC0-1.0)` 1。

**按 ASF 三分类：A=382、B=0、X=0、unknown=2。**未知的两项是 `cli-table@0.3.11` 与 `pause@0.0.1`。

**与 manifest 的一致性：16 条 entry 中 14 条逐字相同；2 条「不一致」已解释，不需要改 manifest：**

| 包 | audit | manifest | 解释 |
|---|---|---|---|
| `cli-table@0.3.11` | `MIT*` | `MIT` | `MIT*` 是 license-checker 的**猜测标记**：包/lock 元数据无 license 字段。它的候选文件表含 `README`，`LICENSE` 优先——本包读 `LICENSE` 全文命中 MIT 正则。用 `--unknown` 时归为 `UNKNOWN`，与 manifest「reviewed metadata override」的判断完全一致。 |
| `pause@0.0.1` | `MIT*` | `MIT` | 同理，且更明确：候选表把 `Readme.md`（去扩展名后 `README`）当候选，读全文得 `MIT*`；`--unknown` 时归 `UNKNOWN`。manifest 的 `metadataOverride` 正是「元数据缺失、由有证据的全文补齐」这一条，两者无冲突。 |

**其余差异均为口径差，不是冲突：**

- audit **384** 条 vs inventory **420** 包：audit 只收 `node_modules`；inventory 还收 `packages/node_modules` 的 7 个 `@node-red/*`/`node-red` 运行时包 + audit 忽略的若干无 `package.json` 语义差异（`ONLY_INVENTORY=7`，`ONLY_AUDIT=0`）。
- audit 的 `Apache 2.0` 不是合法 SPDX，按 `license-normalization.md` 归一为 `Apache-2.0`（A 类）。
- `BlueOak-1.0.0`、`0BSD`、`Artistic-2.0`、`Python-2.0`、`CC-BY-3.0`、`CC0-1.0` 均属 ASF A 类，无 X/B。

**结论：无需要「改 manifest 去迎合工具」的冲突。** 两处 `MIT*` 恰恰印证了 manifest 对「元数据缺失」的显式审查处理。

### 四、负控证据（隔离副本 + 真实 afterPack 代码；真实 stage 全程未改）

| 负控 | 结果 |
|---|---|
| 未映射的 pause（无 license 元数据、无 override） | `unknown-license`，`releaseEligible=false`，afterPack 拒绝 |
| 注入一个未知许可包 `mystery-pkg@9.9.9`（重新 stamp，所有 digest 都对） | `license coverage incomplete; release blocked: … mystery-pkg@9.9.9 [unknown-license]` |
| 注入未知许可包但**不**重新 stamp | 先被 `production dependency tree digest mismatch` 拒绝（纵深防御） |
| 删除 `materials/pause` 整个目录 | `Node-RED license material is missing: pause@0.0.1`，拒绝 |
| 从 manifest 撤掉 pause 映射 | pause 回落 `unknown-license`，`releaseEligible=false`，拒绝 |
| pause 包内 `Readme.md` 被同尺寸篡改 | `reviewed license metadata override file mismatch: pause@0.0.1` |
| pause 包内完全没有 `Readme.md` | 同上，拒绝 |
| `licenseTextFile` 标记缺失（readme-only 包） | 拒绝，证明该标记是承重的 |

### 五、变异证据

**A. manifest 哈希变异（`licenseTextSha256` 改错）**

- 原值 `d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505d`
- 变异末位 `a→b`：`d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505a`
- 结果：`license material SHA-256 mismatch: pause@0.0.1`，拒绝。
- 逐字节还原：manifest 与源文件 `Buffer.compare === 0`；pause material SHA 回到 `d568e893…`；afterPack 重新接受。

**B. 材料本体同尺寸篡改**

- 原 SHA `d568e893…` → 篡改（整文件填 `0x58`）`bca4b728ab912091e0fa0b20d0bc3cacfefaa08ae32c8086eda5875ac9955536`
- 结果：`third-party license tree digest mismatch`，拒绝；还原后 SHA 回 `d568e893…`，接受。

**C. 生产源码变异（5 处新逻辑逐一撤掉，确认断言真的红）**

| 变异 | 变异后源码 SHA-256 | smoke 结果 |
|---|---|---|
| M1 override 分支不再回填 MIT | `0321e205…` | **RED**（`pause status != collected`） |
| M2 去掉包内 override 文件哈希校验 | `8ad3b17c…` | **RED**（`Missing expected exception`） |
| M3 `licenseTextFile=false` 不再跳过许可命名文件要求 | `55cc864e…` | **RED** |
| M4 schema 不再要求 `licenseSourceNote` | `3b047893…` | **RED** |
| M5 去掉缺失材料的定位错误 | `4666a75b…` | **RED**（得到裸 `ENOENT`） |

每处变异后都 `Buffer.compare` 逐字节还原（源码原 SHA `7a61e09aacff92bf5c5fd020184466320dc606b17a8cf18b624f5da1735295dd`），还原后 t10 15/15、t88 13/13、t76 24/24 全绿。

> M3/M5 最初**未被**抓到（GREEN），因此补了两条针对性断言（「没有 `licenseTextFile` 时 readme-only 包必须被拒」「缺失材料的错误必须带包名」）；M1 的最初版本命中的是我写的一段**死代码**，确认不可达后删除，改测真正的 override 分支。

### 六、测试与命令

```bash
node apps/desktop/scripts/run-smokes.mjs t10-node-red-pause-license-smoke t88-node-red-license-closure-smoke t76-vendor-release-integrity-smoke
# → 3 pass, 0 fail（提交前、提交后各一次）
#   t10-node-red-pause-license-smoke: 15/15 PASS
#   t88-node-red-license-closure-smoke: 13/13 PASS
#   t76-vendor-release-integrity-smoke: 24/24 PASS
npx tsc --noEmit -p apps/desktop/tsconfig.json        # exit 0
npx tsc --noEmit -p packages/contracts/tsconfig.json  # exit 0
node --check apps/desktop/build/stage-node-red-resources.cjs   # exit 0
```

**全量 smoke：537 套（有 `run.sh` 的），24 失败。** 24 套全部与 Node-RED 许可无关，且已证明为预先存在：

- 两个入口被**他人未完成套件**挡住：`genoffice-file-routing-smoke`（T30，无 `run.sh`）与 `t87-genoffice-provenance-license-smoke`（T9/T11，无 `run.sh`）。`run-smokes.mjs` 对缺失入口是显式抛错（设计如此，不许静默跳过）。这两个不在本卡边界内。
- 8 套（agent-guide、aoci-index、approval-bridge-parity、capability、claude-ipc、custom-ui-refresh、extension-authoring、genoffice-source）：**在去掉本卡全部改动的 HEAD 基线上同样 8/8 红**。
- 其余 16 套（MCP、memory、markdown、renderer、scene、settings、release-readiness 等）：失败点为 GenOffice manifest / esbuild 模块解析 / 宿主能力表，零 Node-RED 引用。`release-readiness-smoke` 的失败发生在 `verify-genoffice-editors-after-pack.cjs`（GenOffice，非本卡）；该目录已被标注为 dirty 且属 T11/T23/T87。

### 七、仍阻塞的项

- **Node-RED 第三方许可：本卡范围内 0 个 blocker，`releaseEligible=true`（隔离副本实算）。**
- **但这不等于可发行**：真实 staging 会执行 `npm ci`/`npm run build`，本卡按 T88 约定**未运行**；真实 afterPack/installer/U1 未验。`apps/desktop/.tmp/node-red-release` 与叠加 manifest 的隔离副本实际给出了 `releaseEligible=true`，但该 stage 的 release marker 仍是旧的，需由发行验收卡重新 staging。
- `genoffice-file-routing-smoke`、`t87-genoffice-provenance-license-smoke` 缺 `run.sh`，会挡住 `run-all-smokes.sh`；属 T30 / T9-T11。
- `release-readiness-smoke` 的 GenOffice 红（`check-reviewed.cjs` 当前 dirty）属 T11/T23/T87。
- 全量 smoke 的另外 22 套预先存在的红未在本卡处理。

