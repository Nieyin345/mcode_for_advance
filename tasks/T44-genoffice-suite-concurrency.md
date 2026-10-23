# T44｜genoffice 套件在并发下互相踩：没有工作树锁

- Status: ready-for-agent
- Category: bug（测试基础设施）
- Priority: P1
- Depends on: none
- Exclusive writable files: `apps/desktop/scripts/genoffice-source-smoke/`、`genoffice-vendor-freshness-smoke/`、`t87-genoffice-provenance-license-smoke/`、`apps/desktop/build/verify-genoffice-upstream.cjs`（若需）、新建共享锁模块。

## Required Skills
- `mcode-smoke`: 理解这个仓库的无头套件布局与 `run.sh` 形态。
- `codebase-design`: 共享状态的锁该放在哪一层。

Read before work: `CLAUDE.md`（尤其「多会话并行时的两条硬约束」）、`apps/desktop/scripts/genoffice-source-smoke/run.sh`、`genoffice-vendor-freshness-smoke/run.sh`、`t87-genoffice-provenance-license-smoke/run.sh`、`apps/desktop/build/verify-genoffice-upstream.cjs`。

## 现象（A 的 T29 全量报告，我独立复核）

A 跑全量 smoke 得到 **536 通过 / 7 失败**，其中两条是 genoffice 的：

- `genoffice-source-smoke`
- `genoffice-vendor-freshness-smoke`

**但这两条单跑全绿**：

```bash
bash apps/desktop/scripts/genoffice-source-smoke/run.sh          # → 26/26 PASS
bash apps/desktop/scripts/genoffice-vendor-freshness-smoke/run.sh # → 29/29 通过
```

**「单跑绿、并发红」= 共享状态竞争。** 不是断言错，不是产品坏。

## 根因（**我已经找到，总控实测**）

**不是「读取撞车」，是「一边读一边有人原地篡改真实 vendor 工作树」。**

`genoffice-source-smoke/main.cjs` 的每一条断言都是**先改真文件、跑断言、再还原**：

```js
// L158-160  篡改补丁字节
fs.writeFileSync(patch, tampered);
finally { fs.writeFileSync(patch, saved); }

// L165-167  往 vendor 文件里注入 "// T31 fixture mutation"
fs.writeFileSync(file, saved.toString("utf8") + "\n// T31 fixture mutation\n");
finally { fs.writeFileSync(file, saved); }

// L172-176  篡改 vendor package.json 的 name
// L209-222  往 .git/info/exclude 里注入，然后还原
```

**这些全部作用在真实的 `genoffice/` 工作树上，不是副本。** 它的 `mktemp`（L30 `mcode-go-upstream-`）只用于**夹具克隆**，真工作树的篡改是原地做的。

### 所以并发时会发生什么

| 套件 | 做什么 | 被谁破坏 |
|---|---|---|
| `genoffice-source-smoke` | **原地篡改** vendor 文件 → 断言 → 还原 | — |
| `genoffice-vendor-freshness-smoke` | 读 `out/` 产物时间戳 + 读 renderer 里 `aiToolResult` 标记 | 读到被注入 `// T31 fixture mutation` 的中间态 |
| `t87-genoffice-provenance-license-smoke` | `git stash`-free 的 patch replay，比对 tree hash | 读到被篡改的补丁字节 |

**这就是「单跑绿、并发红」的确切机制。**

⚠️ **而且这有个更严重的后果**：`genoffice-source-smoke` 如果**在还原前被中断**（Ctrl-C、超时被杀、机器卡顿），**真实 vendor 工作树会留在一个被篡改的状态**。这时 `verify-genoffice-upstream.cjs` 会失败，而人会以为是「补丁链坏了」。

## 修法方向（推荐，但要论证）

**核心原则：套件不许碰真实工作树。**

- **(A) 副本上篡改**：`genoffice-source-smoke` 先把 vendor 工作树克隆/复制到 `mktemp` 目录（它已经有 `mkdtempSync` 的基础设施），**所有篡改都在副本上做**。
  - 优点：从根上消除竞争，不需要锁；顺带解决「中断留脏状态」；
  - 缺点：克隆一个大树的成本。**先测一下实际耗时**，如果 > 30s 就要考虑 (B)。
- **(B) 加锁**：用 `withOsFileLease`（`apps/desktop/src/main/lib/osFileLease.ts:133`）包住整个「篡改→断言→还原」窗口。
  - 优点：成本低；
  - 缺点：**只防并发，不防中断**——被杀时照样留脏状态。而且三套都要参与加锁才有效。

**我倾向 (A)，因为它同时解决两个问题。** 但如果克隆成本太高，(A)+(B) 也可以：副本 + 副本内的锁。

**把实测的克隆耗时写进回写区，作为选 A 还是 B 的依据。**

## 目标

### 必须做到

1. **先确认我的根因判断。** 我读的是 `main.cjs` 的 L158-238，你要用实测确认：并发跑时到底哪套先红、错误信息是什么、是不是读到了 `// T31 fixture mutation` 或被篡改的补丁字节。

2. **修掉「原地篡改真实工作树」这件事本身。** 这是根因，锁只是缓解。

3. **顺带解决「中断留脏状态」**：现在如果 `genoffice-source-smoke` 在还原前被杀，真实 vendor 工作树会留着篡改痕迹，让人误以为补丁链坏了。修完之后**故意 Ctrl-C 一次**，确认工作树干净（`git status` 在 `genoffice/` 里无改动）。

4. **验证**：并发跑 N 次（建议 5 次）全绿，且**证明修法真的起作用**（撤掉修法 → 并发必红）。

### 明确不做

- **不把断言改弱**。如果说「全量时跳过这三套」，那是掩盖问题。
- **不改 `genoffice/` 上游源码**。
- **不改 `run-all-smokes.sh` 的并发策略**（除非有证据表明它本身是根因）。

## 验收判据

1. 回写区给出**复现的确切错误信息**与共享状态的证据。
2. 修法（加锁 / 分目录 / 其他），附论证为什么这样不会把失败藏起来。
3. **并发 5 次全绿**；**撤掉锁 → 并发必红**（变异验证）。
4. 三套单跑仍然全绿。
5. 双包 typecheck 通过。

## 边界

- 只改 `apps/desktop/scripts/genoffice-*-smoke/`、`t87-genoffice-provenance-license-smoke/`、`apps/desktop/build/verify-genoffice-upstream.cjs`（若需）+ 新建共享模块。
- **不碰** `genoffice/` 上游源码。
- **不碰** `ipc/index.ts`（A 的 T40）、`documentToolSurface.ts` / `genofficeCli.ts`（B 的 T43）、`renderer/`（C 的 T41）、`electron-u1/`（E 的 T42）。

## 为什么这是 P1 不是 P2

**它会伪装成「产品坏了」。** A 在 T29 的报告里必须逐个核实才能确认「这 7 条与我无关」，而这一步是靠自己逐个单跑来做的——**下一个做同样判断的人未必有这份耐心**。测试基础设施的假红会让人怀疑真实的产品缺陷。

而且 C 的 T39 刚加了第 14 个补丁，`genoffice` 那条链现在更复杂了，并发竞争只会更多。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**
`withOsFileLease` 的用法先读 `apps/desktop/src/main/workflowEngines/` 里的现有实现，不要自己发明锁协议。

## 提交

`git add <明确路径>` 后**立刻** `git commit -- <明确路径>`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T44-genoffice-suite-concurrency.md` 末尾追加 `## 结果回写（2026-10-23）`：复现证据、共享状态根因、修法论证、并发 5 次结果、变异证据、提交 SHA。
