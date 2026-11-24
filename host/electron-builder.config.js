'use strict';
/**
 * 被控端安装程序的打包配置（electron-builder）。用法：npm run dist，或者经 scripts/release.js。
 *
 * 应用标识不写在仓库里，从本机的打包配置读（deploy/prod/build.json，见 scripts/build-config.js 和 docs/08 第 1 节）。
 * 安装包里不带任何服务器地址：装好后在被控端窗口的登录页填，地址存在用户自己的 config.json 里。
 * 升级地址运行时由登录的服务器推出来（main.js 的 getFeed），这里的 publish 只用来让打包工具生成 latest.yml，
 * 写的是占位地址，不会被用到
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
    'lockstate.js',
    'sessioninfo.js',
    'files.js',
    'account.js',
    'serveraddress.js',
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
      url: 'https://rc.example.com/download/host',
    },
  ],
  electronLanguages: ['zh-CN', 'en-US'],
};
