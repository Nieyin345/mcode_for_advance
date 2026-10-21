# T06｜MC-035：OS 级网络出站隔离

| 项目 | 值 |
|---|---|
| 编号 | T06 |
| 类型 | MC-035 安全（**独立复核失败项**，开发勾已被撤下） |
| 优先级 | 高（安全边界，不是体验问题） |
| 建议并发 | 可与 T01/T02/T03/T04 并行 |
| 预计规模 | 中大 |

---

## 为什么做这个任务

台账 `2026-10-20 | MC-035 | REVIEW_FAILED` 记录得很清楚：

> `node --permission` 本身不限制网络出站；现有防护依赖**进程内 JavaScript 拦截**，
> 尚不足以证明 OS 级隔离。这个安全边界不能用普通 smoke 绿灯抵消。
>
> 反例：`node --permission -e '<回环 TCP 探针>'` **exit 0 / ECONNREFUSED** ——
> 证明权限模型本身**没有**阻断网络。

也就是说：今天第三方扩展的网络限制是「我们把 `net`/`dns` 的函数换成了抛错版本」。
这在**同一进程内**有效，但：

- 恶意扩展可以绕过（`process.binding`、原生 addon、`worker_threads` 里重新 require、
  通过 `_write` 等内部对象）；
- 一旦有任何路径在守卫安装**失败**后继续运行，就是 fail-open。

MC-035 的开发勾已被独立复核撤下。本任务要做的是**真正把网络限制在 OS 层**，
或者把"做不到"这件事变成显式的、可诊断的产品限制。

---

## 开工前必读

1. `audit-ledgers/README.md` §2.3（复核失败 → 撤开发勾的规则）。
2. 台账 MC-035 条目全文（搜 `### MC-035`），特别是 2026-10-20 的 REVIEW_FAILED 记录
   与其中的回环 TCP 探针命令。
3. `apps/desktop/src/main/modules/permissionedProcessRunner.ts` 全文 ——
   现有的进程内守卫，理解它挡了什么、怎么装的、失败时怎么办。
4. `apps/desktop/src/main/modules/ModuleHost.ts`（或同目录）—— 子进程怎么起的、
   用了什么参数。
5. `CLAUDE.md` 的环境事实（Windows 子进程、GBK 解码）。

---

## 执行内容

### 1. 先做"证据"，再做"能力"

在做任何隔离之前，先写一套**能证明问题的探针**：

`apps/desktop/scripts/mc035-egress-probe/`

- `probe-a.mjs`：在当前 `permissionedProcessRunner` 起的子进程里，尝试 **5 种**
  出站方式，每种都打一行结果：
  1. `net.connect()`（应当被守卫拦住）
  2. `dns.lookup()`（应当被拦住）
  3. `worker_threads` 里重新 `import("node:net")` 再连（**大概率能绕过**）
  4. `process.binding("tcp_wrap")` / 原生 addon（如果可用）
  5. `fetch()` / `undici`（Node 内置）
- 输出格式：每种方式一行 `method=<n> result=<blocked|connected|error:...>`。
  这一套要能在**今天的代码**上跑，把「拦住了什么、漏了什么」变成数字。

> 这套探针本身就是交付物：即使最终做不到 OS 级隔离，它也把风险边界说清楚了。

### 2. OS 级隔离（按平台）

按可行性从高到低尝试，**每一层都要能独立生效**：

| 平台 | 手段 | 备注 |
|---|---|---|
| Windows | **AppContainer** 或 Job Object + WFP 过滤，或最简：把子进程放进一个没有网络能力的 Windows Sandbox/AppContainer profile | Windows 上没有 `unshare`，这是最重的部分 |
| macOS | `sandbox-exec` 配置文件（`(deny network*)`） | 已废弃但可用；备选是 Network Extension |
| Linux | `unshare --net`（需要权限）或 seccomp | 本机大概率测不了 |

**重要**：不要为了"看起来实现了"而写一个只在测试里生效的假隔离。
如果某个平台做不到，写清楚**为什么**，并把"能力探测失败 → 拒绝启动扩展"
作为**fail-closed** 的替代（这比 fail-open 好，但仍是降级）。

### 3. fail-closed 加固（无论 OS 隔离是否成功，这一步必做）

无论上面做到哪一层，都要改掉现有的 fail-open 风险：

- 守卫**安装失败**时，子进程必须**拒绝执行任何扩展代码**并以可诊断错误退出
  （检查现有代码是不是已经这样 —— 文件里出现了 `network_guard_setup_failed`，
  确认它是否在所有路径上都抛）。
