# T52｜`setting.set` 审批粒度 —— **实测发现：凭据可被覆盖**

- Status: **done（2026-10-23 验收通过：27/27，提交 `d32a5bb7` + `68c5e469`）**
- Category: **bug（P0 安全）**
- Depends on: T33（`policy.ts` 档位）、T49（无直接依赖）

## 总控的原假设（错了两次）

**第一次**：我以为问题是「审批卡只写 `setting.set`，用户不知道在改什么」。

**第二次**：我以为「API 密钥、已配对设备可能已经不可写，那 T52 只剩显示键名」。

**实测两次都推翻了。**

## 真漏洞：读侧拦了，写侧没拦

E 逐个探 `setting.set`：

```
engine.claude.apiKey     → ✅ 放行
customModelKeys          → ✅ 放行
mobile.pairedDevices     → ✅ 放行
plugins.engines          → ✅ 放行
relay.vpsConfig          → ✅ 放行
```

再探读侧：`setting.get` / `setting.getMany` 对同样的键**全部拒绝**。

**所以是「读不到，但能覆盖」。**

### 覆盖比读取更危险

- 读到密钥要把它带走才造成损失；
- **覆盖一次就生效**：把用户正在用的引擎指向任意地址、把已配对设备清空、改插件投递策略。

### 已有闸只管执行授权

`isWorkflowExecutionTrustSettingKey` 挡的是 `workflow.review.v1.*` 和 `workflow.pinnedDefaults`（**执行授权事实**），已确认生效。

**它不管凭据本体。**

## 两步交付

### 第一步（`d32a5bb7`）：审批卡显示实际在写什么

**实测三件事**：
1. `gateAppAction(ctx, level, entry.method, args.input, ...)` **已经把整个 `{key, value}` 传进去了**，问题只是它构造 description 时没看；
2. `ApprovalPrompt.tsx:184` 渲染 `description`、`:192` 渲染完整 `input`（可展开）—— **渲染能力从来不是瓶颈**；
3. 敏感键有现成分类表 `@main/lib/secretKeys.ts` 的 `isSecretSettingKey`，**没另造**。

**落点**：`activityShared.ts` 的 `toolSummary()` —— 它是摘要行的唯一来源，四个调用点共用。

**不判敏感**：渲染端拿不到主进程那份名单，也不该复制一份。

### 第二步（`68c5e469`）：写侧加闸

新建 `appControl/settingWriteGuard.ts`：一份方法名集合 + 一个 `settingKeyRefusal()`，读/写各一条文案。`tools.ts` 的 `secretSettingRefusal` 委托给它（两处调用点自动生效）。

**为什么单独拆模块**：

> `tools.ts` 会拖进 Electron、vendor、原生插件——套件只想验判定逻辑，不该为此打包整个主进程。**这正是我第一版把断言写进套件后打包失败的直接原因。**

**为什么可以放心拦**：

> 正常写口**不走这条通道**：设置面板改密钥走 `customModel.save` / `codexModels.save` / `piModels.save` 等专用方法（各自管加密与校验）。移动端 HTTP 桥的 `touchesBlockedSetting` 早就是这个取向——**这里是把桌面侧的 agent 通道对齐到同一取向。**

## 验证

- `t52-approval-context-smoke` **27/27**（14 条卡摘要 + 13 条写侧）；
- 变异（清空写方法集合）：**7 条红**，`cmp` 逐字节还原；
- 回归：`app-control-smoke` 574/574、`policy-engine-smoke` 207/207、`approval-keyboard-safety-smoke` 51/51、`settings-import-backup-smoke` 162/162；
- 双包 typecheck 通过。

## 未做

1. **没做按键分档**（(A)）。现在是一刀切：所有密钥本体都不可经 `setting.set` 写。**这比按档位简单、也更容易论证**——但如果产品上有「某些密钥应该允许 AI 改」的需求，得再讨论。
2. **没有真 Electron 视觉验证**（审批卡长什么样没看过）。
3. **`setting.setMany` 按对称性一起拦了**，但它是否真的存在于调用面里没单独核——写守卫里列了它，不存在的名字不会误伤。

## 总控的教训

**我的两次假设都窄了。** 第一次只想「显示」，第二次以为「可能已经不可写」。

**E 的原话**：

> 我按你的要求先测了，结果是**范围必须变大**——不是「卡上显示键名」就够了，因为写侧本来就没有闸。

**「先测」的价值就在这里**：它不只验证假设，还能**推翻假设的方向**。
