# F010｜`deny` 在 bridge 层被默认成 `allow-once`

- Status: **done**（`e3fe99f0` + `0a2ecfe9`）
- Category: **P0 安全**（不是功能，是审批被绕过）
- Depends on: F006（`901e58ee`，发现这个问题并做了临时挡法）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（`install` 签名 + `host.install` 调用）
  - `apps/desktop/scripts/vsix-install-consent-smoke/`（新建）
  - `apps/desktop/src/main/ipc/modules.ts`（**只改那一段的注释，让临时挡法的说明不再过时**）
  - 本卡回写

## Required Skills
- `mcode-smoke`

---

## 事实

```ts
// moduleHost.ts:554
install(raw: unknown, grantedPermissions?: readonly ModulePermission[], decision: ModuleInstallDecision = "allow-once"): Promise<ModuleChangeResult> {
  // 拒绝是**第一件事**：在解析/校验/任何持久化之前就结束。这条顺序本身就是
  // 安全属性（拒绝 = 磁盘零写入）
  if (decision === "deny") throw Error("用户拒绝了这次安装，未写入任何内容");
```

**`decision` 有默认值 `allow-once`。**

而 bridge：

```ts
// vscodeL1Bridge.ts:577
await host.install(checked.manifest);      // ← 没传 decision
```

**所以用户选 `deny`，走到 bridge 就被默认成 `allow-once` 了。**

### 现在的挡法在哪

F006 在 handler 里挡的：

```ts
// ipc/modules.ts:62-64
const decision = resolveInstallDecision(input, event);
if (decision === "deny") throw Error("用户拒绝了这次安装，未读取任何文件");
const bytes = new Uint8Array(readFileSync(input.path));
```

**这个挡法有效，但它是唯一一道**，而且它离 `host.install` 很远
（中间隔着：读文件 → 解析 vsix → 转 manifest → `ModuleInstallSchema.parse`）。

**任何新的调用方**（比如将来工作流里调、或测试直接调 bridge）都会绕过它。

---

## 任务

### 一、`VscodeL1Bridge.install` 加 `decision` 参数

```ts
static async install(
  host: ModuleHost,
  archive: Uint8Array,
  consent: { confirmReadAccess: boolean; confirmExecutableCode: boolean },
  l2?: VscodeL2Ports,
  decision?: ModuleInstallDecision,          // ← 新增
): Promise<VscodeL1Bridge>
```

然后：

```ts
await host.install(checked.manifest, /* grantedPermissions */ ..., decision);
```

**注意 `host.install` 的第二个参数是 `grantedPermissions`** —— 别把 decision 传成第二个。
看 bridge 现在怎么构造 `checked` 的：它用的是 `ModuleInstallSchema.parse({ manifest, ...consent })`，
**要确认 `grantedPermissions` 从哪来**；如果现在没传，说明它在走默认，那要一并想清楚。

**`decision` 缺省时保持现在的行为**（`allow-once`），**但要在注释里写明这个默认值的后果**。

### 二、`decision === "deny"` 要在**读文件之前**就返回

现在 bridge 的 `install` 第一件事是 `readMinimalVsix(archive)` —— 也就是说
**调用方已经读过文件了**（archive 是字节）。

**所以 bridge 里的 deny 挡的是「写盘」，不是「读文件」。** 真正的「零读取」只有 handler 能做
（因为它控制 `readFileSync`）。

**这个区别必须写进注释** —— 否则下一个人会以为加个参数就万事大吉。

### 三、handler 的临时挡法保留，但注释要改

现在 handler 的注释写着「若将来 bridge 加了 decision 参数，把第 2 步的结果一并传下去」。

**你加了参数之后，这句就过时了。** 改成：「两处都挡（handler 挡读文件，bridge 挡写盘），
**不是重复，是两道不同的门**」。

---

## 验收判据

1. **`install` 接受 `decision` 并透传给 `host.install`**（`grep` 证明第二个参数没传错位）；
2. **`deny` 时不写盘**（负控：断言 catalog 里没有这个模块）；
3. **`deny` 时抛的错误来自 `host.install` 那条**（不是 handler 那条 —— 证明真的透传到了）；
4. **不传 `decision` 时行为不变**（正控：现有调用方 `vscode-l1-smoke` 不破）；
5. **handler 的注释已更新**，不再说「将来要加」；
6. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| `decision` 不透传（回到 `host.install(checked.manifest)`） | **1 条红**（第 3 条：错误来源变了） |
| 把 `decision` 传成 `grantedPermissions` 位置 | **≥1 条红**（类型或行为） |
| `deny` 时仍然调 `host.install` | 1 条红（第 2 条负控） |

**⚠️ 变异先自证**：F008 的教训是「把 `"demo."` 改成 `"demo"` 但 `startsWith` 本来就 false，
变异什么都没改变」。**每个变异写完先确认它真的让行为变坏了，再跑套件。**

---

## 回写

1. `install` 的新签名，以及 `grantedPermissions` 的位置怎么处理的；
2. `decision` 从哪来（handler 传的？还是仍走默认？）；
3. **「读文件」和「写盘」两道门的区别**你写进注释的原文；
4. 变异三条结果；
5. 提交 SHA。

---

## 结果回写

### 1. 修了什么

**`VscodeL1Bridge.install` 的 `consent` 加了 `installConsent`**，并透传给 `host.install` 的**第三个**参数。

```ts
// 改前（decision 走 host 的默认 allow-once）
await host.install(checked.manifest);

// 改后
await host.install(
  checked.manifest,
  undefined,                                  // ← 第二个参数是 grantedPermissions，刻意留空
  consent.installConsent ?? "allow-once",     // ← 第三个才是 decision
);
```

