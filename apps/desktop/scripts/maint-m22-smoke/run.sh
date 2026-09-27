#!/usr/bin/env bash
# MAINT-2026-09 / M22: chat composer question card + picker keyboard/IME.
# Renders the real ChatPane (side-chat layout: pane session != activeSessionId)
# and the real File/Slash/Library pickers in an owned headless Chromium (temp
# profile, random port, killed on exit) against in-page mock RPC — no IPC, no
# user data, no network.
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/maint-m22-smoke/build.mjs
