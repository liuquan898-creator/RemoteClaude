#!/usr/bin/env bash
# 命令行构建（Git Bash）。用法：scripts/build.sh [debug|release]
# 需要 DevEco Studio（默认 D:/Program Files/DevEco Studio，可用 DEVECO_HOME 改）。
set -euo pipefail
cd "$(dirname "$0")/.."
DEVECO_HOME="${DEVECO_HOME:-D:/Program Files/DevEco Studio}"
export DEVECO_SDK_HOME="$DEVECO_HOME/sdk"
MODE="${1:-debug}"
node scripts/gen-build-profile.js
"$DEVECO_HOME/tools/ohpm/bin/ohpm.bat" install --all >/dev/null
"$DEVECO_HOME/tools/node/node.exe" "$DEVECO_HOME/tools/hvigor/bin/hvigorw.js" --mode module -p product=default \
  -p buildMode="$MODE" assembleHap --no-daemon 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v "ArkTS:WARN\|^ *Function may throw\|has been deprecated\|^\s*$" || true
ls -la entry/build/default/outputs/default/*.hap 2>/dev/null
