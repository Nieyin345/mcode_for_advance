# 回归测试入口

需要已安装的仓库依赖、Node >= 22.13 和 pnpm；Node smoke runner 不安装依赖，并禁止 npx 回退联网。pnpm 11 本身可能在运行脚本前自动校验/链接依赖；若要严格只调用现有依赖，可直接运行 `node --test apps/desktop/scripts/run-smokes.test.mjs` 和 `node apps/desktop/scripts/run-smokes.mjs --critical`。Windows 使用 Git for Windows 的 Bash，避免误用 WSL。必要时将 `MCODE_TEST_BASH` 设为 Bash 可执行文件的完整路径。不会调用真实模型、真实用户库或启动 MCode 应用。代码宿主回归会启动独立、无窗口的 Electron 测试进程。

```sh
pnpm test                                      # runner 自测 + 8 套关键回归
pnpm test:all                                  # runner 自测 + 全部 *-smoke 目录
pnpm test:smoke db-persistence-smoke mobile-pairing-smoke
pnpm test:runner                               # 仅测试入口自身的错误传播等行为
pnpm test:smoke --all --list                    # 只列出，不执行
pnpm typecheck                                 # 双包类型检查
```

- 默认关键集合在 `apps/desktop/scripts/run-smokes.mjs` 中定义：DB 迁移、DB 持久化、移动端配对、运行存储、会话存储、调度、IPC wiring、路径保护。关键集合不是全量测试。
- 每套仍执行自己的 `run.sh`，不复制其 esbuild/stub 配置。旧 `run-all-smokes.sh` 转发同一实现。
- 全量动态发现目录；空集合、未知名称、缺少入口、启动错误、子进程非零状态、240 秒超时都令命令失败。普通失败继续收集其他套件结果；中断停止剩余套件。超时终止该测试的进程组（Windows 用 `taskkill /T`），不做系统范围的 Node/Electron 清理。
- 日志保留在 `apps/desktop/.tmp/smoke-runs/<唯一运行目录>/`，并发运行不覆盖彼此日志。Turbo 的 `test` 不缓存，不能把历史绿灯当成新执行结果。
- GitHub CI：PR 运行双包 typecheck 与关键回归；master push 另跑全量；手动触发可选全量。保留原有 `Typecheck` job 名以兼容 required-check 规则。CI 配置不是已在 GitHub 执行过的证明。
- `pnpm lint` 仍无包级实现，暂不能作为有效 lint 门禁。

## 本轮重点回归

`db-persistence-smoke` 使用真实 sql.js、独立临时数据库、真实文件，并对部分写入、rename、fsync 注入失败。覆盖异步保存、同步 flush、工作流屏障、close；验证旧文件和未保存内存数据保留、自动重试、失败通知去重/恢复/取消订阅、关闭后重开。调用端测试使用真实错误提示和迁移 IPC 模块加依赖桩；退出回调由 TypeScript AST 提取后执行，避免启动真实应用。

`mobile-pairing-smoke` 只绑定 `127.0.0.1:0`：A 的两个流在撤销后关闭、B 保持可用、订阅释放、重连拒绝，以及鉴权与订阅之间撤销的竞态。测试只清理自己创建的临时目录。

这些测试不等于原生对话框视觉验收、真实 LAN/手机端验收或断电测试。同目录原子替换与文件 fsync 降低写失败风险，但未承诺所有文件系统断电时目录项都持久。同步全库导出的性能和普通慢客户端的 SSE 背压仍需独立优化。

退出时先保存再销毁服务；若最后关闭时发生新的保存故障，仍会阻止退出、保留内存库，但部分服务可能已停止。恢复保存后应重启应用。数据根指针文件写失败目前仍由旧实现记录日志，该独立问题未在本轮改写。

## 工作流/自动化回归（2026-09-27）

- `workflow-ui-smoke` 使用真实 SettingsPage、工作流组件和 CSS。覆盖手动保存、框架说明、跨栏目草稿、保存期间继续编辑/换文档、错误恢复、多触发器试跑/删除、运行状态刷新、键盘操作、撤销重做、标签避让和 1024px 画布。API 全部在内存中；派生触发方式使用真实函数的 AST 边界。未使用的富文本编辑器为 fail-closed 替身，工作流组件本身没有替换。
- 该套件需要已安装 Chrome/Edge；自动查找常用路径，或通过 `MCODE_TEST_BROWSER` 指定可执行文件。没有浏览器时明确失败，不安装或跳过。始终创建独立 profile、随机调试端口，只关闭自己启动的进程。
- `code-electron-smoke` 在普通 Node 和仓库安装的 Electron 中调用同一个真实代码执行器，验证 Node 模式、JSON stdin、自然退出、非零退出、超时和取消。Electron 的 userData/sessionData/logs/crashDumps 全部指向独立测试目录，不创建 BrowserWindow。Linux 没有 DISPLAY 时需要 `xvfb-run`。
- 两套集成用例均有 `run.sh`，进入 `pnpm test:all` 的动态发现集合。PR CI 额外执行这两套和 automation/node-session 回归；CI 浏览器/虚拟显示安装仅作用于临时 CI 机器，不修改本地开发环境。
- 组件/宿主生成物分别位于 `.tmp/workflow-ui-*`、`.tmp/workflow-electron-*`；保留 JSON/截图诊断，浏览器只暴露 index.html、bundle.js、app.css 并禁止页面网络访问。它们不等于真实模型、真实手机或正式安装包验收。
