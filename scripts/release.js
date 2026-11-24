#!/usr/bin/env node
'use strict';
/**
 * 一条命令发布新版本（说明见 docs/08-release-and-update.md）：
 *
 *   node scripts/release.js 0.7.1 --notes "这次改了什么"
 *   node scripts/release.js 0.7.1 --only android     只发 App
 *   node scripts/release.js 0.7.1 --only host        只发电脑被控端
 *   node scripts/release.js 0.7.1 --no-upload        只改版本号、打包，不上传
 *   node scripts/release.js 0.7.1 --only host --upload-only
 *                                                    不打包，把上一步 --no-upload 打好的被控端安装包传上去
 *                                                    （先打包、试运行、装到电脑上没问题了，再用它上传）
 *
 * 做的事：改版本号（App 的 versionName/versionCode、被控端 package.json）→ 跑测试 → 打包
 * （App 用固定的正式签名，被控端用 electron-builder 打安装程序）→ 上传到服务器的发布目录。
 * 手机 App 下次打开时提示更新；电脑被控端几小时内自己下载，没人看画面时重启换新。
 * 版本号改动不会自动提交，发布完记得提交。
 *
 * 安装包传到哪台服务器，写在本机的打包配置 deploy/prod/build.json 里（不入库，
 * 样例 deploy/build.example.json，说明见 scripts/build-config.js）。没有这个文件只能用 --no-upload 打包。
 * 安装包里不带服务器地址：App 和被控端装好后在登录页自己填，升级时沿用已经填过的地址。
 * 环境变量 RC_RELEASE_SSH、RC_RELEASE_DIR 可以临时换上传的服务器和目录。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GRADLE_FILE = path.join(ROOT, 'android', 'app', 'build.gradle.kts');
const HOST_PKG = path.join(ROOT, 'host', 'package.json');
const KEYSTORE_PROPS = path.join(ROOT, 'android', 'keystore.properties');
/** 服务器上每个渠道保留最近几个安装包 */
const KEEP = 3;

function fail(msg) {
  console.error('\n发布失败: ' + msg);
  process.exit(1);
}

/** 本机的打包配置：上传到哪里、被控端的应用标识、打包时的环境变量（比如 Electron 的下载镜像） */
const BUILD = (() => {
  try {
    return require('./build-config').load();
  } catch (err) {
    return fail(err.message);
  }
})();
const SSH = process.env.RC_RELEASE_SSH || BUILD.releaseSsh;
const REMOTE_DIR = process.env.RC_RELEASE_DIR || BUILD.releaseDir;

