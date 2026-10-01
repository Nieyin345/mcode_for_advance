# 第三轮 · C 接口(ipc / mcp / preload / contracts)

范围:`apps/desktop/src/main/{ipc,mcp}`、`src/preload`、`packages/contracts/src`。
验证:增量 tsc 通过;lint-changed 0 新增问题(`index.ts:145` 的 floating-promise 是原有的 `app.whenReady().then(...)`,不是本次改动);
相关 smoke 全过:maint-m07、maint-p1-path、mobile-pairing、release-readiness、skill-copy、skills-management、
maint-m14、mcp-endpoint、maint-m08、terminal、automation、db-persistence、extension-bridge、library-import、notifications-ipc。
另用 esbuild 单独跑了 `ConsoleTextDecoder` 的穷举切分测试(UTF-8 / GBK 文本在任意两处、三处切块,结果与整段解码一致)。

## 修复的问题

| 编号 | 位置 | 问题 | 修复 |
|---|---|---|---|
| C1 | `ipc/files.ts` `readFileGuarded`(编辑器 `file:readFile`、手机端 RPC 共用) | 一律按 UTF-8 读:GBK / UTF-16 文件显示成乱码;编辑器一保存,替换字符把原文**永久写坏** | 改用同文件里搜索用的 `decodeTextBuffer`(BOM → UTF-16 → 严格 UTF-8 → GBK);UTF-8 BOM 仍原样保留在内容里,保存时写回 |
| C2 | `ipc/files.ts` `file:delete` | 项目根本身也算「在项目里」,文件树上对根节点点删除会把**整个项目**扔进回收站 | 目标就是项目根(或会话 worktree 根)时拒绝。重命名本来就因新路径越界被拒,无需改 |
| C3 | `mcp/agentTools.ts`(`agent_bash`、内部 `runCaptured`)、`mcp/agentProcessSessions.ts`(后台进程会话) | 子进程输出用 `StringDecoder("utf8")` 解:中文 Windows 上 `shell: true` 走 cmd.exe,`dir`、`ping`、「不是内部或外部命令」等都是 GBK,AI 看到的是一串 U+FFFD(第二轮 B12 只修了进程列表) | `lib/outBuf.ts` 新增流式 `ConsoleTextDecoder`:按换行切,整行走 `decodeOutput`(严格 UTF-8 优先,否则 GBK);没换行的尾巴合法 UTF-8 直接吐、半个 UTF-8 字符留到下一块、否则按 GBK 吐完整双字节。合法 UTF-8 的结果与原来逐字节一致。进程结束时 `end()` 吐出余下字节 |
| C3′ | `lib/outBuf.ts` `decodeUtf8Strict` | 整段恰好是「半个 UTF-8 字符」的形状(如 GBK「或」= `bb f2`)时,削尾后剩空串被当成解码成功,两个字节被整个吞掉 | 削完为空时返回 null,交给 GBK 判断 |
| C4 | `mcp/agentProcessSessions.ts`、`mcp/agentSessionCleanup.ts`、`index.ts` | AI 用 `agent_process_start` 起的后台进程(`npm run dev` 之类,最长 60 分钟)在**退出 Mcode 后仍在跑**:类 Unix 上是独立进程组,Windows 上子进程不随父进程退出 —— 端口一直被占 | 新增 `disposeAll()` 与 `registerAgentShutdownHook` / `disposeAllAgentResources`,`before-quit` 收尾时调用(杀整棵树)。`db-persistence-smoke/callers.ts` 的退出夹具同步加上这个依赖并断言 |
| C5 | `ipc/skills.ts` GitHub 导入 | 仓库根就是一个技能时,把克隆下来的 `.git` 整个拷进技能库(体积大;Windows 上 pack 文件只读,之后删除技能可能失败) | `fs.cp` 加 filter 跳过 `.git` |

## 已排查(无需再查)

- `ipc/shell.ts`;`ipc/files.ts` 其余部分(listDir、搜索、grep、mkdir、copy、剪贴板、重命名);`ipc/skills.ts` 690–1010 行(GitHub 导入、保存、删除、复制到项目,都有 pathWithin 守卫)。
- `ipc/git.ts`:所有带用户路径的命令都用 `--` 分隔;merge / pull 冲突处理;deleteBranch 事后核验。
- `ipc/library.ts`:写回高亮(先存底稿、同目录原子替换)、删除流程;`ipc/mcp.ts` needs-auth 缓存(尽力而为);`ipc/orchestration.ts` 导出。
- `mcp/mcodeServer.ts` 写节点类型(id 有正则约束,临时文件改名);`mcp/agentRemoteSsh.ts` 重连 / 关闭竞态;`mcp/agentProcessSessions.ts` 全文;`mcp/agentSessionCleanup.ts`。
- 全仓 lint-extra 的 81 条均判为无害(多为有意的空 catch / 刻意的 `void` promise)。

## 已知限制(不改)

- `file:writeFile` 不是原子写:Windows 上 rename 覆盖有 EPERM、ACL / 只读属性丢失的风险,保持直接写。
- C1 读 GBK 文件后保存会写成 UTF-8(没有 GBK 编码器),文件编码会变,但内容不再损坏。
- `agent_bash` 的 SSH 远程连接不校验主机密钥(没有 known_hosts 界面),等同于首次连接总是信任。
- `git:discard` 对已暂存的改动只恢复到暂存区版本(`git checkout -- file`),不会撤掉暂存。
- 非中文 Windows(Shift_JIS 等)的命令输出仍可能乱码:只做了 UTF-8 / GBK 两种判断。

## 打包后请验证

1. 在文件树里打开一个 GBK 编码的 `.txt`(例如记事本另存为 ANSI)和一个 UTF-16 文件:中文正常显示;改一个字保存后再打开,内容完好。
2. 文件树对项目根节点点「删除」:应无反应/失败提示,项目不被删除;删普通文件仍正常。
3. 让 AI 执行 `dir`、`ping 127.0.0.1 -n 1`、一个不存在的命令:输出中文正常,无乱码。
4. 让 AI 用后台进程起一个 `npm run dev`(或 `python -m http.server`),然后退出 Mcode:任务管理器里对应的 node/python 进程应已结束,端口可再次使用。
5. 从 GitHub 导入一个「仓库根就是技能」的仓库:技能目录里没有 `.git`,之后能正常删除。
