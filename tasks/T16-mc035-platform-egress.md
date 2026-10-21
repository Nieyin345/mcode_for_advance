# T16｜MC-035 补齐：平台级 egress 与五路实证

| 项目 | 值 |
|---|---|
| 编号 | T16 |
| 类型 | MC-035 续（补 T06 未达成的三条判据） |
| 优先级 | 高（安全债，且当前 Windows 上「声明 network 的扩展」完全不可用） |
| 建议并发 | 不要与任何改 `modules/` 的任务并行 |
| 预计规模 | 大 |

---

## 要补的三条

T06 的 2026-10-21 复验自己写清了未达成项（我核对源码后确认属实）：

| 判据 | 现状 | 证据 |
|---|---|---|
| **#2 平台隔离** | Windows 没有真实 AppContainer/WFP 子进程限制器 | `egressMode("win32", false)` 返回 `js-guard-only` |
| **#3 严格 fail-closed** | Windows 上未声明 network 的扩展**不拒绝**，走 JS 守卫 | `unapprovedNetworkLaunch()` 在 js-guard-only 下返回原生 Node |
| **#6 动态变异** | 没有 Linux/macOS 上「撤 OS 包裹 → 五路探针红 → 还原绿」 | 只有 Windows 两组变异 |

---

## 开工前必读

1. `apps/desktop/src/main/modules/permissionedProcessRunner.ts` **全文** ——
   重点看 `egressMode`、`unapprovedNetworkLaunch`、`egressLaunch`、
   `requireNetworkExtensionSupport`、`EGRESS_PROBE`。
2. `apps/desktop/scripts/mc035-egress-probe/probe-a.mjs` —— 五路探针。
3. `apps/desktop/scripts/mc035-egress-isolation-smoke/main.ts` —— 14 条断言，
   **你要保住它们**。
4. `apps/desktop/src/main/modules/ModuleHost.ts:297,365` —— 两处
   `requireNetworkExtensionSupport()` 调用点。
5. T06 与 T11 的回写区（`tasks/T06-...md`），特别是 2026-10-21 那段。

---

## 执行内容

### 1. Linux/macOS：补五路动态变异（判据 6）

这是**最容易做的一条**，先做：

- 在 Linux 上跑：`egressLaunch()` 正常工作 → 五路探针应全 blocked。
- 变体：临时把 `unshare` 前缀去掉（模拟撤掉 OS 包裹）→ **五路探针必须有至少
  一路变成 connected/error**（证明 OS 包裹真的在起作用，不是 JS 守卫在单独扛）。
- 逐字节还原，`cmp` 确认。

如果本机没有 Linux，**在 WSL 里做**（T06 已经验证过 WSL 的 `unshare --net` 有效：
普通 namespace `ECONNREFUSED`、新 netns `ENETUNREACH`）。WSL 里装一个 Linux Node
即可跑通。

macOS 若无法触达，**明确写「未验证」**，不要用 Linux 的结果冒充。

### 2. Windows：真实 OS 限制器（判据 2）

按可行性排序，**至少做成一种**：

**A. AppContainer**（推荐）
- 用 Windows 的 AppContainer API 为子进程创建受限令牌，**移除网络能力**
  （`internetClient` / `privateNetworkClientServer` 都不授予）。
- 需要原生调用：`CreateAppContainerProfile` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`。
- 实现方式二选一：
  - Node 原生 addon（要预编译，**不许运行时编译**）
  - 一个小 .NET/PowerShell 启动器（慢但简单，可接受）
- **验证**：在 AppContainer 里跑 `EGRESS_PROBE`，必须得到
  `ENETUNREACH`/`EPERM` 之一。

**B. WFP 过滤**（备选）
- 为子进程创建 WFP 过滤器，阻断所有出站。
- 更复杂，但不需要 AppContainer 的沙箱约束（文件访问等）。

**C. 如果两者都做不到**
- 保持现有 `js-guard-only`，但**把 #3 的严格性补上**：在 js-guard-only 平台，
  对**所有**可执行扩展（不论是否声明 network）都要求用户显式确认「本平台无 OS
  级网络隔离，扩展仅受 JS 守卫约束」，确认后写入持久化标记。
- 这是**降级**，必须在设置页与安装流程里可见，不能静默。
- 并在回写区写清为什么做不到（缺什么能力/权限/时间）。

### 3. 判据 3：严格 fail-closed

当前 `unapprovedNetworkLaunch()` 在 js-guard-only 平台直接返回原生 Node。
要改成：

- **默认拒绝**：js-guard-only 平台 + 未声明 network 的扩展 → 拒绝执行，
  错误说明「本平台无 OS 网络沙箱」。
- **只有**用户在设置里显式开启「允许在无 OS 隔离的平台上运行扩展」（默认关）
  之后，才走 `NETWORK_GUARD` 路径。
- 这个开关要有 i18n 文案、要在安装流程里提示、要能随时关掉。
- 如果第 2 步做成了 AppContainer/WFP，本条自动不适用（有 OS 隔离了）。

### 4. 保住现有回归

`mc035-egress-isolation-smoke` 的 14 条断言、`module-protocol-integrity-smoke`、
`module-extension-lifecycle-smoke` 必须**仍然全绿**。
T11 刚把后两套从红修绿，不能因为本卡又打红。

---

## 边界（不要碰）

- 不要改 `ModuleHost` 的安装/授权协议（只允许改 `requireNetworkExtensionSupport`
  的调用时机与文案）。
- 不要碰 renderer（除设置页那个新开关的必要 UI）。
- 不要碰 document / workflowEngines / mobile。
- 不要引入需要联网下载的原生依赖。
- **不要**把 `NETWORK_GUARD` 删掉（它是纵深防御，不是替代品）。

---

## 验收判据

1. **判据 6**：Linux（或 WSL）上有「撤 OS 包裹 → 五路探针红 → 还原绿」的
   逐字节变异记录。
2. **判据 2**：Windows 上要么有真实 OS 限制器（AppContainer/WFP）并通过探针验证，
   要么有显式的、可见的降级开关 + 文档说明。**二选一，不许含糊**。
3. **判据 3**：js-guard-only 平台默认拒绝未声明 network 的扩展（有断言），
   开关打开后才放行。
4. `mc035-egress-isolation-smoke` 14/14 仍全绿；`module-protocol-integrity-smoke`
   与 `module-extension-lifecycle-smoke` 仍全绿。
5. 双包 tsc 干净。
6. **变异验证**：撤掉新加的默认拒绝 → 断言必红；撤掉 OS 包裹 →
   五路探针必红（判据 6 的核心）。

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
