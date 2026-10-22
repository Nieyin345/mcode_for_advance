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

### 2026-10-21｜T16 执行与实证（Windows + WSL Ubuntu Linux Node 22.21.1）

- **范围**：补 MC-035 判据 2/3/6；Windows 选择任务书允许的 **C：显式、持久、可撤销的安全降级**，**没有**实现 AppContainer/WFP，**不**宣称 Windows OS 网络沙箱生效。原因：现有仓库无可维护/可打包的 AppContainer 受限启动器，WFP 需管理员过滤及进程生命周期清理，Node `--permission` 与 Job Object 不能封锁出站；不引入联网下载的原生依赖，不操作系统全局防火墙。
- **Windows 真实安全默认**：`permissionedProcessRunner.ts` 的 `unapprovedNetworkLaunch()` 在 `win32/js-guard-only` 无批准时于安装试执行和每次调用之前均抛 `egress_isolation_unavailable`（调用返回 `isolated_denied`）；非 Windows 平台仍保留 `unshare` / `sandbox-exec` 及 OS egress 探针；`NETWORK_GUARD` 保留。用户在 **设置 → 扩展 → 自定义 UI → 高级 → 模块管理** 可看到明确风险、状态、独立风险确认勾选和启用/关闭按钮（zh/en i18n）；启用后未声明 network 的扩展可通过 JS 守卫执行，回包保留 `_mcodeEgressIsolation: "js-guard-only; OS egress isolation unavailable"`。已声明 network 的可执行扩展在 Windows 安装阶段仍拒绝。
- **批准事实来源**：仅 `modules:egressConsentGet/Set`（严格 schema、`acknowledgeRisk: true`）经桌面 preload → IPC；Agent `app_api_call` 对两条方法均 `blocked`，手机/网页端 `unsupported`。批准保存在数据根 `ui-modules/js-only-egress-consent.json` 独立文件（临时文件 + fsync + rename），**不属于通用设置表**，不能通过 `setting.set` 或设置导入伪造。缺失、损坏、符号/硬链接拒绝读取；每次启动新受控进程之前都重新读取，无缓存，关闭立即拒绝后续调用。真 Electron `module-phase2-e2e-smoke` 验证：preload → IPC → 隔离数据根持久化 → 撤销成功；缺 `acknowledgeRisk` 的请求被拒。
- **Linux 生产五路（E1）**：WSL Ubuntu `unshare --user --map-root-user --net` 生效，发现本机已有 Linux Node 22.21.1：`/home/nieyin/.vscode-server/bin/994fd12f8d3a5aa16f17d42c041e5809167e845a/node`，无联网安装。以 Windows 本地 esbuild 打包**当前生产** `mc035-egress-probe/main.ts` 至隔离 `.tmp/mc035-linux-probe.mjs`，在 WSL 下用该 Linux Node 执行，`net.connect`、`dns.lookup`、`worker_threads`、`process.binding(tcp_wrap)`、`fetch` **5 blocked / 0 connected / 0 error**；这里只访问本机回环，不外传。
- **撤 OS 包裹的独立五路变异（E1）**：`wsl.exe --exec /home/nieyin/.vscode-server/bin/994fd12f8d3a5aa16f17d42c041e5809167e845a/node /mnt/d/destop/work_space/work_for_reseach/mcode/apps/desktop/scripts/mc035-egress-probe/os-mutation.mjs` → **exit 0**；读取生产 Linux egress 前缀并核对精确字符串，在隔离目录制作源码原件/移除 unshare 前缀的变体/还原件（不触碰工作树）；五路独立 OS-only 探针 **无 JS NETWORK_GUARD**，否则无法区分 JS 守卫和 OS 隔离。加包裹：**5/5 blocked**（net/fetch `ENETUNREACH`、DNS UDP 没有到达回环服务端、worker/tcp_wrap `ERR_ACCESS_DENIED`）；去包裹：**3/5 真实联网**（TCP、回环 UDP DNS 请求、fetch），其余 2/5 仍受 Node 权限模型拒绝。源件/还原件 `cmp` 字节一致，生产文件前后 SHA256 均 `4e95fc17f314461c325ddc275344de33be39c8ab3857345d1502886a2c370d91`。一次 WSL 测试遇回环客户端主动断连引发的夹具 Socket `ECONNRESET`，已仅对回环测试服务端监听错误，再次运行得上述全绿，非生产缺陷。
- **撤 Windows 默认拒绝的动态变异（E1）**：`node apps/desktop/scripts/mc035-egress-isolation-smoke/mutation.mjs` 在 esbuild 内存源码把 `if (!hasJsOnlyEgressConsent())` 改为 `if (false)`，真实 Node 子进程测试 **3 条预期变红**（未经同意安装拒绝、未经同意调用拒绝、撤销后新安装拒绝），校验生产源码字节级哈希不变；还原后正常回归绿。
- **回归（E1）**：`node apps/desktop/scripts/run-smokes.mjs mc035-egress-isolation-smoke module-protocol-integrity-smoke module-extension-lifecycle-smoke module-catalog-smoke module-contract-smoke module-executor-smoke module-platform-smoke module-phase2-security-smoke module-phase2-e2e-smoke module-grant-revoke-safety-smoke module-workflow-smoke module-ui-smoke` → **12/12 suites PASS，0 FAIL**（`mc035-egress-isolation-smoke` 旧 14 条及新拒绝/保存/撤销/损坏/硬链断言全绿），日志：`apps/desktop/.tmp/smoke-runs/1792545075188-20828-x34WAp/`。双包 `node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json` 和 `... -p packages/contracts/tsconfig.json` → **exit 0、0 错误**。
- **判据结论**：本任务 **1～6 均按任务书的 Windows 降级备选方案达成**。剩余实质风险（不扩大本任务）：Windows **并无** OS 级出站防护、用户自愿启用 JS-only 后恶意程序仍可能绕过；macOS 实机动态测试**未验证**（Linux 不冒充 macOS）；打包版本里的真实用户手动点击完整 U1 尚需独立复核。MC-035 整包是否关闭仍由统一台账的独立复核者决定，此处不代替双勾验收。并行工作区里 document 等其他 AI 未提交文件均未覆盖/提交。
