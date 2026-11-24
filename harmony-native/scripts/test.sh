#!/usr/bin/env bash
# 在电脑上跑纯逻辑的单元测试（entry/src/main/ets 下的 .ts 文件），要 Node 22.18+ / 24（直接跑 TypeScript）。
# 用法：scripts/test.sh
# 注意 node --test 不会展开目录参数（给 test/ 会当成一个文件去导入），所以用引号里的通配符，由 node 自己展开
set -euo pipefail
cd "$(dirname "$0")/.."
# 测试文件和被测的 .ts 没有 package.json 标明是 ES 模块，node 会自己识别出来，只是每个文件都警告一次，关掉这条警告
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./test/register.mjs --test "test/*.test.ts"
