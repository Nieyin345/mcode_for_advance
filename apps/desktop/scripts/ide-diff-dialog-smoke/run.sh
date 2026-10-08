#!/usr/bin/env bash
# ide-diff-dialog-smoke — GitDiffDialog 左栏状态回包竞态(见 main.ts 文件头)。
# 打包与替身在 build.mjs 里(需要 esbuild 插件换掉重量级子件)。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/ide-diff-dialog-smoke/build.mjs
