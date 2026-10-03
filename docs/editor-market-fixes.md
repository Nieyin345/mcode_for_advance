# 桌面文档 CSP 与市场克隆修复

## 边界

本轮只修复桌面 PDF / 项目 DOCX 的已定位 CSP 问题，以及技能市场与插件共用的 Git 克隆健壮性。没有新增第三方 MCP/插件转发，没有改变内部 Agent、工作流或公网 MCP 的项目技能边界。

- 生产 CSP 只设置在 Mcode 自己的 renderer 入口文档，不覆盖 Document Server iframe 的响应策略。
- PDF 图片与读取允许 `blob:`；主页面仍禁止内联脚本，不全局放开 CDN。
- 原有标准印章采用本地固定版本 `@embedpdf/default-stamps@0.0.1` 英文资源，而不是禁用印章。来源、校验和与许可说明在 `src/renderer/public/pdf-stamps/`。

## 克隆行为

- 沿用已有 `spawnRun` 进程管理，Git 使用 argv，不通过 shell 拼接。
- `--depth 1 --progress`，非交互式凭据提示；不自动发现、选择或配置 SSH 密钥。
- 每次 clone 最长 15 分钟，连续 3 分钟没有 stdout/stderr 输出则停止；这不是无限等待。保留原有本地代理连接失败匹配条件下的一次直连重试，因此重试不是同一个 clone 的剩余预算。
- 显示真实 Git 进度、耗时与单次时限。进度仅发送给发起请求的窗口，带请求 ID；不广播到其他窗口。手机 webApi 保留无操作订阅，不承诺移动端市场流式进度。
- 错误区分无输出超时、总时限、Git 不存在、启动错误和退出错误；保留有长度限制的错误尾部，并去除 HTTP(S) URL 的凭据、查询参数及片段。
- Git 的 CR-only 输出走可选有界原始捕获；其他现有逐行 runner 调用不改变语义。
- 技能/插件市场在 staging 校验后才替换；网络失败、无技能或无效插件清单不会先删掉原目录。替换失败尝试恢复旧目录。

这里的“3 分钟无输出”不是网络吞吐探针：服务器长期静默准备数据也可能触发该限制，错误会明确说明。单个阶段的 Git 百分比也不是整个添加操作的总完成百分比。

## 验证方式

在 `apps/desktop` 下运行：

```sh
node scripts/run-smokes.mjs editor-market-smoke market-smoke plugins-smoke plugins-ipc-smoke onlyoffice-smoke pdf-annotation-smoke command-runner-smoke code-runner-smoke ipc-wiring-smoke
```

新套件覆盖 CSP 作用域、Blob 策略、超时/代理/错误、目录替换回滚、真实子进程 CR 输出、有限缓冲、临时本地 Git 仓库克隆，以及 Electron 中的 Blob 图片/读取、外部 iframe 内联脚本、主页面内联脚本禁用、React 进度关联与解除订阅。

Electron 使用独立临时 userData；Git 使用临时仓库与隔离配置；不调用真实模型、不打开用户文档、不初始化用户数据库。既有 Office/PDF 测试继续用于相应接口/持久化的夹具回归。

这些测试 **不是已安装生产版本中真实 PDF/DOCX 的打开→编辑→保存→重新打开验收**。本轮本地源码交付不更新安装版；真实 Document Server 回调保存仍需在获准使用的测试文档上另外验收。
