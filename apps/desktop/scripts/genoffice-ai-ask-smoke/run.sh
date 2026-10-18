#!/usr/bin/env bash
# 【ARC-007 / GenOffice AI 交互】真 Electron：真实 docs 页 + 生产最小 preload 下，
# 「选中 → Ask AI chip → 输入气泡 → 加入队列 → 侧栏队列行」整条链路。
# 见 build.mjs / probe.ts 文件头。
#
# 与 document-view-vendor-page-smoke 一样：必须真 Electron + 真实构建产物；
# 产物未构建时如实跳过（exit 0），不假装验过。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/genoffice-ai-ask-smoke/build.mjs
