# T11｜Windows 上把 fail-closed 收窄到「真正需要网络」的扩展

| 项目 | 值 |
|---|---|
| 编号 | T11 |
| 类型 | 回归修复（T06 引入） |
| 优先级 | **最高** —— 现在 Windows 用户装不了任何可执行扩展 |
| 建议并发 | 不要与任何改 `modules/` 的任务并行 |
| 预计规模 | 中 |

---

## 为什么必须马上做

T06（提交 `b2fe788d`）为了做 OS 级网络隔离，在 `permissionedProcessRunner.ts:371-373` 写了：

```ts
} else {
  throw Error("egress_isolation_unavailable: 当前系统没有可验证的独立进程 OS 网络沙箱("
    + process.platform + ")，拒绝执行未授权网络的扩展");
}
```

而 `ModuleHost.ts:307` 对**所有**扩展都传：

```ts
allowNetwork: declaresNetwork(manifest.permissions)
```

`runPermissionedProcess` 在 `allowNetwork !== true` 时必定调 `egressLaunch()`。
于是 Windows 上**任何没有声明 `network` 权限的扩展**——也就是绝大多数普通扩展——
都在安装核验（`verifyPermissionedProgram`）和调用（`runPermissionedProcess`）两处被拒。

**实测**（本会话亲自跑的）：

```
node apps/desktop/scripts/run-smokes.mjs module-protocol-integrity-smoke module-extension-lifecycle-smoke
→ Smoke summary: 0 pass, 2 fail (2 suites)
```

`module-extension-lifecycle-smoke` 直接抛：
`扩展程序核验失败,未安装: ... egress_isolation_unavailable ... (win32)`

**这条卡片的判据很明确：不能靠撤回 T06 的隔离来修。**
T06 的 OS 隔离在 Linux/macOS 上是真做了的（`unshare --net` / `sandbox-exec deny network*`），
撤掉它等于把 MC-035 的安全债重新背上。要做的是**把拒绝条件收窄**。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `apps/desktop/src/main/modules/permissionedProcessRunner.ts` **全文**——
   特别是 `egressLaunch()`、`verifyPermissionedProgram()`、`runPermissionedProcess()`、
   以及 `NETWORK_GUARD` 引导脚本。
3. `apps/desktop/src/main/modules/ModuleHost.ts:290-320` ——
   `allowNetwork` 怎么来的、`declaresNetwork` 在哪儿定义。
4. `apps/desktop/scripts/mc035-egress-probe/probe-a.mjs` —— T06 留的探针，
   它测的是「JS 守卫能不能被绕过」，结论是 5 条路径都挡住了。
5. `apps/desktop/scripts/mc035-egress-isolation-smoke/main.ts` —— 14 条断言，
   **你要保证它们仍然全绿**（那是 T06 的验收网）。
6. `apps/desktop/scripts/module-protocol-integrity-smoke/main.ts` 与
   `module-extension-lifecycle-smoke/main.ts` —— 现在红的两套，你要让它们转绿。

---

## 执行内容

### 1. 分清「需要 OS 沙箱」与「不需要 OS 沙箱」

关键事实（读代码确认，不要猜）：`NETWORK_GUARD` 引导脚本**在扩展代码求值之前**
把 `http/https/net/tls/dns/fetch` 全部换成了抛错函数。对**不声明 network** 的扩展，
这层 JS 守卫已经在起作用；OS 沙箱是**额外的**纵深防御，不是唯一防线。

所以正确的分层是：

| 扩展声明 | 现有行为 | 应当的行为 |
|---|---|---|
| **不声明 network** | Windows 上直接拒绝 ❌ | **正常执行**，靠 `NETWORK_GUARD` 拦截（这是 T06 之前的行为） |
| **声明 network** | Windows 上拒绝 | 保持拒绝（`egress_isolation_unavailable`），因为没有 OS 沙箱就无法保证 |
| 不声明 network + 用户显式批准网络 | 走 `allowNetwork=true`，不注入守卫 | 保持现状（用户显式授权） |

**换句话说：把 `egressLaunch()` 的调用从「所有非 allowNetwork 的执行」改成
「只在需要 OS 沙箱时才调」，而不是在 `egressLaunch()` 里按平台一刀切。**

### 2. 但必须守住 T06 的成果

改的时候**不能**顺手把 OS 隔离也改没了：

