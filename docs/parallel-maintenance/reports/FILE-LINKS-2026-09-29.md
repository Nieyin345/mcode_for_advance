# FILE-LINKS-2026-09-29：功能检修第 01 批

## 归属与边界

- 生产改动仅 `renderer/lib/path.ts`、`renderer/lib/fileLink.ts`。
- 新增 `file-links-smoke` 与 `file-links-ui-smoke`；维护原 `markdown-mode-smoke` 的过期测试依赖。
- 不改文献导入、工作流、主进程、Office 实现或其他对话的未提交文件。提交只包含本批拥有文件，不 push。
- 这不是全项目逐文件检修完成声明，也不是正式安装包、真实手机、网络共享服务器或真实模型验收。

## 已复现并修复

1. Windows `D:/..` 可以把盘符弹出，UNC 路径会丢掉双斜杠或共享目录根；现在根单独保留，`..` 只能折叠根内部分。
2. 根目录文件的 `dirname` 返回空字符串或驱动器相对路径 `D:`，导致 Markdown 同级图片定位错误；现在保留 `/`、`D:/` 或 `D:\`。
3. `file://server/share` 被解码为相对路径；`localhost-backup` 被错误截掉 `localhost`。现在按完整 authority 判断本机／远程共享，保留 UNC。
4. URI 的 `#fragment`、`?query` 被当作文件名；现在先剥离 URI 后缀再解码，保留 `%23`、`%3F` 表示的真实文件名字符。这里只处理 href，不改裸路径 token 的字面文件名。
5. 绝对路径的前端资格判断不处理 Windows 大小写、UNC、POSIX 根项目和 `..`。现在先正规化、按目录边界比较；真正的文件系统权限仍由主进程校验，不能把此处字符串检查当安全边界。
6. 多个目录有同名文件时 suffix `.find` 直接挑第一项，甚至把 `not-a.ts` 当作 `a.ts`。现在要求目录分隔边界，保留多项供选择，复用排名、去重及 12 项上限。

## 测试与复现

```sh
node apps/desktop/scripts/run-smokes.mjs file-links-smoke file-links-ui-smoke markdown-mode-smoke
node apps/desktop/scripts/file-links-smoke/run.cjs --baseline=<修复前提交>
node apps/desktop/scripts/run-smokes.mjs --all
node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
node packages/contracts/node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json
```

- 纯逻辑套件直接导入两份生产 helper，只替换 IPC 与 store；esbuild metafile 验证真正覆盖到改动文件。首次红灯 17 pass / 27 fail，修复后 44/44。`--baseline` 从 git 读取旧 helper，反向验证不会回滚共享工作区。
- 浏览器套件使用真实 React FileLink、真实 Base UI 菜单及真实解析函数，覆盖点击、同名选择、键盘、无匹配、Markdown anchor 拦截、桌面／移动分流：首次 10/10。移动平台标志和宿主操作是桩，不等于真手机测试。
- 浏览器沿用已有隔离驱动：独立 profile、随机端口、不调用真实 IPC／模型／用户库，只关闭自己的测试进程。新增套件会被全量 runner 自动发现。
- 原 Markdown 模式 smoke 的旧 Office regex／旧接口已落后于生产实现；现在通过 AST 获取真实契约分类函数与常量，覆盖当前 OnlyOffice 单入口及旧格式只读，32/32。没有为通过测试修改 Office 生产代码。
- 最终全量与双包检查应以本批隔离快照的 `checks.json` 为准；并行工作区和 HEAD 会继续变化，不把旧快照结果冒充当前全工作区状态。

## 后续检修队列（未在本批修复）

- FileLink 的 RPC 失败目前会退化成“无匹配”；需要区分失败与空结果，并提供重试。
- 异步解析期间切换 token／项目或卸载组件，需补延迟响应测试，确认不会打开过期文件。
- 协议相对链接 `//host/path` 与 UNC 的语义区分、页内锚点跳转、路径文本识别的边界行为。
- 更多前端入口、外链、错误态、移动桥映射与真实 IPC 链路；未将静态检查记为交互验收。