- 守卫安装后，**周期性自检**（例如在执行每个扩展 action 前重跑一次探针的最小版本），
  发现被绕过立即终止子进程并记录。

### 4. 测试

- `mc035-egress-probe` 的 5 种方式全部有断言，每种都写明**期望**与**实际**。
- 新增 `mc035-egress-isolation-smoke`：
  - 在隔离生效的平台上，5 种方式**全部**应为 blocked；
  - 守卫安装失败 → 扩展**不执行**（断言子进程 exit code 与 stderr 文案）；
  - 变异验证：撤掉 fail-closed → 「守卫失败仍执行」断言变红。

---

## 边界（不要碰）

- **不要**降低现有防护（守卫被保留，OS 隔离是叠加，不是替换）。
- **不要**改 `ModuleHost` 的安装/授权协议（那是别的切片的合同）。
- **不要**改工作流、文档、移动端。
- 不要引入需要联网下载的原生依赖（本机安装 `sandbox-exec` 之类只做能力探测）。

---

## 验收判据

1. `mc035-egress-probe` 在**当前代码**上跑出真实数字（哪种拦住、哪种漏了）。
2. OS 级隔离在**至少一个平台**上真实生效，并有探针证明 5 种方式全部 blocked。
3. 做不到的平台：写入文档 + fail-closed 生效 + 有断言。
4. 现有 `module-protocol-integrity-smoke` 等 5 套全绿（不能因为加固把正常扩展打死）。
5. 双包 tsc 干净。
6. **变异验证**：撤掉 OS 隔离 → 探针必须变红（这条是本任务的核心证据）。

---

## 你要在回写区回答的问题

- 探针在**今天**的代码上跑出什么结果？哪一种方式能绕过？
- 本机做到了哪一层？没做到的原因是什么（权限/平台限制/时间）？
- 是否有任何路径在守卫失败后仍然执行扩展代码？
- 你建议 MC-035 的开发勾如何处理（保持 `[ ]` / 部分达成 / 达成）？给出理由，
  **但不要自己勾**，由我核对后写台账。

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-20 执行回写（T06 / MC-035，未全部达成）