- 在 Linux/macOS 上，**不声明 network 的扩展仍然要进 OS 沙箱**（那边做得到，
  就该用上）。
- 在 Windows 上，不声明 network 的扩展走 JS 守卫（`NETWORK_GUARD`），
  并在**返回结果里显式标注**「本次执行未获 OS 级网络隔离，仅 JS 守卫」——
  让上层能诊断，而不是静默降级。
- `diagnoseEgressIsolation()` 仍然要如实报告 Windows 不支持。

### 3. 声明了 network 的扩展

保持 T06 的行为：Windows 上拒绝，错误文案要说清「这台机器没有可验证的 OS 网络沙箱」。

**但**要重新审视一个产品问题：如果 Windows 上永远无法运行需要网络的扩展，
那 `declaresNetwork` 为真的扩展在 Windows 上等于不可用。这是可接受的产品限制，
**但必须让用户在安装时就看到**，而不是安装成功、调用时才炸。核实安装路径
（`verifyPermissionedProgram`）是不是也拒了——如果是，错误文案要给出明确指引。

### 4. 测试

- 新增/补断言到 `mc035-egress-isolation-smoke`（不要新建套件）：
  - Windows 上，不声明 network 的扩展**能正常执行**（这是新行为）；
  - 执行结果里带「仅 JS 守卫 / 无 OS 隔离」的标注；
  - 声明 network 的扩展在 Windows 上**仍然被拒**；
  - Linux/macOS 分支的判据不变（如果本机测不了 Linux，用编译期/注入方式验证分支选择）。
- `module-protocol-integrity-smoke` 与 `module-extension-lifecycle-smoke` 必须**转绿**。

---

## 边界（不要碰）

- **不要**删掉 `egressLaunch()` 的 Linux/macOS 分支，也不要删 OS 探针。
- **不要**改 `NETWORK_GUARD` 的拦截清单（那是 T06 之前就有的防线）。
- 不要碰工作流、文档、移动端、renderer。
- 不要改 `arc005-visual-baseline/`（T01 的产物，已修过一个 TS 错误）。
- 不要 push。

---

## 验收判据

1. `module-protocol-integrity-smoke` **全绿**（当前 6/15）。
2. `module-extension-lifecycle-smoke` **全绿**（当前整套失败）。
3. `mc035-egress-isolation-smoke` **仍然 14/14 或更多**全绿 —— T06 的验收网不能破。
4. 有一段断言明确证明：Windows 上不声明 network 的扩展**走的是 JS 守卫**而不是裸奔
   （例如让它去 `net.connect` 并断言被 `NETWORK_GUARD` 拦下）。
5. 双包 `tsc --noEmit` 干净。
6. **变异验证**：把「不声明 network 也要求 OS 沙箱」改回去 → 判据 1、2 必须变红；
   把 `NETWORK_GUARD` 整个去掉 → 判据 4 必须变红。

---

## 你要在回写区回答的问题

- 改之后 Windows 上「不声明 network 的扩展」实际走的是哪条路径？贴调用链。
- 「仅 JS 守卫」这个降级状态，用户/日志里能看到吗？怎么看到？
- 声明 network 的扩展在 Windows 上，安装阶段就拒还是调用时拒？
- 有没有任何路径仍然 fail-open？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜T11 执行结果（Windows 实机 Node 22.21.1）

- **源码提交 SHA**：`5ac27b0508ba5751376d4a376d2d6546484a0cd2`（`fix(T11): narrow Windows egress sandbox rejection`；未 push）。
- **修改文件（仅本卡片范围）**：
  - `apps/desktop/src/main/modules/permissionedProcessRunner.ts`
  - `apps/desktop/src/main/modules/ModuleHost.ts`
  - `apps/desktop/scripts/mc035-egress-isolation-smoke/main.ts`
  - `apps/desktop/scripts/mc035-egress-probe/main.ts`
  - `apps/desktop/scripts/module-extension-lifecycle-smoke/main.ts`
- **旧红例 → 新绿例（E1）**：原先 `module-protocol-integrity-smoke` 6/15、`module-extension-lifecycle-smoke` 整套安装抛错；现执行：
  `node apps/desktop/scripts/run-smokes.mjs module-protocol-integrity-smoke module-extension-lifecycle-smoke mc035-egress-isolation-smoke`
  → `3 pass, 0 fail`（各套分别 **15/15、160/160、20/20 PASS**）。日志目录：`apps/desktop/.tmp/smoke-runs/1792532278775-31116-sFShUP/`（三个对应 `.log` 文件）。
