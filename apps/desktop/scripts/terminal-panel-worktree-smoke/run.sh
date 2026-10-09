#!/usr/bin/env bash
# terminal-panel-worktree-smoke — TerminalPanel 工作树终端桶被误清(见 main.ts 文件头)。
# 打包与替身在 build.mjs 里(需要 esbuild 插件换掉 xterm / 图标 / API)。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/terminal-panel-worktree-smoke/build.mjs
