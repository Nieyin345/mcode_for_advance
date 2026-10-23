# T37｜`mobile-pairing-smoke` 的 3 秒超时太紧，全量并发下随机红

- Status: ready-for-agent
- Category: bug（测试稳定性）
- Priority: P2
- Depends on: none
- Exclusive writable files: `apps/desktop/scripts/mobile-pairing-smoke/`。

## Required Skills
- `mcode-smoke`: 判断「偶发红」是超时不足还是真实竞态。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/mobile-pairing-smoke/`、`apps/desktop/scripts/run-smokes.mjs`（并发配置）。

## C 会话实测

> `mobile-pairing-smoke` 3 红，其中「配对请求不校验发起方」期望 200 实得 `status 0`。服务端日志显示配对**实际成功**（device paired），`status 0` 是 fetch 传输层失败，不是 401。**用绝对路径单独复跑 = 285 条 0 红**，前两次全量也是 0 红，main/mobile 最后改动是 10-19。

**结论**：2 并发全量下的偶发。但这套 **3 秒 `AbortSignal.timeout` 偏紧**。

## 为什么要开这张卡

C 的原话：

> 别留成「每次全量随机红一条」

**随机红会腐蚀基线的可信度**——下次看到它红，没人知道是真回归还是抖动。

## 工作顺序

**第一步：确认是超时不足，不是真实竞态。**

- 单独跑：285 条 0 红（C 已验）
- **并发跑**：看能不能复现
- 如果能复现，抓日志确认是不是 `AbortSignal.timeout` 触发

**如果发现是真实的并发竞态（不是超时），停下报告——那是产品缺陷。**

**第二步：修。**

两个方向：
- **调宽超时**（3 秒 → 10 秒），或
- **加重试**（仅对传输层失败重试，不对 401/403 重试）

**选一个并论证。** 注意：调宽超时会让真失败等更久，加重试可能掩盖真问题。

**第三步：验证。**

- 并发跑多次，确认不再随机红
- 单独跑仍 285 条绿

## 验收判据

1. 回写区写明：是超时不足还是真实竞态，依据是什么。
2. 修法（调宽 / 重试）与论证。
3. **并发跑至少 3 次，全部绿**。
4. 单独跑仍 285 条绿。
5. 变异验证：把修复撤掉 → 并发跑能复现红（如果环境允许）→ `cmp` 还原。
6. **不放宽任何业务断言**——只动超时或重试策略。

## 边界

- **只改 `mobile-pairing-smoke/`**。
- **不改** `run-smokes.mjs` 的并发配置——那是全局的，影响 542 套。
- 若发现修不了（比如根因在产品 IPC），**停下报告**。

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T37-mobile-pairing-flake.md` 末尾追加 `## 结果回写（2026-10-23）`：诊断结论、修法与论证、并发复跑结果、提交 SHA。
