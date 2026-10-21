# T25｜原子写与冲突副本的故障注入回归（maint-m07 9 红）

| 项目 | 值 |
|---|---|
| 编号 | T25 |
| 类型 | 数据安全（`atomicFile` / 冲突副本路径） |
| 优先级 | **高** —— 这 9 条红里 6 条是「崩溃时数据被半写/被覆盖」 |
| 建议并发 | 改 `src/main/lib/atomicFile.ts` 与 `src/main/lib/pathUtils.ts` 周边，**不要与任何改文件写路径的任务并行** |
| 预计规模 | 中 |

---

## 现状（实测，2026-10-21）

```
bash apps/desktop/scripts/maint-m07-smoke/run.sh
→ maint-m07-smoke: 94/103 checks passed，9 FAILED
```

9 条红分两组：

**A 组（6 条）：故障注入下原子写不原子** —— 这一组最严重。
```
FAIL ★ E1:rename 崩溃 → 写入如实报失败(不静默成功)
FAIL ★ E1:rename 崩溃 → 原文件逐字节不变(没被半写/覆盖)
FAIL ★ E1:崩溃后文件仍可读回原内容  {"actual":"SHOULD-NOT-LAND\n","expected":"ORIGINAL-BYTES-MUST-SURVIVE\n"}
FAIL ★ E1:临时文件 open 崩溃 → 报失败
FAIL ★ E1:临时文件 open 崩溃 → 原文件逐字节不变
FAIL 前提:注入后首发写入确实失败  {"actual":false}
```

最后那条是**前提断言**：注入故障后写入根本没失败，说明故障注入本身没生效，
或者写入路径绕开了被注入的那个函数。**先修这条**，否则前五条的红/绿都没有意义。

**B 组（3 条）：冲突副本写失败时谎报成功 + 残留**
```
FAIL ★ MC-024:副本写失败 → 不谎报 conflictPath  {"actual":"…mc024-copy-fails.conflict-2026-10-21T03-42-57-760Z.ts"}
FAIL ★ MC-024:副本写失败 → 不留下半截副本/临时残留  {"actual":1,"expected":0}
FAIL listDir 也认(projectPath 与 dirPath 同一份写法)  {"actual":2,"expected":1}
```

第二条尤其违反仓库硬规矩「坏东西显式报出来」：副本压根没写成功，
却把一条 conflictPath 返回给上层，用户以为冲突已保存，实际什么都没有。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `apps/desktop/scripts/maint-m07-smoke/main.ts` —— **全文**，尤其：
   - 故障注入是怎么做的（monkeypatch 哪个模块的哪个函数）
   - 「前提:注入后首发写入确实失败」这条断言的位置（它先红，先信它）
3. `apps/desktop/src/main/lib/atomicFile.ts` —— 唯一出口 `exportBytes` / `atomicReplaceFile`。
4. `CLAUDE.md` 的环境事实：**sql.js 的 `db.export()` 会重置连接上的 pragma**，
   导出只有 `exportBytes()` 一个出口。这条与 `atomicFile` 是两回事，别混。
5. `tasks/README.md` 的「已修复的回归」段 —— MC-024 的修复（`b4648913`）在案，
   本次是它的**故障分支**没被覆盖。

---

## 执行内容

### 第 1 步：让故障注入真的生效（前提断言先绿）

- 读 `maint-m07-smoke/main.ts` 的注入点，确认它 patch 的是**产品代码实际调用的那个函数**。
- 如果产品代码换了实现（比如从 `fs.rename` 换成了 `fs.renameSync` 或走了别的原子写库），
  注入点要跟着改 —— **但先确认这不是产品代码本身绕开了原子写**。
- 判据：注入后首发写入必须**真的失败**（`actual: true`）。

### 第 2 步：rename 崩溃时的原文件保护

- 语义要求：`rename(tmp → target)` 崩溃，`target` **逐字节保持原样**，
  写入调用**返回失败**（不能静默成功）。
- 如果当前实现是先截断再写，改成一贯的「写临时文件 → fsync → rename」。
- 判据：`SHOULD-NOT-LAND` 绝不能出现在原文件里。

### 第 3 步：临时文件 open 崩溃

- `open(tmp, 'w')` 失败时：原文件不变、返回失败、**不留下 0 字节的 tmp**。
- 判据：桶里不能有残留（`readdirSync` 数量断言）。

### 第 4 步：冲突副本写失败不谎报

- `MC-024` 的冲突副本路径：副本写失败时，返回的 `conflictPath` 必须是 `undefined`/`null`，
  并且**把真正的失败原因报出来**（不是笼统的 "conflict"）。
- 副本写一半失败要清理干净（临时文件 + 半截副本）。
- 判据：`actual` 不能再是一个存在的路径；残留计数为 0。

### 第 5 步：`listDir` 的 path 归一

