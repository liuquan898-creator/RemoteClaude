'use strict';
/**
 * 被控端安装程序的打包配置（electron-builder）。用法：npm run dist，或者经 scripts/release.js。
 *
 * 自己的服务器地址和应用标识不写在仓库里，从本机的打包配置读（deploy/prod/build.json，
 * 见 scripts/build-config.js 和 docs/08 第 1 节）：
 *   - server 写进装好的程序的 package.json（defaultServer），main.js 拿它当默认服务器；
 *     没配就不带默认服务器，装好后要在 %APPDATA%\remote-claude-host\config.json 里写
 *   - 升级地址运行时由登录的服务器推出来（main.js 的 getFeed），这里的 publish 只用来让打包工具生成 latest.yml
 */
const buildConfig = require('../scripts/build-config').load();

module.exports = {
  appId: buildConfig.hostAppId,
  productName: 'RemoteClaude Host',
  copyright: 'RemoteClaude',
  artifactName: 'RemoteClaude-Host-Setup-${version}.${ext}',
  directories: {
    output: 'dist',
  },
  extraMetadata: {
    defaultServer: buildConfig.serverWsUrl,
  },
  files: [
    'package.json',
    'main.js',
    'preload.js',
    'renderer.html',
    'renderer.css',
    'renderer.js',
    'sdp.js',
    'hostcmd.js',
    'winlist.js',
    'winorder.js',
    'unlockkey.js',
    'unlockpipe.js',
    'unlockpipe-native.js',
    'files.js',
    'account.js',
    'win32.js',
    'updater.js',
    'logfile.js',
    'clipwatch.js',
    'claudecheck.js',
    'dialogwatch.js',
    'tiler/**',
    'sessions/**',
    'approvals/**',
    'assets/**',
  ],
  asarUnpack: ['sessions/*.ps1', 'node_modules/koffi/**'],
  win: {
    target: ['nsis'],
    icon: 'assets/icon.png',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    shortcutName: 'RemoteClaude 被控端',
    uninstallDisplayName: 'RemoteClaude 被控端',
    deleteAppDataOnUninstall: false,
  },
  publish: [
    {
      provider: 'generic',
      url: `${buildConfig.serverHttpBase || 'https://rc.example.com'}/download/host`,
    },
  ],
  electronLanguages: ['zh-CN', 'en-US'],
};
