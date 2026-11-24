// DevEco Studio 自动签名会把签名写进 build-profile.json5（生成物、不入库）。
// 签完运行一次：node scripts/take-signing.js，把 signingConfigs 的第一项存进 signing.local.json5（不入库），
// 之后 scripts/build.sh 生成 build-profile.json5 时就会带上它。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const text = fs.readFileSync(path.join(root, 'build-profile.json5'), 'utf8');
const start = text.indexOf('"signingConfigs"');
if (start < 0) throw new Error('build-profile.json5 里没有 signingConfigs，先在 DevEco 里签名');
const open = text.indexOf('[', start);
let depth = 0;
let i = open;
for (; i < text.length; i++) {
  if (text[i] === '[') depth++;
  if (text[i] === ']' && --depth === 0) break;
}
const inner = text.slice(open + 1, i).trim();
if (!inner.startsWith('{')) throw new Error('signingConfigs 是空的，先在 DevEco 里签名');
// 只取第一项
let d = 0;
let j = 0;
for (; j < inner.length; j++) {
  if (inner[j] === '{') d++;
  if (inner[j] === '}' && --d === 0) break;
}
const first = inner.slice(0, j + 1);
fs.writeFileSync(path.join(root, 'signing.local.json5'), `// 本机签名，不入库。由 scripts/take-signing.js 从 DevEco 自动签名的结果里取出\n${first}\n`);
console.log('已更新 signing.local.json5');
