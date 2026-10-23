#!/usr/bin/env bash
# extension-danger-delegation-smoke —— 【T19】扩展经 core.app.call 调 danger 档 RPC
# 必须逐次审批；blocked 直接拒；不存在「始终允许」；无审批通道 fail-closed。
# 内含两条变异（撤掉 danger 闸门）作为"断言真的立在那道闸上"的证据。
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/extension-danger-delegation-smoke/build.mjs
