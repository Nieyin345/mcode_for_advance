#!/usr/bin/env bash
# O3 —— `pnpm test:smoke o3-packaged-smoke` 的入口。
#
# `scripts/run-smokes.mjs` 只发现 `<name>-smoke/run.sh`，而本卡的实现目录按任务卡
# 命名是 `o3-packaged-u1/`（与 `t7-genoffice-u1` / `t29-document-view-close-u1`
# 同一套命名）。所以这里只做转调，**不复制任何逻辑**：
#
#   apps/desktop/scripts/o3-packaged-u1/run.sh   ← 唯一实现
#
# 前提：`release/win-unpacked` 已存在。本套件**不打包**（卡第四节）。
set -euo pipefail
exec bash "$(dirname "$0")/../o3-packaged-u1/run.sh" "$@"