- **类型与提交门禁（E1）**：在仓库根执行 `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`、`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`、`git diff --check`，全部 exit 0。Linux/macOS `egressMode` 分支由编译期/纯函数断言保持 `os-sandbox`；本轮**没有**在 Linux/macOS 真实内核上重跑 OS 探针。
- **变异验证一（E1）**：临时把 Windows 的 `egressMode(...,false)` 改回 `os-sandbox`（恢复全部无网络扩展必须 OS 沙箱的旧行为）→ `module-protocol-integrity-smoke` 回到 **6/15**、`module-extension-lifecycle-smoke` 安装失败；三套 **0 pass, 3 fail**。红例日志：`apps/desktop/.tmp/smoke-runs/1792532215488-29312-EMrf0j/`。恢复源代码后 SHA256 与变异前 **逐字节一致**。
- **变异验证二（E1）**：临时去掉安装核验与执行的 `NETWORK_GUARD` 注入，保留源码定义 → `mc035-egress-isolation-smoke` **13/20**，其中「Windows no-network execution enforces production NETWORK_GUARD」确切变红，五路探针亦失败。红例日志：`apps/desktop/.tmp/smoke-runs/1792532249061-8080-pRs1WI/`。恢复后 `permissionedProcessRunner.ts` 的 SHA256 **4a5e39e85ddad97247a2891873c1c9ecaf46c73759e4ddb1366be91d35bc49e6**，与变异前完全一致；再次重跑三套全绿。
- **Windows 真实调用链（E1+E2）**：`ModuleHost.prepareProgramBindings` 的 `allowNetwork: declaresNetwork(manifest.permissions)` → `runPermissionedProcess` → `egressMode(win32,false)="js-guard-only"` → `unapprovedNetworkLaunch()` 选 `process.execPath`（不伪称 OS 沙箱） → Node `--permission` + `NETWORK_GUARD + BOOTSTRAP` → 受控工厂求值/能力调用 → `ResultSchema` 校验 → 宿主附加 `_mcodeEgressIsolation: "js-guard-only; OS egress isolation unavailable"` → `ModuleHost.invoke` 的 `ModuleReply.value`。
- **降级诊断可见性**：返回字段 `ModuleReply.value._mcodeEgressIsolation` 经结果协议供上层/IPC/调试日志读取；不依赖扩展自行报告、也不能伪装 OS 沙箱。**没有改 renderer**；普通 UI 是否主动呈现这一非贡献视图字段仍待 UI 层确认，不声称已经显示 toast。
- **声明 network 的 Windows 扩展**：安装 `ModuleHost.install` 的 `requireNetworkExtensionSupport()` 在核验/持久化前拒绝，报 `egress_isolation_unavailable` 并指引换支持 OS 沙箱的平台或移除权限；已有持久清单在恢复后执行 `prepareProgramBindings` 里仍拒绝。生命周期 smoke 验证了安装拒绝、不落盘、不注册、恢复后调用拒绝。直接调用底层 `runPermissionedProcess(allowNetwork:true)` 仍是**已有显式授权语义**，不代表受 `ModuleHost` 身份和逐次审批以外的隐含授权。
- **fail-open/剩余风险**：Windows JS 守卫不是 OS 网络沙箱，不承诺抵挡所有底层系统调用或未知网络入口；保留这一明确限制，不能把 Windows 本轮判为 MC-035 的 OS 完全隔离/U1。Linux/macOS OS 分支未实机重跑；真实 Electron 安装/渲染/提示也未做 U1。调用方若绕过宿主直接传 `allowNetwork:true` 属于底层 API 信任前提，需要独立安全审查，不能宣称零 fail-open。
- **验收判据**：1 ✅ 15/15；2 ✅ 160/160；3 ✅ 20/20（≥14）；4 ✅ 真 `net.connect` 在 JS 守卫下被拒；5 ✅ 双包 tsc；6 ✅ 两类变异见红、逐字节还原及最终重跑全绿。没有修改任务索引状态、其它 AI 的在飞文件、Linux/macOS 沙箱实现或 `NETWORK_GUARD` 拦截清单。
