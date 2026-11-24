// 用 build-profile.template.json5 生成 build-profile.json5（生成物不入库），填上本机签名：
// signing.local.json5（不入库），DevEco 自动签名写出的 signingConfigs 数组里的那一项。
// 没有它就停下（装不到真机）；只想编译不装时设环境变量 RC_ALLOW_UNSIGNED=1。
// App 里不带服务器地址（docs/08 第 1 节），这里不填。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'build-profile.json5');
const signingFile = path.join(root, 'signing.local.json5');
let out = fs.readFileSync(path.join(root, 'build-profile.template.json5'), 'utf8');

if (fs.existsSync(signingFile)) {
  const signing = fs.readFileSync(signingFile, 'utf8').trim();
  out = out.replace('"signingConfigs": []', () => `"signingConfigs": [\n${signing}\n    ]`);
} else {
  // DevEco 刚自动签过名、还没取出来时，build-profile.json5 里有签名：不要覆盖掉它
  if (fs.existsSync(target) && /"signingConfigs"\s*:\s*\[\s*\{/.test(fs.readFileSync(target, 'utf8'))) {
    console.error('build-profile.json5 里有 DevEco 刚签的名，先运行 node scripts/take-signing.js 把它存进 signing.local.json5');
    process.exit(1);
  }
  if (process.env.RC_ALLOW_UNSIGNED !== '1') {
    console.error('没有 signing.local.json5：先在 DevEco 里自动签名，再运行 node scripts/take-signing.js（见 docs/10 第 5 节）。只编译不装可设 RC_ALLOW_UNSIGNED=1');
    process.exit(1);
  }
  console.warn('没有签名，生成的安装包装不到真机');
  out = out.replace('"signingConfig": "default",', '');
}

fs.writeFileSync(target, out);
console.log('已生成 build-profile.json5');
