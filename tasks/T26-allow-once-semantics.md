# T26｜「允许一次」的文案与它的实际语义不符

- Status: ready-for-agent
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

（执行者在此追加：判断与依据、改了哪些文案、grep 结果、断言与变异证据、提交 SHA）
