# T26｜「允许一次」的文案与它的实际语义不符

- Status: done（2026-10-23 执行回写，见文末）
- Category: bug（**文案准确性**，不是安全漏洞）
- Priority: P1
- Depends on: T18（已交付 `e6515e45`）
- Exclusive writable files: `apps/desktop/src/renderer/lib/i18n/{zh,en}/ide.ts`、`apps/desktop/src/renderer/components/modules/ModuleSurface.tsx`（仅文案处）、相关文案回归测试。

## Required Skills
- `security-best-practices`: 判定「文案与实现哪个该改」，不要两边一起改。
- `code-review`: 确认改动不触碰任何权限判断逻辑。

Read before work: `CLAUDE.md`、`tasks/T18-extension-install-permission-card.md`、`apps/desktop/src/renderer/lib/i18n/zh/ide.ts:531-546`、`apps/desktop/src/renderer/lib/i18n/en/ide.ts` 对应条目、`apps/desktop/src/main/modules/ModuleHost.ts` 的 `effectiveGrants`。

## 事实（我已核实，不要重新发现）

**实现**：`allow-once` 存成 `duration: "session"` + `bootId`；`effectiveGrants` 在 `bootId` 变化时返回 `null`，触发重新询问。

**文案**（`zh/ide.ts:542-546`）：
```
"ide.modules.consentCard.allowOnce": "允许一次",
"ide.modules.consentCard.reconsentRequired": "这个扩展的「允许一次」授权已在重启后失效；重新确认授权后才能使用。",
"ide.modules.consentCard.footnote": "「允许一次」只在本次运行有效，重启后会再次询问；「始终允许」在扩展升级或权限变化时仍会重新询问。拒绝不会安装任何内容。",
```

**脚注说对了**（「只在本次运行有效」），**但按钮文字说错了**（「允许一次」）。

用户读按钮，不读脚注。**「允许一次」在中文里最自然的理解是「这一次操作」**，而不是「这一次开机到现在」。

## 目标

让按钮文字与实现承诺一致。

### 必须做的判断

**先确认实现是对的。** 如果实现正确（session 级），改文案；如果产品其实要的是「单次操作」，改实现。**不要两边一起改。**

判断依据：
- 用户在 T18 卡里的原话是「比如同意一次，比如始终同意，就像是手机的软件一样」
- 手机上的「允许一次」通常指**这一次操作**（如「仅本次允许」用于位置、相机）
- 但扩展安装场景里，「每一次 invoke 都弹卡片」会很烦

**我倾向改文案**，因为：
1. 每次 invoke 都弹卡片对扩展场景太重
2. 脚注已经写清楚了真实语义
3. 改实现会破坏 T18 已验收的行为

**但如果你的调查发现用户在别处明确要求过「单次操作」，改实现。**

### 文案改法（若选改文案）

按钮文字要表达「本次运行」。候选：

- **「本次运行允许」** —— 直接
- **「仅本次运行」** —— 简洁
- **「允许（本次运行）」** —— 带括号

英文对应：`Allow for this session` / `Allow this session only`

**中文与英文必须同时改**（`lib/i18n/{zh,en}/ide.ts`）。

### 还要检查

1. **`reconsentRequired` 文案**：「已在重启后失效」是否准确？如果进程崩溃重启也算，要说明。
2. **所有出现「允许一次」的地方**（`grep -rn "允许一次" apps/desktop/src`）都要一致。
3. **是否有别的地方用这个 token 做逻辑判断**（不该有，但要验）。

## 验收判据

1. 回写区写明：你判断该改文案还是改实现，依据是什么。
2. 若改文案：zh + en 同步改，`grep "允许一次"` 在产品代码里零命中（或仅在注释/历史说明里）。
3. 若改实现：那要重新过 T18 的全部验收判据。
4. 脚注与按钮文字**语义一致**。
5. 有回归断言：按钮文字包含「运行」或等价的时效限定词（**断言立在用户看到的那行字上**）。
6. 变异验证：把按钮文字改回「允许一次」→ 断言变红；逐字节还原（`cmp`）。
7. 双包 typecheck 通过。
8. **不得**改动任何权限判断逻辑（`effectiveGrants` / `authorizeAppMethod` / `invoke`）。

## 边界

- **只改文案与文案回归**。不碰 `ModuleHost.ts` 的逻辑部分。
- **不改** 36 个权限名。
- 若发现实现确实有 bug，**停下另开卡**，不要在本卡混做。

## 结果回写（2026-10-23）

### 1. 判断：**改文案，不改实现**

判定依据（按卡面「先确认实现是对的」）：

- `ModuleHost.effectiveGrants`（`apps/desktop/src/main/modules/ModuleHost.ts:402-407`）：
  `duration === "session" && record.bootId !== this.bootId` → `null`。`bootId` 是
  `ModuleHost.BOOT_ID = randomUUID()`（`:377`，每进程启动一个新随机值，**并非常量**），
  因此**任何**新进程（正常退出重开、崩溃重开、多开）都拿不到旧会话授权。
