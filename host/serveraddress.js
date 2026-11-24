'use strict';
/**
 * 被控端连哪个信令服务器：整理用户填的地址、读写配置文件里的 server、
 * 升级后从旧的登录状态里找回地址。不依赖 Electron，主进程和测试都用它。
 *
 * 安装包里不带任何服务器地址（docs/08 第 1 节），地址只存在用户自己的 config.json 里：
 *   - 在被控端窗口的登录页填，或者登录后从窗口、托盘菜单"更换服务器…"改，改完写回 config.json
 *   - 0.9.25 以前的安装包带着打包时写进去的默认服务器，用户的 config.json 里一般没有 server。
 *     升级后第一次启动时，从 account.json（登录状态，里面记着登录的是哪个服务器）找回地址写进 config.json，
 *     不用重新填、也不用重新登录
 */
const fs = require('fs');
const path = require('path');

/** 地址最长多少个字符，再长就是填错了 */
const MAX_LENGTH = 512;

/**
 * 把填的服务器地址整理成信令 WebSocket 地址（和安卓端的 ServerAddress.kt 规则一样）：
 *   rc.example.com             -> wss://rc.example.com/ws
 *   https://rc.example.com     -> wss://rc.example.com/ws
 *   wss://rc.example.com/rc/ws -> wss://rc.example.com/rc/ws
 *   ws://127.0.0.1:8787/ws     -> ws://127.0.0.1:8787/ws
 * 没填返回空字符串，填错了抛异常（异常信息直接给用户看）
 * @param {unknown} input
 * @returns {string}
 */
function wsUrlOf(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  if (raw.length > MAX_LENGTH) throw new Error('服务器地址太长了');
  if (/\s/.test(raw)) throw new Error('服务器地址里不能有空格');
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  const scheme = m ? m[1].toLowerCase() : 'wss';
  const rest = m ? m[2] : raw;
  const wsScheme = { wss: 'wss', https: 'wss', ws: 'ws', http: 'ws' }[scheme];
  if (!wsScheme) throw new Error(`不支持这种地址：${scheme}://，要用域名、https://、wss:// 或 ws://`);
  let u;
  try {
    u = new URL(`${wsScheme}://${rest}`);
  } catch {
    throw new Error(`服务器地址格式不正确：${raw}`);
  }
  if (!u.hostname) throw new Error(`服务器地址格式不正确：${raw}`);
  if (u.username || u.password) throw new Error('服务器地址里不能带用户名和密码');
  const pathname = !u.pathname || u.pathname === '/' ? '/ws' : u.pathname;
  return `${wsScheme}://${u.host}${pathname}`;
}

/**
 * 信令地址的简写，和手机 App 登录页填的写法一样，界面上显示、配置文件里存的都是它（wsUrlOf 能原样换算回去）：
 *   wss://rc.example.com/ws      -> rc.example.com
 *   wss://rc.example.com:8443/ws -> rc.example.com:8443
 *   wss://rc.example.com/rc/ws   -> rc.example.com/rc/ws
 *   ws://127.0.0.1:8787/ws       -> http://127.0.0.1:8787
 * 空地址返回空字符串；不是 ws/wss 地址原样返回
 * @param {string} wsUrl
 * @returns {string}
 */
