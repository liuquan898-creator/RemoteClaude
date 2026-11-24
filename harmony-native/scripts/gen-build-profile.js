// 用 build-profile.template.json5 生成 build-profile.json5（生成物不入库），填两样本机的东西：
// 1. 签名：signing.local.json5（不入库），DevEco 自动签名写出的 signingConfigs 数组里的那一项。
//    没有它就停下（装不到真机）；只想编译不装时设环境变量 RC_ALLOW_UNSIGNED=1。
// 2. 服务器地址：打包配置的 server（和安卓 App 同一份，见 docs/08 第 1 节）。环境变量 RC_BUILD_CONFIG 可以指到别的文件，
//    默认是仓库根目录的 deploy/prod/build.json（在 git worktree 里找主目录的那份）。没有时登录页显示"服务器地址"框。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

function defaultConfig() {
  const own = path.join(root, '..', 'deploy', 'prod', 'build.json');
  if (fs.existsSync(own)) return own;
  // git worktree 里没有不入库的 deploy/prod，去主目录找
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    const main = path.join(path.dirname(common), 'deploy', 'prod', 'build.json');
    if (fs.existsSync(main)) return main;
  } catch {
    // 不在 git 仓库里
  }
  return own;
}

const configFile = process.env.RC_BUILD_CONFIG || defaultConfig();
let server = '';
if (fs.existsSync(configFile)) {
  server = String(JSON.parse(fs.readFileSync(configFile, 'utf8')).server || '').trim();
}
if (!server) console.warn(`打包配置 ${configFile} 里没有 server，登录页会显示服务器地址框`);
out = out.replace('"SERVER_ADDRESS": ""', () => `"SERVER_ADDRESS": ${JSON.stringify(server)}`);

fs.writeFileSync(target, out);
console.log(`已生成 build-profile.json5（服务器：${server || '未配置'}）`);
