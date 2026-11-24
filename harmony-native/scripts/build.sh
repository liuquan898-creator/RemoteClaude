#!/usr/bin/env bash
# 命令行构建（Git Bash）。用法：scripts/build.sh [debug|release]
# 需要 DevEco Studio（默认 D:/Program Files/DevEco Studio，可用 DEVECO_HOME 改）。装到手机用 scripts/install.ps1。
set -euo pipefail
cd "$(dirname "$0")/.."
DEVECO_HOME="${DEVECO_HOME:-D:/Program Files/DevEco Studio}"
export DEVECO_SDK_HOME="$DEVECO_HOME/sdk"
MODE="${1:-debug}"
OUT=entry/build/default/outputs/default
node scripts/gen-build-profile.js
"$DEVECO_HOME/tools/ohpm/bin/ohpm.bat" install --all >/dev/null
# 先删掉上次的安装包：构建失败时不会把旧包当成这次的
mkdir -p "$OUT"
rm -f "$OUT"/*.hap
set +e
"$DEVECO_HOME/tools/node/node.exe" "$DEVECO_HOME/tools/hvigor/bin/hvigorw.js" --mode module -p product=default \
  -p buildMode="$MODE" assembleHap --no-daemon > "$OUT.log" 2>&1
status=$?
set -e
sed 's/\x1b\[[0-9;]*m//g' "$OUT.log" | grep -E "ERROR|Error Message|At File|BUILD" || true
if [ $status -ne 0 ]; then
  echo "构建失败（$MODE），完整日志：$OUT.log" >&2
  exit $status
fi
ls -la "$OUT"/*.hap