**第二参数为什么留空**：VSIX 这条路径不做「逐项选择权限」，它请求 `resource.read`
（+ 可选 `resource.write`），两者都在 `host.install` 的「新模型可默认」白名单里。
**把 decision 塞进这个位置会被当成权限数组**，`assertModuleGrants` 抛一个
与「用户拒绝」毫无关系的错 —— 而那个错**看起来也像拒绝**。这是本卡变异 M2 验的。

### 2. ⚠️ 两道门不是重复 —— 写进注释了

| 门 | 位置 | 挡什么 | 为什么只能在这一层 |
|---|---|---|---|
| **handler** | `readFileSync` 之前 | **读文件** | bridge **做不到** —— 它拿到 `archive` 时字节已经读进来了 |
| **bridge** | `host.install` 之前 | **写盘** | 任何直接调 bridge 的调用方（工作流、测试）都绕过 handler |

**关键区分写进了两处注释**（`vscodeL1Bridge.ts` 的 `installConsent` 字段 + `ipc/modules.ts` 的 handler）：

> 从前 bridge 不透传 decision，只有 handler 那道有效 —— **任何新调用方都会绕过它**。

handler 那段原本写着「若将来 bridge 加了 decision 参数，把第 2 步的结果一并传下去」，
**已按卡要求改成「两处都挡，不是重复，是两道不同的门」**，并补了「怎么分辨是哪道拦的」。

### 3. `grantedPermissions` 从哪来 —— 现在**没有传**

bridge 构造 `checked` 是 `ModuleInstallSchema.parse({ manifest, ...consent })`，
`consent` 里从来没有 `grantedPermissions`。所以走的是 `host.install` 的
`grantedPermissions === undefined` 分支 —— 那条要求「所有权限都在可默认白名单里」，
而 `resource.read` / `resource.write` 正好都在。

**这是现在能装的原因，也是它的边界**：将来 VSIX 要是请求 `network` 或 `files.write`
之类非白名单权限，**会因为没传 grantedPermissions 而直接失败**（那句
「新权限模型的扩展必须在安装时逐项确认授权」）。**那时要补的是「逐项选择权限」的 UI，不是放宽这条。**

### 4. 变异三条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 decision 不透传（写死 `allow-once`） | 红 3 条 | **红 5 条** |
| M2 decision 传成 `grantedPermissions` 位置 | 红 ≥2 条 | **红 7 条** |
| M3 deny 时仍调 `host.install`（写死 `allow-always`） | 红 ≥3 条 | **红 5 条** |

**M2 的失败特征正是预期那种**：

```
FAIL ★ 缺省 decision 能装成功
      {"error":"[{ \"code\": \"invalid_type\", \"expected\": \"array\",
                  \"received\": \"string\", ...}]"}
```

**连 `allow-once` 都装不进去了** —— 那是「decision 被当成权限数组」的机器特征。
如果只验「deny 时抛错了」，这一条会被误读成「透传生效了」。

### 5. 套件为什么能分辨「是哪道门拦的」

**核心判据（卡里指定的第 3 条）**：

```ts
check("★ 错误来自 host.install（『未写入任何内容』），不是别处",
  r.error !== undefined && /未写入任何内容/.test(r.error));
check("★ 且不是 handler 那句（『未读取任何文件』）—— 证明不是被前面那道挡的",
  r.error !== undefined && !/未读取任何文件/.test(r.error));
```

**并且有一条断言守着「这两句话确实不同」**（第 [6] 组，读两份源码比对）——
否则哪天有人把它们统一成一句，第 [3] 组就分不出来了，而套件会**因为两句都对而继续绿**。

### 6. 自证记录（按 F009 的教训）

三条变异都先打印了「改动后行为会怎样」再跑套件：

- M1：`已硬编码 allow-once: True` → `deny 时 host.install 仍会被调用 → 应装进去` ✓（实际装进去了）
- M2：`decision 已塞进第二个位置: True` → `assertModuleGrants 会抛权限不合法` ✓（实际那条错）
- M3：`decision 已硬编码 allow-always: True` → `用户 deny 也会装成功` ✓（实际装进去了）

### 7. 提交

`e3fe99f0`（5 文件，+337/−7）。`tsc` exit 0，三条变异全部红在正确位置，
还原逐字节 `SAME (bfe66abb...)`。

**八套全绿**：`vsix-decision-passthrough 15/15`、`vsix-install-ipc 30/30`、
`vsix-main-path 30/30`、`vsix-command-prefix 14/14`、`vsix-manifest-schema 17/17`、
`vsix-deflate 24/24`、`vsix-size-limits 21/21`、`vscode-l1 27/27`。

### 8. 觉得不对但没改的

1. **`host.install` 的默认 `allow-once` 本身值得商榷。** 一个安全决策**有默认值**
   这件事，是这张卡能出现的根本原因 —— 如果它是必填参数（`decision: ModuleInstallDecision`
   没有 `?`），TypeScript 会在编译期就逼所有调用方传。**但改它影响全部调用方**
   （`modules.install`、工作流、测试），超出本卡边界。
   **建议单独评估**：把 decision 改成必填，编译期兜住这一整类问题。
2. **bridge 的 `consent` 现在有三个字段，但 `ModuleInstallSchema` 是 `.strict()`。**
   如果将来有人往 `consent` 里加字段却忘了同步 schema，`parse` 会抛
   —— 那是好事（显式失败），但错误信息会是 zod 的、不说人话。
3. **`ipc/modules.ts` 是 F006 的文件**，本卡只改了那段注释 + 加了 `installConsent:decision`。
   如果 F006 还有后续要动这个文件，会有冲突风险 —— 我查过工作区当时是干净的。