- **提交 SHA（源码与测试）**：`b2fe788d562c945ab910f3caf448635d393431c5`，提交 `fix(T06): enforce verifiable OS egress isolation or deny extension`；仅提交、不推送。用户指定的 `tasks/T06.md` 在仓库中不存在，按任务索引 `tasks/README.md` 唯一 T06 条目定位到本文件 `tasks/T06-mc035-os-egress-isolation.md`。
- **实际改动文件**：`apps/desktop/src/main/modules/permissionedProcessRunner.ts`；`apps/desktop/scripts/mc035-egress-probe/{probe-a.mjs,main.ts,README.md}`；`apps/desktop/scripts/mc035-egress-isolation-smoke/{main.ts,run.sh}`。未改 `ModuleHost` 协议、工作流、文档、移动端、统一台账，也未修改他人并发中的 `.aoci/baseline.json` 和 `arc005-visual-baseline/`。
- **执行前真实探针（E1）**：`node apps/desktop/scripts/mc035-egress-probe/probe-a.mjs`：`net.connect=blocked`、`dns.lookup=blocked`、`worker_threads=error:ERR_ACCESS_DENIED`、`process.binding(tcp_wrap)=error:ERR_ACCESS_DENIED`、`fetch=blocked`；汇总 **3 JS 拦截 + 2 Node 权限拒绝 / 0 confirmed egress**。这 5 种路径没有证实当时生产 JS 守卫可绕过；`dns.lookup(localhost)` 是本机主机名解析，不是 OS DNS 出站有效性证据。整改后同一探针显示 **5 blocked/0 connected/0 error**，但 Windows 是**启动前拒绝**，绝不能把它称为 Windows OS 沙箱已验证。
- **OS 实现/限制（E1+E2）**：Linux 生产路径使用 `/usr/bin/unshare --user --map-root-user --net -- <node>`；macOS 生产路径使用系统 `sandbox-exec -p '(version 1)(allow default)(deny network*)'`；两者**先运行不注入 JS 守卫的真实 OS TCP 回环探针**，只有检测 `ENETUNREACH/EHOSTUNREACH/EPERM/EACCES` 时才运行扩展，错误/缺能力则拒绝。Windows 尚无可验证 AppContainer/WFP 子进程启动器，不使用 Job Object 伪隔离、全局防火墙规则或联网安装的原生依赖：所有未获网络权限的可执行扩展**安装核验与调用均拒绝**（`egress_isolation_unavailable`，运行时 `isolated_denied`）。WSL Ubuntu 运行 `unshare --user --map-root-user --net python3 [127.0.0.1 connect]`：同类回环连接普通 namespace errno **111/ECONNREFUSED**、新 netns errno **101/ENETUNREACH**，证明这台机器 Linux 内核命名空间确实阻断了网络；**WSL 未安装 Linux Node**，未能在生产 Node Linux 路径上重跑 5 种 JavaScript 攻击，也未在 macOS/Windows AppContainer 真实运行，因此**验收 2 未签字**。
- **守卫失败路径（E1+E2）**：`wrapOwn` 发现存在但不可修改的入口即抛；移除网络模块/原型包装过程中吞掉的初始化错误；guard 初始化抛错发生在任何 `eval` 之前；每次执行前、执行后以及间隔 50ms 自检主要网络入口，不变量破坏即非零退出（stderr `network_guard_integrity_failed`）。真子进程通过冻结 `node:net.connect` 制造 `network_guard_setup_failed`，验证 **stderr 诊断、exit 非零、扩展代码标记未执行**，未发现可证实的“守卫安装失败仍执行代码”路径；自检不替代 OS 沙箱，定时器无法在阻塞 event loop 的同步恶意代码中抢占。
- **新回归**：`node apps/desktop/scripts/run-smokes.mjs mc035-egress-isolation-smoke` → **1/1 suite PASS，14/14 断言 PASS**，末次日志 `apps/desktop/.tmp/smoke-runs/1792493719023-15692-rWxypE/mc035-egress-isolation-smoke.log`。
- **生产码双变异验证**：① 将 `egressLaunch` 改为未经 OS 探针就返回原生 Node（撤 OS 隔离 fail-closed），`mc035-egress-isolation-smoke` **9/14 PASS、5 红**，日志 `apps/desktop/.tmp/smoke-runs/1792493444094-19776-86YUsO/mc035-egress-isolation-smoke.log`；② 将 `network_guard_setup_failed` 的 `throw` 改成 `console.error`（撤 fail-closed），**12/14 PASS、2 红**，日志 `apps/desktop/.tmp/smoke-runs/1792493495697-172-NGJyh9/mc035-egress-isolation-smoke.log`。每次立即从原始备份恢复，`fc /b` 均报告**找不到差异**（Windows 字节级等价 `cmp`）；当时原始/恢复 SHA256 均 `cf79c8440c4d7929b31c297a7b0b73f9591df7026e20ef7335503886bb8de578`。恢复后新增回归再绿；随后另加严格捕捉可选 wrapper 错误及绝对 `unshare` 路径，并最后再次验证新回归 14/14 绿。
- **原有 5 套回归（验收 4 未达成）**：`node apps/desktop/scripts/run-smokes.mjs module-protocol-integrity-smoke arc006-registry-guard-smoke engine-node-preflight-integrity-smoke engine-node-start-gate-smoke workflow-engine-bridge-smoke`，其中四套 PASS，`module-protocol-integrity-smoke` **6/15 PASS、9 FAIL**（正常无网络权限的扩展在 Windows 被启动前拒绝，旧的协议执行正控无法进入进程）。合并新 smoke 的 6 套为 **5 PASS / 1 FAIL**，日志 `apps/desktop/.tmp/smoke-runs/1792493646231-11888-55FPGK/`。另加 `module-extension-lifecycle-smoke` 的运行在安装合法扩展时失败，日志 `apps/desktop/.tmp/smoke-runs/1792493331686-34692-tTZDTw/`。不能声称“正常扩展没有被打死”；这是 Windows 安全 fail-closed 的明确产品限制与兼容回归，尚未解决。
- **双包 TypeScript（验收 5 未达成）**：`npx tsc --noEmit -p packages/contracts/tsconfig.json` → **PASS / 0 错**；`npx tsc --noEmit -p apps/desktop/tsconfig.json` → **FAIL / 1 错**，并行他人未跟踪文件 `apps/desktop/scripts/arc005-visual-baseline/probe.ts:222:65 TS2774`（本任务只读，未动）。末次检验仍报此错；不宣称双包 tsc 干净。
- **未验/风险与开发勾建议**：验收 **1、3 有当前有界 E1/E2 支持**，验收 **2 未有 Linux/macOS Node 五路生产强隔离的端到端证据**，验收 **4、5 失败**，验收 **6 有 Windows 两次反向变异红/绿，但缺实际 Linux/macOS 撤 OS 包裹的五路动态变异**。当前 Linux/macOS 代码只在可验证能力的平台生效，Windows 用户可执行扩展被 fail-closed 阻断；必须补 Windows 真 AppContainer/WFP 实现、保住正常扩展正控、跨平台真实 Node 与 Electron/三引擎 U1 后再申请 MC-035 关闭。**建议 MC-035 开发勾仍保持 `[ ]`，独立复核 `[ ]`；这次仅是部分修复，未自己改台账。**


