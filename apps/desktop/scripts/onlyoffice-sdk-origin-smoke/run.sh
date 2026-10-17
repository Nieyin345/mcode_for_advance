#!/usr/bin/env bash
# onlyoffice-sdk-origin-smoke — 【MC-056】切换 Document Server 时 SDK 全局的归属。
# 从真实组件源码取出 loader 段（区段标记之间），构建期转成虚拟模块；套件在**装好
# 虚构 window/document 之后**才求值它。不起 Electron、不联网、不碰真实 DS。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/onlyoffice-sdk-origin-smoke/run.mjs
