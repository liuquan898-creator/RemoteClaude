'use strict';
/**
 * 华为推送服务（Push Kit）服务端接口 v3，给 HarmonyOS NEXT（5.0 及以上）的手机发通知消息。
 *
 *   推送  POST https://push-api.cloud.huawei.com/v3/{projectId}/messages:send
 *   撤回  POST https://push-api.cloud.huawei.com/v1/{clientId}/messages:revoke   请求体 { notifyId, token: [...] }
 *         注意是 v1、路径里是应用的 Client ID（不是项目 ID），和推送不一样
 *   头    Authorization: Bearer <JWT>、push-type: 0（通知消息）、Content-Type: application/json
 *   鉴权  用 AppGallery Connect 下载的服务账号密钥自己签 JWT（PS256），直接当 Bearer 令牌用，不用换 OAuth 令牌；撤回用同一个
 *
 * 官方文档：
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-jwt-token            基于服务账号生成鉴权令牌
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-struct  请求结构
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-param   请求参数
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-response        响应和错误码
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-revoke-alert          撤回通知消息
 *   https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-msg-revoke        消息撤回接口和错误码
 *
 * 日志里只出现推送令牌的前几位，不出现密钥和 JWT。
 */
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_API_BASE = 'https://push-api.cloud.huawei.com';
const JWT_AUD = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token';
const JWT_TTL_SEC = 3600; // 官方建议 3600 秒；超过 1 天会被拒（80300036）
const JWT_RENEW_BEFORE_SEC = 300; // 到期前 5 分钟换新的
const DEFAULT_TIMEOUT_MS = 10 * 1000;

const CODE_OK = '80000000';
const CODE_PARTIAL = '80100000';
const CODE_JWT_EXPIRED = '80200005';
const CODE_ALL_TOKENS_INVALID = '80300007';
/**
 * 80300007 说"这批令牌全都无效"，但令牌和项目、应用对不上（projectId、密钥文件配错了，App 包名不对）也回这个码，
 * 照单全删会把所有账号的令牌删光。所以只有这台服务器在这么久之内确实推成功过（说明配置是对的）才当死令牌删，
 * 否则只提示去查配置。代价：服务器刚启动、或者服务器上的令牌恰好全失效时删不掉死令牌，每次推送白发一个请求，
 * 等那次登录作废时令牌跟着删（同一台手机重新登录就会作废旧登录）。
 */
const CONFIG_PROVEN_MS = 24 * 3600 * 1000;
/** 部分成功时 msg 里 illegalTokens 下这些原因的令牌已经不能用了，删掉；其余原因（权益、地区、处罚）是配置问题，不删 */
const DEAD_TOKEN_REASONS = ['tokenFormatError', 'noRight'];

/** 日志里显示的令牌：前 6 位和长度 */
function tokenTag(token) {
  return `${String(token).slice(0, 6)}…(${String(token).length})`;
}

/**
 * 读服务账号密钥文件（AppGallery Connect 下载的 JSON）。
 * @returns {{ projectId: string, keyId: string, subAccount: string, privateKey: crypto.KeyObject }}
 */
