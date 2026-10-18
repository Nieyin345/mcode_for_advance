#!/usr/bin/env bash
# document-view-renderer-smoke — 【ARC-007】documentView.* 接到 GenOffice 文档面板的
# 渲染端回归网（真组件挂极小 React 运行时 + FileEditor 路由 + webApi 显式 unsupported）。
# 见 main.ts / build.mjs 文件头。
#
# ## 为什么走 build.mjs 而不是直接 esbuild 一行
#
# 这一套要 replace 的模块很多（react / react-dom / 图标 / monaco / base-ui / api /
# useRpc / sessionStore / i18n / 一堆重子件），逐个 `--alias:` 既难读也容易漏；更要紧
# 的是 react 必须换成本套目录下**同一份** fakeReact，main.ts 的 `__mount` 才看得见
# 组件写的状态 —— build.mjs 里集中做。
#
# ## 数据根
#
# 本套不碰 sql.js / 主进程；不设 MCODE_SMOKE_DATA_ROOT（也没有主进程代码被加载）。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/document-view-renderer-smoke/build.mjs