- `install` 的 `consentRecord`（`:553-559`）：`allow-once` 写 `{duration:"session", bootId:this.bootId}`；
  `allow-always` 写 `{duration:"persistent"}`。
- `catalog()`（`:826-842`）把会话级标成 `duration:"session"`，并把重启后失效的记录放进
  `moduleStaleConsents`（**只供 UI 重弹卡，不参与授权**）——与 T18 回写 §3 表格一致。
- `module-install-consent-smoke` ② 实测：`boot-B-0002` 安装后，用 `boot-C-0003` 构造第二个宿主，
  menu 授权为 `null`、`invoke` 被拒、不带新决策的 `install` 被拒；本次复跑 **36 pass / 0 fail**，
  4 条内置变异全部 RED。

→ 实现兑现了「本次运行」语义，且与 T18 验收判据 3（「重启后同一扩展再次激活仍会询问」）逐条对上。
**没有发现需要另开卡的实现 bug。** 因此按卡面倾向改文案：每次 invoke 都弹卡对扩展场景过重，
脚注已经写明真实边界，改实现会推翻 T18 已验收的行为。

**同时核实「别处是否明确要求单次操作」**：`grep -rn "允许一次" apps/desktop/src packages/contracts/src`
的命中全部是 T18 自述的注释 / 文案 / 错误串，**没有任何需求文档或注释把「一次」定义成「一次 invoke」**。
唯一的另一处英文 `Allow once` 在 `main/workflowEngines/nodePackProductionPorts.ts:168`，那是 Node-RED
部署的原生对话框，语义确实是**一次部署操作**，与本卡无关，未改。

### 2. 改了哪些文案（zh + en 同步）

`apps/desktop/src/renderer/lib/i18n/zh/ide.ts`：

| key | 旧 | 新 |
|---|---|---|
| `consentCard.allowOnce` | 允许一次 | **本次运行允许** |
| `consentCard.reconsentRequired` | 「允许一次」…已在重启后失效 | 「本次运行允许」…已在**上次运行结束**后失效 |
| `consentCard.footnote` | 「允许一次」只在本次运行有效，重启后会再次询问 | 「本次运行允许」只在**这个 Mcode 进程的运行期间**有效：关闭或重启（**包括崩溃后重开**）都会失效 |

`apps/desktop/src/renderer/lib/i18n/en/ide.ts`：`Allow once` → `Allow this session`；`reconsentRequired` /
`footnote` 同义改写（"while this Mcode process is running … including reopening after a crash"）。

卡面「还要检查」第 1 条（`reconsentRequired` 是否准确）：原文「已在重启后失效」把原因窄化成重启；
实现是**进程结束即失效**（崩溃重开也换 `bootId`）。已改为「已在上次运行结束后失效」，脚注补上崩溃情形。

另同步了两处**注释**（不改行为）：`App.tsx:312`、`ModuleInstallConsentCard.tsx` 文件头与三态说明里的
「允许一次」→「本次运行允许」，避免同一概念两套说法。

**未改**（卡面边界外，移交 T19）：`ModuleHost.ts:543` 的抛错文本「上一次「允许一次」的授权已在重启后失效，
请重新确认授权」仍是旧词。它是用户可见字符串，但 `ModuleHost.ts` 的授权分支是 **T19（ready-for-agent）** 声明的
独占写入文件（`tasks/T19-extension-api-surface.md:7`），且本卡硬约束「不碰权限判断逻辑一行都不许动」。
T19 落地时顺带把该字符串改成「本次运行允许」即可。

### 3. grep 结果

- `grep -rn "允许一次" apps/desktop/src/renderer`：**产品字符串零命中**。剩余命中全在注释里
  （`ModuleSurface.tsx:71-72,94`、`ModuleInstallConsentCard.tsx` 历史说明、`App.tsx` 已改）。
- `grep -rn "允许一次" apps/desktop/src`：另有 `main/modules/ModuleHost.ts`（9 处，注释 + 上述 `:543` 抛错）
  与 `main/orchestration/entryRunner.ts:217`（`脚本 bind stdin 最多允许一次`——**无关语义**，指脚本语法）。
- 手机端无独立副本：`apps/desktop/src/mobile` 不存在，`AppMobile.tsx` 无 `consentCard` 引用，
  共用 `lib/i18n` 词典，因此无需补 `webApi.ts`。
- **token 是否被逻辑判断使用**：`ide.modules.consentCard.*` 只出现在 `t(...)` 渲染调用
  （`ModuleInstallConsentCard.tsx:210-283`、`ModuleSurface.tsx:89`）。逻辑分支用的是
  `installConsent` 的**值** `"allow-once" | "allow-always" | "deny"`（`@contracts/ipc`），
  与文案 key / 文案内容**无耦合**。改文案不改变任何决策路径。

