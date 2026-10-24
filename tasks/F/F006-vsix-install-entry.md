# F006｜产品层的第 1 环：给用户一个装 `.vsix` 的入口

- Status: ready-for-agent
- Category: **P0 扩展主线（闭环断点）**
- Depends on: F001–F003（`VscodeL1Bridge` 已能读 DEFLATE、清单限额已放宽）
- Exclusive writable files:
  - `apps/desktop/src/main/ipc/modules.ts`（**只加一个新 handler**）
  - `packages/contracts/src/ipc/modules.ts` + `rpcMap.ts`（**只加一条方法**）
  - `apps/desktop/src/preload/*`（若白名单需同步）
  - `apps/desktop/src/renderer/components/modules/`（**只加 vsix 安装入口**）
  - `apps/desktop/scripts/vsix-install-ipc-smoke/`（新建）
  - `tasks/F/F006-vsix-install-entry.md` 回写

## Required Skills
- `mcode-smoke`
- 契约三层：`packages/contracts` → preload 白名单 → 主进程 handler

---

## ⚠️ 并行卡：不要碰这三个文件

- `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（**F004 正在改**）
- `apps/desktop/scripts/vsix-end-to-end-smoke/**`（**F005 正在建**）
- `tasks/F/F004-*.md` / `tasks/F/F005-*.md`

---

## 断点在哪

**闭环五环里，第 1 环在产品层完全缺失。**

```bash
$ grep -rn "vsix\|VSIX" apps/desktop/src/renderer/components/modules/*.tsx
（零命中）
```

`VscodeL1Bridge.install` **全仓唯一调用方是 `vscode-l1-smoke`**（一个套件）。
`RpcMap` 里 **没有任何 vsix 相关方法**。用户打开应用，**没有任何地方能选一个 `.vsix` 文件装进来**。

**这就是「能装」和「用户能装」之间的差。**

---

## 你的任务

### 一、加一条 IPC（走全三层）

**这是契约先行的标准动作**，缺一层调用端就看不到：

1. `packages/contracts/src/ipc/modules.ts` 加输入 schema
2. `packages/contracts/src/ipc/rpcMap.ts` 加方法（照 `modules.install` 的写法）
3. `apps/desktop/src/main/ipc/modules.ts` 加 handler
4. preload 白名单（如果方法名前缀需要登记）

**方法名建议 `modules.installVsix`**（不要叫 `extension.install`——模块系统已经叫 `modules.*`，另起前缀会让人以为是第二套）。

### 二、handler 必须复用 `VscodeL1Bridge.install`

**不许自己写一份读 VSIX 的逻辑。** 硬规矩 2：共享实现只有一份。

```ts
// 形状示意，不是照抄
ipcMain.handle(IPC.MODULE_INSTALL_VSIX, async (event, raw) => {
  const input = ModuleInstallVsixSchema.parse(raw);   // { path, installConsent }
  const bytes = readFileSync(input.path);             // 路径要走既有围栏检查
  // ⚠️ 审批：installConsent 三态，deny 必须在写盘之前
  return VscodeL1Bridge.install(await getModuleHost(), bytes, consent);
});
```

**它必须和 `modules.install` 一样受审批约束** —— 装可执行代码是高危动作，
`appControl/policy.ts:257` 已经给 `modules.install` 定了「可执行代码」档，新方法要同等对待。

### 三、UI 入口

在已有的扩展面板（`apps/desktop/src/renderer/components/modules/`）里加一个**「从 .vsix 安装」**的入口。

**必须做对的三件事**：

1. **文件选择**走既有的 dialog 通道 —— **已经在 `apps/desktop/src/main/ipc/dialog.ts:67`**（`dialog.showOpenDialog` 的薄包装），照它加一个 `filters: [{ name: "VSIX", extensions: ["vsix"] }]` 的入口，**不要自己 `import { dialog } from "electron"`**（那会绕过既有的围栏与测试桩）；
2. **失败要说清为什么** —— 尤其是「源码超 24 KiB」这条现实（真实扩展 136 KB，绝大多数会被它拦住）；
3. **i18n**：用户可见字符串走 `lib/i18n/{zh,en}/`，**zh 是 `MessageId` 的源**，加了 en 忘了 zh 不会在 typecheck 里失败（只在 `maint-m37-smoke` 里），所以**两个都要加**。

### 四、⚠️ 诚实：现在装真实扩展大概率会失败

**这是最重要的产品判断。** 现状：

| 层 | 真实扩展 | 现状 | 结果 |
|---|---|---|---|
| 包结构 | DEFLATE | ✅ F002 已通 | 能读 |
| `package.json` | 17 KB | ✅ F003 放宽到 64 KiB | 能过 |
| `extension.js` | **136 KB** | ❌ 24 KiB | **被拒** |
| 命令 | 24 条 | ⚠️ 只跑第 1 条 | 部分 |

**所以 UI 不能做成「选一个 vsix 就能装」的样子。** 必须在入口处**先告诉用户**：
- 目前只支持源码 ≤ 24 KiB 的扩展；
- 真实市场扩展绝大多数超这个限制，装不进来。

**否则用户选了文件、等了一下、看到一句技术错误——那比没有入口更糟。**

**这条是我（总控）的判断，你有异议就在回写区说，别默默照做。**

---

## 验收判据

1. **IPC 三层齐全**（contracts schema + rpcMap + handler），**preload 可见**；
2. **handler 复用 `VscodeL1Bridge.install`**（`grep` 证明它被调用，不是抄了一份）；
3. **审批在位**：`deny` 时零写盘（有断言）；
4. **UI 入口存在**，且**在用户选文件之前**就说明了 24 KiB 限制；
5. **i18n zh/en 都有 key**（`maint-m37-smoke` 不红，或你手动核过两本词典）；
6. **套件证明**：调这条 IPC 能装进一个 < 24 KiB 的 vsix，超限的会被拒且错误可读；
7. 不跑全量、不起 Electron、不用真 dataRoot。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| handler 里自己写一份读 VSIX 逻辑（不走 bridge） | 1 条红（复用性那条） |
| `deny` 时仍然写盘 | 1 条红（审批负控） |
| UI 删掉 24 KiB 限制的说明 | 1 条红（诚实性那条） |
| rpcMap 加了方法但 preload 白名单没加 | 1 条红（三层齐全） |

---

## 回写

1. IPC 三层的**具体文件与行**；
2. handler **怎么复用 bridge** 的（贴那几行）；
3. **UI 里那段限制说明的原文**（中英各一）；
4. `maint-m37-smoke` 跑了吗，结果如何；
5. 变异四条结果；
6. **你对「现在装真实扩展大概率失败」这个产品判断有没有异议**；
7. 提交 SHA。

---

## 回写

### 1. IPC 三层（四层，实际是四处）

| 层 | 文件 | 内容 |
|---|---|---|
| 契约 schema | `packages/contracts/src/ipc/modules.ts` | `ModuleInstallVsixSchema`（`.strict()`，**没有 `manifest` 字段**）+ `ModuleInstallVsixResult` |
| 方法表 | `packages/contracts/src/ipc/rpcMap.ts` | `"modules.installVsix"` + `MODULE_INSTALL_VSIX: "modules:installVsix"` |
| 主进程 handler | `apps/desktop/src/main/ipc/modules.ts` | `ipcMain.handle(IPC.MODULE_INSTALL_VSIX, ...)` |
| preload 白名单 | `apps/desktop/src/preload/index.ts` | `installVsix: ((input) => ipcRenderer.invoke(IPC.MODULE_INSTALL_VSIX, input))` |

**额外一处（CLAUDE.md 里写过的坑）**：`apps/desktop/src/renderer/lib/webApi.ts` 必须补 `installVsix`。
手机端是独立组件树，`satisfies Api["modules"]` 缺一项会**同步抛错、React 19 整棵卸载**。
这次是 typecheck 抓到的（`TS1360`），不是运行时——**因为它是 `satisfies` 不是 `as`**。

**审批档位**：`appControl/policy.ts` 加了 `"modules.installVsix": "从 .vsix 安装 VS Code 扩展(可执行代码)"`，**与 `modules.install` 同档**。分档会让 vsix 通道变成绕过审批的后门。

### 2. handler 怎么复用 bridge

```ts
const bytes=new Uint8Array(readFileSync(input.path));
const { VscodeL1Bridge }=await import("@main/modules/vscodeL1Bridge.js");
const bridge=await VscodeL1Bridge.install(await getModuleHost(), bytes, {
  confirmReadAccess:input.confirmReadAccess,
  confirmExecutableCode:input.confirmExecutableCode === true,
});
```

**没有第二份 VSIX 解析逻辑。** 套件有一条断言专门抓这个：变异 M1 把 `VscodeL1Bridge.install(` 换成假对象后，`★ 调用了 VscodeL1Bridge.install` 立刻红。

### 3. UI 里那段限制说明（原文）

**中文**：

> 当前只支持可执行入口不超过 24 KiB 的扩展。真实市场扩展普遍在 100 KB 以上（例如 Rainbow CSV 的 extension.js 是 136 KB），会被这条限额拒绝。这是现阶段的真实边界，不是配置问题。

**英文**：

> Only extensions whose executable entry is at most 24 KiB are supported right now. Real marketplace extensions are typically over 100 KB (Rainbow CSV's extension.js is 136 KB) and will be rejected by that limit. This is the honest boundary of the current host, not a configuration problem.

**位置**：`VsixInstallSection.tsx` 里，`data-testid="module-vsix-limit-notice"` 那段在「选择 .vsix 文件…」按钮**之前**。
套件有断言钉住这个顺序（变异 M3 删掉 testid 后 `{noticeIdx:-1, buttonIdx:1806}`，两条红）。

### 4. maint-m37-smoke

**跑了，5/5 通过**（`zh/en 同一键的 {占位符} 集合一致`、`没有只有一边为空的文案` 都绿）。
新增 6 个 key（`vsixTitle` / `vsixLimitNotice` / `vsixPick` / `vsixInstalling` / `vsixInstalled` / `vsixFilter`）中英各一份。

### 5. 变异四条（预期 vs 实际）

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 handler 不走 bridge | 1 条红 | **1 条红**（复用性那条）✓ |
| M2 deny 挪到读文件之后 | 1 条红 | **1 条红**（`{denyIdx:226, readIdx:191}` —— 顺序反了）✓ |
| M3 删掉 24 KiB 说明 | ≥2 条红 | **2 条红**（testid + 顺序）✓ |
| M4 preload 白名单没加 | 2 条红 | **2 条红**（暴露 + 转发）✓ |

**还原逐字节一致**，基线 30/30。

### 6. 我对「现在装真实扩展大概率失败」这个判断

**没有异议，而且我把这条写进了代码注释和 UI 文案，不只是卡片里。**

但我要补一条总控没提到的**更坏的形态**：`VscodeL1Bridge.install` **内部不透传 `decision`** ——
它调 `host.install(checked.manifest)` 用的是默认 `allow-once`。也就是说 **`deny` 在 bridge 那层是丢的**。

本卡的解法是把 `deny` 挡在**读文件之前**：

```ts
const decision = resolveInstallDecision(input, event);
if (decision === "deny") throw Error("用户拒绝了这次安装，未读取任何文件");
const bytes=new Uint8Array(readFileSync(input.path));   // ← 走到这里说明没被拒
```

**这是本卡真正的安全保证所在**，我在 handler 里写了注释说明「别以为 bridge 里挡过了」。
**但这是个临时解法**：等 F004 空出 `vscodeL1Bridge.ts`，应该给 `install` 加 `decision` 参数，两处都挡。

### 7. 一个我改宽了的判据

套件第 5 组里 `★ 25 KiB 的文案在 i18n 词典里` 这条：**第一版我写的是在组件文件里搜「24 KiB」，假红** ——
因为组件只引用 key，文案在 `lib/i18n/zh/ide.ts`。改成读词典再用正则取那段文案。

这和 F003 那次是同一类：**判据搜错了地方，红的原因不是它声称的那个。**
