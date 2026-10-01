# 第三轮 · B 编排(orchestration / modules)

范围:`apps/desktop/src/main/{orchestration,modules}`。
编号用 `BO*`:`B1`–`B16` 已被 `排查记录.md` 第一、二轮占用。
验证:增量 tsc 通过;lint-changed 0 问题;lint-extra(额外 bug 规则)在本线目录 0 问题;
相关 smoke 10 个全过(code-runner、code-electron、maint-m08、scheduler、automation、node-session、
module-workflow、memory-injection、emit-path、maint-m28)。

## 修复的问题

| 编号 | 位置 | 问题 | 修复 |
|---|---|---|---|
| BO1 | `orchestration/runner.ts` `runInNodeSession` | 节点会话的结果表(`text` / `endReason` / `failure` / `activity`)按会话 id 存,同一节点**第二次运行**(循环回边、重跑)复用同一会话时没有清空:第二轮的文本拼在第一轮后面交给下游,上一轮的失败原因还会把这一轮误判为失败 | 每轮登记 `nodeSessionOf` 后先清掉这四张表里该会话的旧值 |
| BO2 | `orchestration/codeRunner.ts` | Windows 上代码节点写临时脚本是无 BOM 的 UTF-8:PowerShell 5.1 按 ANSI(GBK)读,脚本里的中文字符串变乱码甚至语法错;`.cmd` 是 LF 换行 + 当前代码页,中文同样乱码,`goto`/标签在 LF 下也会出错 | 新增 `scriptBytes()`:PowerShell 加 UTF-8 BOM;cmd 转 CRLF,含非 ASCII 时开头加 `@chcp 65001 >nul` |

## 已排查(无需再查)

- `orchestration/runner.ts` 全文(节点调度、回边计数、取消、产物收集)。
- `orchestration/commandRunner.ts`(超时杀整棵树、输出尾窗口、编码走 `lib/outBuf`)。
- `orchestration/scheduler.ts` 700–1200 行(触发、并发闸、错过补跑)。
- `orchestration/automationRunner.ts` 280–520、1380–1700 行。
- `orchestration/conversationQueue.ts`、`moduleCapabilityExecutor.ts` 60–140 行、`runStore.ts` 头部与类型。
- `modules/ModuleHost.ts`。

## 已知限制(不改)

- PowerShell 7(pwsh)本身就按 UTF-8 读,加 BOM 对它无害;非中文 Windows 上 cmd 的 `chcp 65001` 同样有效。

## 打包后请验证

1. 带回边的工作流,让某个节点跑两轮:第二轮的输出不应包含第一轮的文字,第一轮失败、第二轮成功时应显示成功。
2. Windows 上 PowerShell 代码节点 `Write-Output "中文测试"`、cmd 代码节点 `echo 中文测试`:输出正常,无乱码。
