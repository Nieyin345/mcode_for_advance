# T31｜三处既有失败挡住 `run-smokes --all`，全量基线跑不起来

- Status: ready-for-agent
- Category: **bug（测试基础设施）**
- Priority: **P0 工具链**
- Depends on: none
- Exclusive writable files: `apps/desktop/scripts/genoffice-file-routing-smoke/`、`apps/desktop/scripts/release-readiness-smoke/check-genoffice.cjs`、`apps/desktop/scripts/genoffice-source-smoke/`、相关夹具。逐个确认后写进回写区。

## Required Skills
- `mcode-smoke`: 理解 `run-smokes.mjs` 的发现规则与单套约定。
- `code-review`: 判断某条失败是「夹具过时」还是「真的坏了」，不要一律放宽断言。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/run-smokes.mjs`、`apps/desktop/scripts/smokes-for.sh`、T10 与 T11 的回写区（记录了这三条）。

## T10 / T11 独立确认的三处既有失败

### ① `genoffice-file-routing-smoke` 没有 `run.sh`，挡住 `--all`

T11 原话：
> `run-smokes.mjs --all` 目前在 `genoffice-file-routing-smoke/run.sh`（T30 交付，只有 `run.mjs`）处拒绝启动

`run-smokes.mjs` 的发现规则是目录名匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*-smoke$/`，然后**执行 `run.sh`**。只有 `run.mjs` 就没有入口。

**修法**：补一个 `run.sh`（参照 T87 刚补的那个）。

### ② `release-readiness-smoke/check-genoffice.cjs` 在 afterPack 夹具上失败

> 抛 `native CLI/dependency/PDFium integrity manifest is missing or invalid`（HEAD 复跑同样 exit 1）

**要先判断**：是夹具过时（afterPack 契约变了），还是检测逻辑真的漏了什么。

### ③ `genoffice-source-smoke` 在 fixture lock 上失败

> 抛 `GenOffice source lock differs from …`（HEAD 复跑同样 exit 1）

同样要先判断：是 fixture 该更新，还是 lock 真的不一致。

## 工作顺序

**第一步：先让 `--all` 能启动。**

补 `run.sh`（①）。这是纯机械的，先做。

**第二步：逐条诊断 ②③。**

每条都要回答：**这个失败是「测试过时」还是「产品有问题」？**

- 若测试过时 → 更新夹具，**说明产品哪里有意的变更导致它过时**
- 若产品有问题 → **停下报告**，另开卡修，本卡不修产品

**不许为了让套件变绿而放宽断言。** 这是本仓库的硬规矩。

**第三步：跑全量，给出真实基线。**

`bash apps/desktop/scripts/run-all-smokes.sh` 跑完，给出：
- 总套数
- 通过 / 失败
- **每一条失败的原因**（不许只给数字）

如果还有别的既有红，一并列出。

## 验收判据

1. `run-smokes.mjs --all` 能启动，不再卡在找不到 `run.sh`。
2. ②③ 各给出诊断结论（测试过时 / 产品有问题）。
3. 全量跑完，给出**真实基线**：总套数、通过数、失败数，以及每条失败的原因。
4. 若修了夹具，说明产品哪里变了导致它过时。
5. **不得**为了让套件变绿而放宽断言。
6. 双包 typecheck 通过。

## 边界

- **不改产品源码**。若诊断出产品问题，停下报告。
- **不改** `run-smokes.mjs` 的发现规则（那会影响所有套件）。
- **不改** T27/T28/T19 正在改的文件。

## 结果回写（2026-10-23）

（执行者在此追加：① 的修复、②③ 的诊断结论与依据、全量基线数字与失败清单、提交 SHA）