### 4. 断言（立在用户看到的那行字上）

新建 `apps/desktop/scripts/module-consent-copy-smoke/`（`main.ts` + `run.sh`，**13 checks 全绿**）：

- ★ `zh 按钮文字含「本次运行」`、★ `zh 按钮文字不含「一次」` —— 直接对真词典 `translate("zh", "ide.modules.consentCard.allowOnce")` 断言；
- ★ 脚注含「本次运行」且含「崩溃」；★ 重询问提示用「本次运行允许」、指出「上次运行结束」；
- ★ en 按钮含 `this session` 且不含 `once`；en 脚注 / 重询问同义；
- ★ 渲染端源码 `src/renderer/**/*.{ts,tsx,js,jsx}` 里「允许一次」只出现在注释中
  （逐字符状态机识别 `//`、`/* */`、`{/* */}`、字符串）。

并在 `apps/desktop/scripts/module-ui-smoke/verify.ts` 加一条**真浏览器**断言：
读取 `[data-testid=module-install-allow-once]` 的 `textContent`，要求含「本次运行」、不含「一次」，
并检查整张卡文本含「本次运行」。`module-ui-smoke` **13/13 通过**（原 12 + 新 1）。

### 5. 变异验证（撤掉修复 → 断言变红 → 逐字节还原）

用 `.tmp/t26-mutate.py`（精确 `str.replace` + 命中次数校验）把 zh 按钮改回「允许一次」、en 改回 `Allow once`：

- `module-consent-copy-smoke` → **8/13**，5 条红：
  `FAIL ★ zh 按钮文字含「本次运行」 — "允许一次"`、`FAIL ★ zh 按钮文字不含「一次」`、
  `FAIL ★ en 按钮文字含 this session — "Allow once"`、`FAIL ★ en 按钮文字不含 once`、
  `FAIL ★ 渲染端源码里「允许一次」只出现在注释中 — ["src\\renderer\\lib\\i18n\\zh\\ide.ts:545"]`。
- `module-ui-smoke` → **exit 1**，`AssertionError: allow-once button must name its lifetime, got: 允许一次`。
- 还原：`cp` 备份覆盖 → `cmp -s` **zh BYTE-EXACT / en BYTE-EXACT**，SHA-256 与变异前一致
  （zh `90213c9c…`、en `a8097feb…`）；复跑 copy smoke **13/13**、module-ui-smoke **13/13**。

### 6. 回归与门禁

- `module-consent-copy-smoke` 13/13；`module-ui-smoke` 13/13；`module-catalog-ui-smoke` 26/26；
  `module-install-consent-smoke` 36 pass / 0 fail（内置 4 条 T18 变异均 RED）。
- 双包 typecheck：`tsc --noEmit -p apps/desktop/tsconfig.json` 与
  `-p packages/contracts/tsconfig.json` 均 **exit 0**（新增 smoke 的 `main.ts` 在 include 内，已过类型检查）。
- **未改**任何权限判断逻辑：`effectiveGrants` / `authorizeAppMethod` / `invoke` / `callAppFromExtension`
  零改动（`git diff` 不含 `ModuleHost.ts`）；36 个权限名零改动；T18 卡片结构与 `data-testid` 零改动。

### 7. 验收判据核对

| # | 判据 | 结果 |
|---|---|---|
| 1 | 回写写明判断与依据 | ✅ §1 |
| 2 | zh + en 同步改；产品代码「允许一次」零命中 | ✅ 渲染端零命中；主进程仅注释 + `ModuleHost.ts:543`（T19 边界，已移交） |
| 3 | 若改实现需重过 T18 | 不适用（未改实现） |
| 4 | 脚注与按钮语义一致 | ✅ 两处都用「本次运行允许」 |
| 5 | 回归断言在用户看到的字上 | ✅ copy smoke ★ 行 + module-ui-smoke 真浏览器读 `textContent` |
| 6 | 变异变红 + 逐字节还原 | ✅ §5，`cmp` BYTE-EXACT |
| 7 | 双包 typecheck | ✅ exit 0 |
| 8 | 不改权限判断逻辑 | ✅ `git diff --stat` 无 `ModuleHost.ts` |

### 8. 提交 SHA

代码 + 新建回归套件：`2a20c210`（`fix(T26): the allow-once button now says "this session"`）。
本节与状态更新随 `docs(tasks): record T26 result writeback and commit SHA` 单独提交。

### 9. 遗留 / 移交

- **T19**：`ModuleHost.ts:543` 的抛错文本仍是「允许一次」。T19 写 `ModuleHost.ts` 授权分支时顺带改为
  「本次运行允许」。不属本卡写入边界。
- 未做真实 Electron U1：文案属渲染端 CDP 夹具可覆盖，`module-ui-smoke` 已在真 Chromium 读到实际按钮文字。
  若需要 Electron 内的截图证据，归 T7/T8 的 U1 旅程。

