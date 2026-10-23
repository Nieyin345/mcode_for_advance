#!/usr/bin/env bash
# 【T100】任务中心面板 —— 真组件挂在极小 React 运行时上（与 document-view-renderer-smoke
# 同一份地基）。见 main.ts / build.mjs 文件头。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/t100-task-center-smoke/build.mjs
