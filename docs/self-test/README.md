# MCode 自测任务

这个目录存放 **「让 MCode agent 测试 MCode 自己」** 的任务书与测试报告。

工作方式：把 [`TASK-self-test.md`](./TASK-self-test.md) 的内容整段发给 MCode（工作区打开本仓库根目录），
它按文档执行、把报告写到 `docs/self-test/reports/<日期>-run.md`。

## 目录约定

```text
docs/self-test/
├── README.md                       ← 本文件：约定与索引
├── TASK-self-test.md               ← 任务书（发给 agent 的那份）
└── reports/
    └── YYYY-MM-DD-run.md           ← agent 产出：一次自测的完整报告
```

## 报告命名与约定位置

- **报告必须写到**：`docs/self-test/reports/<YYYY-MM-DD>-run.md`
- 同一天跑第二次：`<YYYY-MM-DD>-run-2.md`，依此类推（**不覆盖**上一份）
- 报告写完后，在下方「已完成的测试」表格里补一行
- 报告是**给人看的**：结论先行，失败项必须带原始错误文本，不许只写"失败"

## 已完成的测试

| 日期 | 报告 | 结论 | 备注 |
|---|---|---|---|
| 2026-09-18 | [`reports/2026-09-18-run.md`](reports/2026-09-18-run.md) | 有失败 | typecheck 全绿；smoke 32/33（`upstream-headers-smoke` 回归：`buildCustomEnv` 的 `x-mcode-session` 注入越界到 anthropic 协议）；环节 3/4/5 全 PASS |

## 为什么要有这个

Phase 0 Gate 要求「真实 app 跑通一条完整路径」。在人工试跑之前，先用自动化回归
（33 个 smoke 套件 + typecheck）把**客观事实**钉住，能快速区分「代码坏了」和
「环境/凭据问题」，让人工试跑专注在 UI 与真实交互上。

任务书共 6 个环节：①双包 typecheck ②33 套件全量 smoke ③本轮新能力代码级证据
④建工作流链路静态核查 ⑤自测能力（元测试）⑥**真实建一个 `[SELFTEST]` 工作流并跑通**
（不含模型节点，不消耗额度）。

**测试产物**：环节 6 会真的往工作流列表里写数据，名称固定以 `[SELFTEST]` 开头，
事后可直接删除。

背景见 [`../../MCode-Architecture-Plan-v2.md`](../../MCode-Architecture-Plan-v2.md) 的 Phase 0，
以及 [`../../MCode-Development-Roadmap.md`](../../MCode-Development-Roadmap.md) §14。
