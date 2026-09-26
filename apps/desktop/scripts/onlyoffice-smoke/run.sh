#!/usr/bin/env bash
# Real bridge + loopback fake Document Server + private files. No Office install/model.
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/onlyoffice-smoke/run.mjs