function displayOf(wsUrl) {
  if (!wsUrl) return '';
  let u;
  try {
    u = new URL(wsUrl);
  } catch {
    return String(wsUrl);
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return String(wsUrl);
  const tail = u.pathname === '/ws' ? '' : u.pathname;
  return u.protocol === 'wss:' ? `${u.host}${tail}` : `http://${u.host}${tail}`;
}

/** wss://rc.example.com/ws -> https://rc.example.com（和 account.js 的 httpBaseOf 一样）；空地址返回空字符串 */
function httpBaseOf(wsUrl) {
  if (!wsUrl) return '';
  const u = new URL(wsUrl);
  const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${u.host}${u.pathname.replace(/\/ws\/?$/, '')}`;
}

/**
 * httpBaseOf 反过来：https://rc.example.com -> wss://rc.example.com/ws。
 * 用来从 account.json 记的服务器（账号接口的根地址）找回信令地址；认不出来返回空字符串
 * @param {unknown} httpBase
 * @returns {string}
 */
function wsUrlOfHttpBase(httpBase) {
  if (typeof httpBase !== 'string' || !httpBase) return '';
  let u;
  try {
    u = new URL(httpBase);
  } catch {
    return '';
  }
  const scheme = { 'https:': 'wss', 'http:': 'ws' }[u.protocol];
  if (!scheme || !u.hostname || u.username || u.password) return '';
  return `${scheme}://${u.host}${u.pathname.replace(/\/+$/, '')}/ws`;
}

/** 读 JSON 文件；记事本存的文件开头可能带 BOM，去掉再解析 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/**
 * 读被控端的配置文件。文件不存在当作空配置；写坏了抛异常（不能当成空的，免得后面写回去时把别的设置冲掉）
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readConfig(file) {
  let raw;
  try {
    raw = readJson(file);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`配置文件读不出来：${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置文件的内容要是一个 JSON 对象');
  return raw;
}

/**
 * 把服务器地址写进配置文件，其它设置原样保留。先写临时文件再换名，写到一半断电也不会把配置写坏
 * @param {string} file
 * 存的是简写（displayOf，和手机 App 填的写法一样，比如 rc.example.com），读的时候 wsUrlOf 换算回信令地址
 * @param {string} server 已经整理好的 ws:// 或 wss:// 地址
 * @returns {Record<string, unknown>} 写进去的完整配置
 */
function saveServer(file, server) {
  if (!/^wss?:\/\/[^\s]+$/.test(server)) throw new Error('服务器地址必须是 ws:// 或 wss:// 地址');
  const next = { ...readConfig(file), server: displayOf(server) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件没写出来 */
    }
    throw err;
  }
  return next;
}

/**
 * account.json 里记的服务器（账号接口的根地址，如 https://rc.example.com）。没有登录状态、读不出来时返回空字符串
 * @param {string} file
 * @returns {string}
 */
function readAccountServer(file) {
  try {
    const saved = readJson(file);
    return saved && typeof saved.server === 'string' ? saved.server : '';
  } catch {
    return '';
  }
}

/**
 * 启动时决定连哪个服务器：
 *   1. 配置文件里写了 server：用它（写错了不连，登录页显示原因，让用户改）
 *   2. 没写，但 account.json 记着上次登录的服务器（旧版安装包用的是打包时带的默认服务器）：
 *      用它，并且要写回配置文件（migrated），以后就不依赖登录状态了
 *   3. 都没有：不连，登录页让用户填
 * @param {{ configured?: unknown, accountServer?: string }} opts
 * @returns {{ server: string, source: 'config' | 'account' | 'none', input: string, error: string }}
 *   server 整理好的地址（可能为空）；input 登录页地址框里预填的内容；error 给用户看的问题说明
 */
function resolveServer({ configured, accountServer }) {
  const input = typeof configured === 'string' ? configured.trim() : '';
  if (configured != null && typeof configured !== 'string') {
    return { server: '', source: 'none', input: '', error: '配置文件里的 server 要是一个字符串，请重新填写服务器地址' };
  }
  if (input) {
    try {
      return { server: wsUrlOf(input), source: 'config', input, error: '' };
    } catch (err) {
      return { server: '', source: 'none', input, error: `配置文件里的服务器地址不对：${err.message}` };
    }
  }
  const fromAccount = wsUrlOfHttpBase(accountServer);
  if (fromAccount) return { server: fromAccount, source: 'account', input: displayOf(fromAccount), error: '' };
  return { server: '', source: 'none', input: '', error: '' };
}

module.exports = { wsUrlOf, displayOf, httpBaseOf, wsUrlOfHttpBase, readConfig, saveServer, readAccountServer, resolveServer, MAX_LENGTH };
