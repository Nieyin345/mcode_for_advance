#!/usr/bin/env bash
# 【ARC-007 P0】真 Electron：指定文件打开协议闭环（真 vendor docs 页 + 真宿主）。
# 见 build.mjs / probe.ts 文件头。产物缺失时如实跳过（exit 0）。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/document-view-open-smoke/build.mjs
