#!/usr/bin/env bash
# playground — 로컬 세계(e2e/harness.sh)를 띄우고 내러티브 데모를 돌린다.
# 외부 네트워크로는 아무것도 나가지 않는다 (anvil + 로컬 프로세스 전용).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../e2e" && pwd)/harness.sh"

TOKEN_ADDRESS="$TOKEN" npx tsx "$ROOT/playground/demo.ts" "$@"