### 2026-10-21 追加复验（T06 / MC-035，基于后续 T11 当前源码）

- **范围**：此轮仅复查 T06 已提交的 OS 网络隔离与随后 T11 引入的 Windows 降级；不覆盖其他执行者已提交的 T11 生产代码，不改 ModuleHost 的安装/授权合同，不碰并行未提交文件。**更正** `apps/desktop/scripts/mc035-egress-probe/README.md` 曾与后续生产行为相反的 Windows 说明。当前生产源码 `apps/desktop/src/main/modules/permissionedProcessRunner.ts` SHA256 `4a5e39e85ddad97247a2891873c1c9ecaf46c73759e4ddb1366be91d35bc49e6`（Git 提交 `5ac27b05` 后已改为 JS-only）。
- **实际探针（E1）**：`node apps/desktop/scripts/mc035-egress-probe/probe-a.mjs` → `net.connect=blocked`、`dns.lookup=blocked`、`worker_threads=blocked`、`process.binding(tcp_wrap)=blocked`、`fetch=blocked`，汇总 **5/5 blocked、0 connected、0 error**。这些是 Windows 真子进程的 JS 守卫/Node 权限结果，**不是 Windows OS 出站隔离证明**；`dns.lookup` 为本机解析测试。
- **现有回归（E1）**：`node apps/desktop/scripts/run-smokes.mjs mc035-egress-isolation-smoke module-protocol-integrity-smoke arc006-registry-guard-smoke engine-node-preflight-integrity-smoke engine-node-start-gate-smoke workflow-engine-bridge-smoke module-extension-lifecycle-smoke` → **7/7 suites PASS、0 FAIL**；日志 `apps/desktop/.tmp/smoke-runs/1792541393019-36460-shY2vb/`。原先被 T06 Windows 完全拒绝策略打红的协议、生命周期正控，后续 T11 已恢复；此绿不能证明 OS 级隔离。
- **双包 tsc（E1）**：`npx tsc --noEmit -p apps/desktop/tsconfig.json` → exit 0；`npx tsc --noEmit -p packages/contracts/tsconfig.json` → exit 0。两项当前都通过。
- **目前实质未达成判据**：**#2** Windows 没有真实 AppContainer/WFP 子进程限制器，本机 WSL Linux 只有前次 Python `unshare` OS 级负例，**没有 Linux Node 生产进程五路 blocked E1**，macOS 未实测；**#3** T11 后 `unapprovedNetworkLaunch()` 在 Windows 返回原生 Node、无 OS 探针；对未声明 network 的任意可执行源码，仅执行 `NETWORK_GUARD` 并允许核验及调用成功，故 **“缺 OS 能力→拒绝执行”严格 fail-closed 未达成**，即使结果附带 `_mcodeEgressIsolation` 明示降级。声明 network 的执行扩展由 `ModuleHost` 安装/调用时 `requireNetworkExtensionSupport()` 拒绝，不能混称所有扩展均拒绝；**#6** 曾于 2026-10-20 完成 Windows 生产码两组反向变异并逐字节还原，但**仍无实际 Linux/macOS OS 包裹撤除→同一五路探针红→逐字节还原绿的真实验证**。本次仅更新不准确的说明文档，**无新增代码断言，也无新的变异执行**；不把既有变异冒充今天执行。
- **守卫失败路径与剩余风险**：原 T06 已有真子进程 `network_guard_setup_failed` 非零退出、扩展标记不执行与安装后定期完整性检查的 E1；本轮相关 smoke 仍 PASS，未观察到安装失败后继续执行。Windows JS-only 不能抵御所有恶意底层调用，需真正 Windows per-child OS egress 限制器或恢复严格启动前拒绝；Linux/macOS 待其本地 Node 五路动态对抗和 OS 隔离反向变异。**MC-035 开发勾建议仍 `[ ]`，独立 `[ ]`，本对话不修改台账。**
- **提交说明**：本追加回写及 README 勘误合并为一条仅文档提交（提交 SHA 以本轮 `git log -1` 为准）；未改任何生产/测试代码，未推送。旧提交 `b2fe788d562c945ab910f3caf448635d393431c5` 的 T06 技术变更仍可追溯，但其 Windows fail-closed 路径被后续 `5ac27b05` 调整。
