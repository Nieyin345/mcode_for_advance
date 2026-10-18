#!/usr/bin/env bash
# 【ARC-007 / GenOffice slides 编辑】真 Electron + 真 vendor slides 主进程：
# 加页 → 加文本框 → 改文字 → 保存（真 pptx zip 往返）。见 build.mjs / probe.ts 文件头。
#
# 与 document-view-vendor-page-smoke 不同：那套验「最小 preload 能挂载」；本套验
# **编辑**，因此 preload 用 vendor 自己的全量桥、主进程调真 `registerSlidesIpc()`。
# 产物缺失时如实跳过（exit 0）。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/slides-edit-smoke/build.mjs
