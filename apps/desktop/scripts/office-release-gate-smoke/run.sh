#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Fixtures are synthetic and do not touch installed Mcode, NSIS or user docs.
# The live-readiness command is deliberately separate: it returns 2 while
# today's prebuilt installer is stale, unsigned or unaudited.
node --test scripts/office-release-audit/verify.test.cjs
