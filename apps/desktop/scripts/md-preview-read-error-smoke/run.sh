#!/usr/bin/env bash
# md-preview-read-error-smoke — 【ARC-007】预览读失败必须是错误态，不画成空文档。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/md-preview-read-error-smoke/build.mjs
