'use strict';
/**
 * 被控端自动升级（说明见 docs/08-release-and-update.md）。
 *
 * 只在装好的正式版里工作（从源码运行的开发版不升级）。用 electron-updater 从自己的服务器
 * <服务器>/download/host/latest.yml 查新版本，带被控端的登录令牌（安装包要登录才能下载）。
 * 有新版本就在后台下载；下好后等没人在看画面时自动重启换新，也可以从托盘或手机马上升级。
 */

/** 启动后多久第一次检查，之后每隔多久检查一次 */
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * @param {object} opts
 * @param {import('electron').App} opts.app
 * @param {(msg: string) => void} opts.log
 * @param {() => ({ url: string, token: string } | null)} opts.getFeed 下载地址和令牌；没登录时返回 null
 * @param {() => boolean} opts.isIdle 现在没人在看画面，可以重启
 */
function createUpdater({ app, log, getFeed, isIdle }) {
  const listeners = new Set();
  /** status：dev 开发版不升级 / idle 还没查 / checking / latest 已是最新 / downloading / ready 已下好 / installing / error */
  const state = { version: app.getVersion(), status: app.isPackaged ? 'idle' : 'dev', newVersion: '', percent: 0, error: '' };

  function set(patch) {
    Object.assign(state, patch);
    for (const cb of listeners) {
      try {
        cb({ ...state });
      } catch {}
    }
  }

  const api = {
    get state() {
      return { ...state };
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    check: () => {},
    install: () => false,
    maybeInstall: () => {},
  };
  if (!app.isPackaged) return api;

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // 服务器上不放差分文件（.blockmap），直接下完整安装包
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = { info: () => {}, warn: (m) => log(String(m)), error: (m) => log(String(m)), debug: () => {} };

  let installWhenReady = false;

  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'downloading' && state.status !== 'ready') set({ status: 'checking', error: '' });
  });
  autoUpdater.on('update-not-available', () => set({ status: 'latest', newVersion: '', percent: 0 }));
  autoUpdater.on('update-available', (info) => {
    log(`发现新版本 ${info.version}，开始下载`);
    set({ status: 'downloading', newVersion: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.floor(p.percent || 0);
    if (percent !== state.percent) set({ percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log(`新版本 ${info.version} 已下载`);
    set({ status: 'ready', newVersion: info.version, percent: 100 });
    if (installWhenReady) api.install();
    else api.maybeInstall();
  });
  autoUpdater.on('error', (err) => {
    log('检查或下载更新失败: ' + (err && err.message ? err.message : err));
    set({ status: 'error', error: String((err && err.message) || err).slice(0, 200) });
  });

  api.check = () => {
    if (state.status === 'downloading' || state.status === 'ready' || state.status === 'installing') return;
    const feed = getFeed();
    if (!feed) return;
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.url });
    autoUpdater.requestHeaders = { Authorization: `Bearer ${feed.token}` };
    autoUpdater.checkForUpdates().catch(() => {}); // 出错会走 error 事件
  };

  /** 马上升级：已下好就重启换新；还在下就等下好再换；还没查过就先查。返回是否已经开始换新 */
  api.install = () => {
    if (state.status === 'ready') {
      log(`重启升级到 ${state.newVersion}`);
      set({ status: 'installing' });
      // 静默安装，装完自动重新打开被控端
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return true;
    }
    installWhenReady = true;
    if (state.status !== 'downloading') api.check();
    return false;
  };

  /** 有人在看画面时不打断，等没人看了再换新 */
  api.maybeInstall = () => {
    if (state.status === 'ready' && isIdle()) api.install();
  };

  setTimeout(api.check, FIRST_CHECK_MS);
  setInterval(api.check, CHECK_EVERY_MS);
  return api;
}

module.exports = { createUpdater };