function parseArgs(argv) {
  const out = { version: '', notes: '', only: '', upload: true, uploadOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notes') out.notes = argv[++i] || '';
    else if (a === '--only') out.only = argv[++i] || '';
    else if (a === '--no-upload') out.upload = false;
    else if (a === '--upload-only') out.uploadOnly = true;
    else if (!a.startsWith('--') && !out.version) out.version = a;
    else fail(`不认识的参数 ${a}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(out.version)) fail('第一个参数是新版本号，形如 0.7.1');
  if (out.only && !['android', 'host'].includes(out.only)) fail('--only 只能是 android 或 host');
  if (out.uploadOnly && out.only !== 'host') fail('--upload-only 只支持被控端，要和 --only host 一起用');
  if (out.uploadOnly && !out.upload) fail('--upload-only 和 --no-upload 不能一起用');
  return out;
}

const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * 运行命令，失败就退出。Windows 上 .bat 和 npm/npx 必须经过 cmd.exe（[shell] 为真）；
 * ssh/scp 不经过 shell，参数原样交给它们，免得远程命令里的 | * ; 被 cmd.exe 解释
 */
function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const { shell = false, ...rest } = opts;
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: shell && process.platform === 'win32', ...rest });
  if (r.status !== 0) fail(`命令失败（退出码 ${r.status}）: ${cmd} ${args.join(' ')}`);
}

const sha = (file, algo, enc) => crypto.createHash(algo).update(fs.readFileSync(file)).digest(enc);

// ------------------------------------------------------------------ 版本号

function readAndroidVersion() {
  const s = fs.readFileSync(GRADLE_FILE, 'utf8');
  const code = Number((/versionCode = (\d+)/.exec(s) || [])[1]);
  const name = (/versionName = "([^"]+)"/.exec(s) || [])[1];
  if (!code || !name) fail('在 android/app/build.gradle.kts 里没找到 versionCode / versionName');
  return { code, name, text: s };
}

function bumpAndroid(version) {
  const v = readAndroidVersion();
  if (cmp(version, v.name) <= 0) fail(`App 现在是 ${v.name}，新版本号要更大`);
  const text = v.text.replace(/versionCode = \d+/, `versionCode = ${v.code + 1}`).replace(/versionName = "[^"]+"/, `versionName = "${version}"`);
  fs.writeFileSync(GRADLE_FILE, text);
  console.log(`App 版本 ${v.name}（${v.code}）→ ${version}（${v.code + 1}）`);
  return v.code + 1;
}

function bumpHost(version) {
  const pkg = JSON.parse(fs.readFileSync(HOST_PKG, 'utf8'));
  if (cmp(version, pkg.version) <= 0) fail(`被控端现在是 ${pkg.version}，新版本号要更大`);
  console.log(`被控端版本 ${pkg.version} → ${version}`);
  pkg.version = version;
  fs.writeFileSync(HOST_PKG, JSON.stringify(pkg, null, 2) + '\n');
}

// ------------------------------------------------------------------ 打包

function buildAndroid(version, versionCode, notes, stage) {
  if (!fs.existsSync(KEYSTORE_PROPS)) {
    fail('没有 android/keystore.properties（正式签名）。签名和手机上装的不一样就没法直接升级，见 docs/08');
  }
  const gradle = path.join(ROOT, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  run(gradle, ['testDebugUnitTest', 'assembleRelease', '--console=plain'], { cwd: path.join(ROOT, 'android'), shell: true });
  const built = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  const name = `RemoteClaude-${version}.apk`;
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.copyFileSync(built, path.join(ROOT, 'dist', name));
  fs.copyFileSync(built, path.join(stage, name));
  const pkg = (/applicationId = "([^"]+)"/.exec(fs.readFileSync(GRADLE_FILE, 'utf8')) || [])[1];
  if (!pkg) fail('在 android/app/build.gradle.kts 里没找到 applicationId');
  const manifest = {
    package: pkg,
    versionCode,
    versionName: version,
    file: name,
    size: fs.statSync(built).size,
    sha256: sha(built, 'sha256', 'hex'),
    notes,
    releasedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(stage, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`App 安装包 dist/${name}（${(manifest.size / 1048576).toFixed(1)} MB）`);
}

function buildHost(version, stage) {
  run('npm', ['test'], { cwd: path.join(ROOT, 'host'), shell: true });
  const out = path.join(ROOT, 'host', 'dist');
  fs.rmSync(out, { recursive: true, force: true });
  run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never', '--config', 'electron-builder.config.js'], {
    cwd: path.join(ROOT, 'host'),
    shell: true,
    env: { ...process.env, ...BUILD.env },
  });
  // 被控端靠 koffi 调 Windows 接口，它的原生模块在另一个按平台分的包里（@koromix/koffi-win32-x64）。
  // 2026-11-20 在 node_modules 是目录链接的副本里打包，打包工具没把它带上，装好的程序一启动就报
  // "Cannot find the native Koffi module"，电脑离线了几分钟。打完先查一遍，没有就不上传
  const native = path.join(out, 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node');
  if (!fs.existsSync(native)) {
    fail('打好的程序里没有 koffi 的原生模块（koffi.node），装上会启动不了。host/node_modules 要是真实目录，不能是目录链接');
  }
  const name = `RemoteClaude-Host-Setup-${version}.exe`;
  for (const f of [name, 'latest.yml']) {
    if (!fs.existsSync(path.join(out, f))) fail(`打包结果里没有 ${f}`);
    fs.copyFileSync(path.join(out, f), path.join(stage, f));
  }
  // 只发被控端（--only host）、又是刚取出来的干净副本时，还没有 dist 目录
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(out, name), path.join(ROOT, 'dist', name));
  console.log(`被控端安装程序 dist/${name}（${(fs.statSync(path.join(out, name)).size / 1048576).toFixed(1)} MB）`);
}

/** 不打包：把 host/dist 里已经打好的这个版本的安装程序和 latest.yml 放进待上传的目录 */
function stageBuiltHost(version, stage) {
  const out = path.join(ROOT, 'host', 'dist');
  const name = `RemoteClaude-Host-Setup-${version}.exe`;
  for (const f of [name, 'latest.yml']) {
    if (!fs.existsSync(path.join(out, f))) fail(`host/dist 里没有 ${f}，先用 --no-upload 打包`);
  }
  const yml = fs.readFileSync(path.join(out, 'latest.yml'), 'utf8');
  const built = (/^version:\s*(\S+)\s*$/m.exec(yml) || [])[1];
  if (built !== version) fail(`host/dist/latest.yml 是 ${built || '?'} 的，不是 ${version}`);
  const pkg = JSON.parse(fs.readFileSync(HOST_PKG, 'utf8'));
  if (pkg.version !== version) fail(`host/package.json 是 ${pkg.version}，和要上传的 ${version} 对不上`);
  for (const f of [name, 'latest.yml']) fs.copyFileSync(path.join(out, f), path.join(stage, f));
  console.log(`上传已经打好的被控端安装程序 ${name}（${(fs.statSync(path.join(out, name)).size / 1048576).toFixed(1)} MB）`);
}

// ------------------------------------------------------------------ 上传

function upload(stage, channels) {
  const tmp = `/tmp/rc-release-${Date.now()}`;
  run('ssh', [SSH, `mkdir -p ${tmp}`]);
  for (const ch of channels) {
    run('ssh', [SSH, `mkdir -p ${tmp}/${ch}`]);
    const files = fs.readdirSync(path.join(stage, ch)).map((f) => path.join(stage, ch, f));
    run('scp', ['-q', ...files, `${SSH}:${tmp}/${ch}/`]);
  }
  // 先放安装包、最后换版本说明，客户端不会看到指向还不存在的文件的说明；每个渠道只留最近 KEEP 个安装包
  const script = channels
    .map((ch) => {
      const manifest = ch === 'android' ? 'latest.json' : 'latest.yml';
      const ext = ch === 'android' ? 'apk' : 'exe';
      return [
        `sudo install -d -m 755 ${REMOTE_DIR}/${ch}`,
        `sudo find ${tmp}/${ch} -maxdepth 1 -type f ! -name ${manifest} -exec install -m 644 {} ${REMOTE_DIR}/${ch}/ \\;`,
        `sudo install -m 644 ${tmp}/${ch}/${manifest} ${REMOTE_DIR}/${ch}/${manifest}.new`,
        `sudo mv ${REMOTE_DIR}/${ch}/${manifest}.new ${REMOTE_DIR}/${ch}/${manifest}`,
        `ls -t ${REMOTE_DIR}/${ch}/*.${ext} | tail -n +${KEEP + 1} | xargs -r sudo rm -f`,
      ].join(' && ');
    })
    .concat([`rm -rf ${tmp}`, `ls -la ${REMOTE_DIR}/*`])
    .join(' && ');
  run('ssh', [SSH, `set -e; ${script}`]);
}

// ------------------------------------------------------------------ 主流程

/**
 * 要上传就得知道传到哪台服务器。安装包里不带服务器地址，已经装着的 App 和被控端升级后沿用自己存的地址
 * （旧版的被控端从登录状态里找回，见 host/serveraddress.js），所以不再要求打包配置里写 server
 */
function checkBuildConfig(upload) {
  const where = path.relative(ROOT, BUILD.file) || BUILD.file;
  if (BUILD.legacyServer) console.log(`提示: ${where} 里的 server 已不再使用（服务器地址不写进安装包），可以删掉`);
  if (!upload) return;
  if (!SSH) fail(`不知道传到哪台服务器：在 ${where} 里写 releaseSsh，或者设环境变量 RC_RELEASE_SSH；只想打包就加 --no-upload`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const channels = args.only ? [args.only] : ['android', 'host'];
  checkBuildConfig(args.upload);
  const stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rc-release-'));
  for (const ch of channels) fs.mkdirSync(path.join(stage, ch));

  if (args.uploadOnly) {
    stageBuiltHost(args.version, path.join(stage, 'host'));
    upload(stage, channels);
    fs.rmSync(stage, { recursive: true, force: true });
    console.log(`\n被控端 ${args.version} 的安装包已上传。`);
    return;
  }

  console.log(`发布 ${args.version}：${channels.join('、')}${args.upload ? `，上传到 ${SSH}:${REMOTE_DIR}` : '，不上传'}`);
  console.log(`被控端应用标识 ${BUILD.hostAppId}；安装包里不带服务器地址`);
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (st.stdout && st.stdout.trim()) console.log('提示: 工作区有未提交的改动，会一起打进安装包');

  if (channels.includes('android')) {
    const code = bumpAndroid(args.version);
    buildAndroid(args.version, code, args.notes, path.join(stage, 'android'));
  }
  if (channels.includes('host')) {
    bumpHost(args.version);
    buildHost(args.version, path.join(stage, 'host'));
  }
  if (args.upload) upload(stage, channels);
  fs.rmSync(stage, { recursive: true, force: true });

  console.log(`\n${args.version} 发布完成。`);
  if (args.upload) console.log('手机 App 下次打开会提示更新；电脑被控端几小时内自己下载，没人看画面时重启换新（托盘菜单或手机设置里可以马上升级）。');
  console.log(`记得提交版本号：git commit -am "发布 ${args.version}"`);
}

main();