function loadServiceAccount(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读取华为推送服务账号密钥失败: ${file}: ${err.message}`);
  }
  const missing = ['key_id', 'private_key', 'sub_account'].filter((k) => typeof raw[k] !== 'string' || !raw[k]);
  if (missing.length) throw new Error(`华为推送服务账号密钥文件缺少 ${missing.join('、')}: ${file}`);
  let privateKey;
  try {
    // 有的密钥文件里换行是字面的 \n
    privateKey = crypto.createPrivateKey(raw.private_key.replace(/\\n/g, '\n'));
  } catch (err) {
    throw new Error(`华为推送服务账号密钥 ${file} 里的 private_key 读不出来: ${err.message}`);
  }
  return {
    projectId: typeof raw.project_id === 'string' ? raw.project_id : '',
    keyId: raw.key_id,
    subAccount: raw.sub_account,
    privateKey,
  };
}

const b64url = (v) => Buffer.from(v).toString('base64url');

/** 签一个 PS256 的 JWT（RSASSA-PSS + SHA-256，盐长 32 字节） */
function signJwt(account, iatSec, ttlSec = JWT_TTL_SEC) {
  const header = { kid: account.keyId, typ: 'JWT', alg: 'PS256' };
  const payload = { iss: account.subAccount, aud: JWT_AUD, iat: iatSec, exp: iatSec + ttlSec };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), {
    key: account.privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return `${input}.${b64url(sig)}`;
}

/** 部分成功时，从 msg 里挑出该删的令牌 */
function deadTokensFromPartial(msg) {
  let obj;
  try {
    obj = JSON.parse(msg);
  } catch {
    return [];
  }
  const illegal = obj && typeof obj === 'object' ? obj.illegalTokens : null;
  if (!illegal || typeof illegal !== 'object') return [];
  const out = [];
  for (const reason of DEAD_TOKEN_REASONS) if (Array.isArray(illegal[reason])) out.push(...illegal[reason].filter((t) => typeof t === 'string'));
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} [opts.clientId] 应用的 Client ID，撤回通知要用；不填就不能撤回（返回的 revoke 为 null）
 * @param {ReturnType<typeof loadServiceAccount>} opts.account
 * @param {string} [opts.apiBase] 测试时指到假的服务
 * @param {number} [opts.timeoutMs]
 * @param {() => number} [opts.now] 毫秒
 * @param {typeof fetch} [opts.fetch]
 */
function createHuaweiPushClient({ projectId, clientId = '', account, apiBase = DEFAULT_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, fetch: fetchImpl = fetch }) {
  const base = String(apiBase).replace(/\/+$/, '');
  const url = `${base}/v3/${encodeURIComponent(projectId)}/messages:send`;
  const revokeUrl = clientId ? `${base}/v1/${encodeURIComponent(clientId)}/messages:revoke` : '';
  let jwt = '';
  let jwtExp = 0;
  let lastSuccessAt = null; // 最近一次有令牌推成功（80000000、80100000）的时间，毫秒

  function bearer() {
    const t = Math.floor(now() / 1000);
    if (!jwt || t >= jwtExp - JWT_RENEW_BEFORE_SEC) {
      jwt = signJwt(account, t);
      jwtExp = t + JWT_TTL_SEC;
    }
    return jwt;
  }

  async function post(target, body) {
    const res = await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer()}`, 'push-type': '0' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 非 JSON 的响应（网关错误页之类） */
    }
    return {
      status: res.status,
      code: data && data.code != null ? String(data.code) : '',
      msg: data && typeof data.msg === 'string' ? data.msg : '',
      requestId: data && data.requestId != null ? String(data.requestId) : '',
    };
  }

  /** 发请求；华为说 JWT 过期（本机时钟偏了之类）时换一个再试一次 */
  async function postFresh(target, body) {
    const r = await post(target, body);
    if (r.code !== CODE_JWT_EXPIRED && !(r.status === 401 && !r.code)) return r;
    jwt = '';
    return post(target, body);
  }

  return {
    url,
    revokeUrl,
    /** 测试用：现在缓存着的 JWT 的过期时间（秒） */
    get jwtExpiresAt() {
      return jwtExp;
    },

    /**
     * 发一条通知消息。不抛业务错误：网络错误、超时会抛出，交给调用方记日志。
     * @param {string[]} tokens 最多 10 个（测试消息的上限）
     * @param {object} notification payload.notification
     * @param {object} pushOptions
     * @returns {Promise<{ ok: boolean, status: number, code: string, msg: string, requestId: string, deadTokens: string[],
     *                     configSuspect: boolean }>} configSuspect：回了 80300007 但不能确定是令牌失效，多半是配置不对，没删令牌
     */
    async send(tokens, notification, pushOptions) {
      const r = await postFresh(url, { payload: { notification }, target: { token: tokens }, pushOptions });
      const ok = r.code === CODE_OK || r.code === CODE_PARTIAL;
      if (ok) lastSuccessAt = now();
      let deadTokens = [];
      let configSuspect = false;
      if (r.code === CODE_ALL_TOKENS_INVALID) {
        if (lastSuccessAt !== null && now() - lastSuccessAt <= CONFIG_PROVEN_MS) deadTokens = tokens.slice();
        else configSuspect = true;
      } else if (r.code === CODE_PARTIAL) {
        deadTokens = deadTokensFromPartial(r.msg).filter((t) => tokens.includes(t));
      }
      return { ok, ...r, deadTokens, configSuspect };
    },

    /**
     * 撤回推过的通知：按推送时的 notifyId 和推给的令牌（一次最多 1000 个）。只撤得掉还没送到手机的、
     * 和已经显示在通知栏但没被点过的。不抛业务错误、不删令牌：网络错误、超时会抛出，交给调用方记日志。
     * 没配 clientId 时为 null。
     * @type {null | ((tokens: string[], notifyId: number) => Promise<{ ok: boolean, status: number, code: string, msg: string, requestId: string }>)}
     */
    revoke: revokeUrl
      ? async (tokens, notifyId) => {
          const r = await postFresh(revokeUrl, { notifyId, token: tokens });
          return { ok: r.code === CODE_OK, ...r };
        }
      : null,
  };
}

module.exports = { createHuaweiPushClient, loadServiceAccount, signJwt, tokenTag, JWT_AUD, DEFAULT_API_BASE };
