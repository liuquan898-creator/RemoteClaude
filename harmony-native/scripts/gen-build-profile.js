// 用 build-profile.template.json5 生成 build-profile.json5（生成物不入库），填两样本机的东西：
// 1. 签名：signing.local.json5（不入库），DevEco 自动签名写出的 signingConfigs 数组里的那一项。没有时生成不带签名的配置，能编译、装不到真机。
// 2. 服务器地址：打包配置的 server（和安卓 App 同一份，见 docs/08 第 1 节）。环境变量 RC_BUILD_CONFIG 可以指到别的文件，
//    默认是仓库根目录的 deploy/prod/build.json。没有时登录页显示"服务器地址"框。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let out = fs.readFileSync(path.join(root, 'build-profile.template.json5'), 'utf8');

const signingFile = path.join(root, 'signing.local.json5');
if (fs.existsSync(signingFile)) {
  const signing = fs.readFileSync(signingFile, 'utf8').trim();
  out = out.replace('"signingConfigs": []', `"signingConfigs": [\n${signing}\n    ]`);
} else {
  console.warn('没有 signing.local.json5，生成的安装包没有签名，装不到真机');
  out = out.replace('"signingConfig": "default",', '');
}

const configFile = process.env.RC_BUILD_CONFIG || path.join(root, '..', 'deploy', 'prod', 'build.json');
let server = '';
if (fs.existsSync(configFile)) {
  server = String(JSON.parse(fs.readFileSync(configFile, 'utf8')).server || '').trim();
}
if (!server) console.warn(`打包配置 ${configFile} 里没有 server，登录页会显示服务器地址框`);
out = out.replace('"SERVER_ADDRESS": ""', `"SERVER_ADDRESS": ${JSON.stringify(server)}`);

fs.writeFileSync(path.join(root, 'build-profile.json5'), out);
console.log(`已生成 build-profile.json5（服务器：${server || '未配置'}）`);