- `projectPath` 与 `dirPath` 是同一个位置的不同写法（如 `D:\x` vs `D:/x` vs `D:\x\`），
  只应返回一份。现在返回 2 份。
- 判据：同一物理目录的多种写法去重后为 1。

---

## 边界（不要碰）

- 不改 `maint-m07-smoke/main.ts` 的**断言语义**（只允许改注入机制以匹配产品实现；
  改断言前必须先在回写区说明为什么旧断言已经不成立）。
- 不改 `maint-m35-smoke` / `maint-m22-smoke`（另两张卡）。
- 不改 sql.js 的 `exportBytes` 那条路径（CLAUDE.md 点名的坑）。
- 不改 `packages/contracts`。

---

## 验收判据

1. `bash apps/desktop/scripts/maint-m07-smoke/run.sh` → **103/103 通过**。
2. 前提断言「注入后首发写入确实失败」为真（不是靠删断言变绿）。
3. 现有相关套件不回归：
   `node apps/desktop/scripts/run-smokes.mjs maint-m07-smoke file-write-lease-smoke file-write-cas-smoke library-trash-smoke`
   （套件名以 `ls apps/desktop/scripts/ | grep -E 'file-write|atomic'` 实际结果为准）
4. 双包 tsc 干净。
5. **变异验证**：撤掉原文件保护（让 rename 崩溃时原地覆盖）→ 至少 2 条断言变红；
   撤掉冲突副本的失败检查 → 「不谎报 conflictPath」变红。逐字节 `cmp` 还原。

---

## 回写区要回答

- 故障注入原先为什么没生效？是注入点错了，还是产品代码绕开了原子写？
- 当前 `atomicReplaceFile` 的实现是「写临时 → rename」吗？中间有没有 fsync？
- `MC-024` 的冲突副本走了哪条路径？为什么失败时还能返回一个路径？
- `listDir` 的重复是通过什么方式产生的（大小写、斜杠、尾斜杠、符号链接）？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 · T25 执行回写（E1/E2）

- **范围/版本**：开工基线 Git HEAD `5eaa4ad7`；仅调整 `apps/desktop/scripts/maint-m07-smoke/{fsFaultShim.ts,run.cjs,main.ts}` 的故障注入机制，以及 `apps/desktop/src/main/ipc/files.ts` 的冲突副本错误回包。不改断言语义，不改 `atomicFile.ts`、`conflictCopy.ts` 的正式实现。其它执行对话的未提交文件保留原状。
- **原注入失效根因（E2）**：原 harness 仅对 `node:fs/promises` 设置 esbuild alias，而 `lib/atomicFile.ts` 实际 `import ... from "fs/promises"`，`rename/open` 注入被绕过，生产代码没有绕过原子写。现改成 esbuild resolve 插件同时拦截带/不带 `node:` 的导入，仅对 shim 自身的真实系统调用放行，避免递归。将 MC-024 的失败注入从错误的“冲突命名上的 rename”改为实际 `link(staging, target)` 发布点。
- **原文件保护（E2 + E1）**：`atomicReplaceFile` 现有实现本来就为同目录 `open(tmp,wx)` → write → chmod（非 Windows）→ `handle.sync()`（fsync）→ close → `rename(tmp,target)`；捕获写入/rename 失败后清理 tmp 并抛错。修正故障注入后，rename/open 报错时原文件逐字节不变、无 `.mcode-tmp` 残留，主套件前提「注入后首发写入确实失败」为真。
- **冲突副本（E2 + E1）**：`writeConflictCopy` 先用原子写保存 `.mcode-stage`，再经 `link(staging, conflictPath)` no-clobber 发布，`finally` 清理 stage。以前注入 `rename` 且把目标误判为 `.conflict-`，没有命中 stage 的 rename，导致假成功。现在注入 `link` 失败，产品原有异常传递/清理生效；IPC 失败回包为 `{ok:false,conflict:true,error:"冲突副本保存失败: <实际错误>"}`，没有 `conflictPath`，日志也保留实际原因。
- **listDir 的 2 条问题（E1）**：不是 `projectPath/dirPath` 大小写或斜杠的物理路径去重缺陷，而是前述失效注入多生成了真实存在的 `mc024-copy-fails.conflict-*.ts`；该测试先删正常冲突副本，却没清除原本应写失败的这一份。修正注入后目录确为 1 条；原有同一位置大小写变体守卫也通过。
- **验收**：`node apps/desktop/scripts/maint-m07-smoke/run.cjs` → **103/103**；`node apps/desktop/scripts/run-smokes.mjs maint-m07-smoke atomic-file-smoke file-restore-atomic-smoke library-trash-smoke` → **4 pass / 0 fail**。任务卡示例 `file-write-lease-smoke`、`file-write-cas-smoke` 目录不存在（按任务允许的实际存在套件替换）。`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` 和 `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` 均 exit 0。
- **变异证据（E1）**：暂时将 `atomicFile.ts` 的 rename 失败分支改为“直接覆盖目标后仍抛错”，跑同一主套件 → **101/103**，恰好“原文件逐字节不变”和“崩溃后读回原内容”2 条红；还原后 `git diff --exit-code -- atomicFile.ts` 通过。暂时将 `conflictCopy.ts` 的 link 异常吞掉并伪报路径 → **102/103**，“副本写失败不谎报 conflictPath”明确红；还原后 `git diff --exit-code -- conflictCopy.ts` 通过。两处原代码均已逐字节还原（Git diff 为 0），本轮不提交变异代码。
- **验收未达成**：无。边界：本轮仅做隔离 E1 / 源码 E2，未宣称完成整产品 Electron U1 或全量其它任务的 smoke。
