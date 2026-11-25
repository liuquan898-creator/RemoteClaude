'use strict';
/**
 * RemoteClaude 网页控制端
 *
 * 账号（注册、登录、找回密码）走 HTTP 接口 api/auth/...；
 * 信令（列窗口、选窗口、WebRTC 协商）走 WebSocket，发给电脑的消息都带上 host（要操作哪台电脑）；
 * 画面走 WebRTC 视频轨道，鼠标键盘事件走 WebRTC 数据通道。协议见 docs/03-protocol.md。
 * 审批和提问（2.7，界面在 approvals.js）、电脑锁屏状态和不连画面的锁定解锁（2.9、4.6，加密在 unlock.js）
 * 走信令通道，停在会话列表、没看画面时也能用。隐私屏、记住解锁密码、结束控制见 2.9 和 docs/11 第 4.2、4.4 节。
 *
 * 发给被控端的输入事件：
 *   {t:'m', x, y}            移动指针，x/y 是窗口内 0~1 的相对位置
 *   {t:'d'|'u', x, y, b}     按下 / 松开鼠标键，b: 0 左 1 中 2 右
 *   {t:'w', x, y, dx, dy}    滚轮，单位是 Windows 的滚轮增量（一格 120）
 *   {t:'k', k, m}            敲一下按键，m 是修饰键位掩码: 1 Ctrl 2 Shift 4 Alt
 *   {t:'t', s}               输入一段文字
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    auth: $('auth'), authForm: $('authForm'), authHint: $('authHint'), email: $('email'), codeRow: $('codeRow'),
    code: $('code'), sendCode: $('sendCode'), password: $('password'), authSubmit: $('authSubmit'),
    authError: $('authError'), authInfo: $('authInfo'), toLogin: $('toLogin'), toRegister: $('toRegister'), toForgot: $('toForgot'),
    app: $('app'), dot: $('dot'), curTitle: $('curTitle'), stage: $('stage'), video: $('video'), hint: $('hint'),
    tools: $('tools'), keys: $('keys'), fontBar: $('fontBar'), composer: $('composer'), text: $('text'),
    btnImage: $('btnImage'), imageFile: $('imageFile'),
    picker: $('picker'), hostTabs: $('hostTabs'), list: $('list'), accountEmail: $('accountEmail'), toast: $('toast'),
    btnKeys: $('btnKeys'),
    banners: $('banners'), pickerBanners: $('pickerBanners'), btnAppr: $('btnAppr'), apprCount: $('apprCount'),
    approvals: $('approvals'), apprTitle: $('apprTitle'), apprList: $('apprList'), apprEmpty: $('apprEmpty'),
    menuLayer: $('menuLayer'), menu: $('menu'), menuHost: $('menuHost'), menuLock: $('menuLock'), menuLockNote: $('menuLockNote'),
    menuEmail: $('menuEmail'), lockDlg: $('lockDlg'), lockDlgText: $('lockDlgText'),
    menuPrivacy: $('menuPrivacy'), menuForget: $('menuForget'),
    menuPrivacyOnUnlock: $('menuPrivacyOnUnlock'), menuPrivacyOnUnlockState: $('menuPrivacyOnUnlockState'),
    unlockDlg: $('unlockDlg'), unlockForm: $('unlockForm'), unlockPw: $('unlockPw'),
    unlockTitle: $('unlockDlgTitle'), unlockNote: $('unlockDlgNote'), unlockHint: $('unlockDlgHint'),
    unlockRememberBox: $('unlockRememberBox'), unlockRemember: $('unlockRemember'),
  };

  const PROTO = 2;
  const CLIENT = 'web/0.5.0';
  const SPECIAL_KEYS = new Set([
    'Backspace', 'Tab', 'Enter', 'Escape', 'PageUp', 'PageDown', 'End', 'Home',
    'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Insert', 'Delete',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]);
  const BROWSER_KEYS = new Set(['F5', 'F11', 'F12']); // 留给浏览器自己用，不转发
  const IGNORED_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu', 'Process', 'Unidentified', 'Dead']);
  const ERROR_TEXT = {
    'front-failed': '电脑上无法把该窗口切到前台',
    'locked': '电脑锁屏了，解锁后才能操作',
    'covered': '点击位置被电脑上的其它窗口挡住了',
    'window-gone': '该窗口已关闭',
    'capture-failed': '采集该窗口失败',
    'host-offline': '这台电脑不在线',
    'image-too-large': '图片太大了',
    'image-bad': '图片数据有误，没能粘贴',
    'image-timeout': '图片传输中断了',
    'closed': '画面连接断开了，图片没有发出去',
    // 解锁的结果（协议文档 4.6、2.9）
    'not-locked': '电脑没有锁屏',
    'no-service': '电脑上没装解锁服务',
    'bad-service': '电脑上的解锁服务要重新安装（版本太旧或没通过核实）',
    'rate-limited': '失败次数太多，15 分钟后再试',
    'still-locked': '没解开，请检查密码或 PIN',
    'no-logon-screen': '没找到电脑的登录界面，没有输入密码',
    'busy': '正在解锁，请稍候',
    // 要先盖隐私屏却没盖上，被控端没有解锁（docs/11 第 4.4 节）
    'privacy-failed': '隐私屏没盖上，没有解锁。电脑上的解锁服务可能要重新安装；也可以在菜单里关掉“解锁时打开隐私屏”',
    // 用记下的密码解锁的结果（协议文档 2.9"记住解锁密码"）；一般会直接弹出输入框，用不到这两句
    'saved-wrong': '记下的密码不对了（可能改过密码），已经删掉，请重新输入',
    'no-saved': '电脑上没有记下的密码了，请输入密码',
    'failed': '解锁失败',
    'bad-op': '电脑上的被控端不认这个命令，请升级被控端',
  };
  /** 不打开会话窗口就锁定、解锁，要被控端从这个版本起（协议文档 2.9） */
  const HOST_CMD_MIN_VERSION = '0.9.6';
  const UNLOCK_REPLY_TIMEOUT_MS = 30000;
  /** 开关隐私屏、忘掉记下的密码等回执的时间：电脑上盖、撤黑幕最多要十几秒（同安卓 PRIVACY_REPLY_TIMEOUT_MS） */
  const HOST_CMD_REPLY_TIMEOUT_MS = 20000;
  /** 图片 id -> 收到回执时调用，参数是错误码，成功时是 'ok'（协议文档 4.5） */
  const imageWaiters = new Map();
  const WHEEL_PER_PIXEL = 1.2; // 浏览器滚轮一格约 100 像素，对应 Windows 的 120

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式下可能不可用 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /** 设置"解锁时打开隐私屏"（docs/11 第 4.4 节），默认开，记在本浏览器里：'1' 开、'0' 关 */
  const PRIVACY_ON_UNLOCK_KEY = 'rc.privacyOnUnlock';
  const privacyOnUnlock = () => store.get(PRIVACY_ON_UNLOCK_KEY) !== '0';
  /** 解锁框里"记住密码"上次勾没勾（默认勾）。只记这个选择，密码本身浏览器不存 */
  const REMEMBER_UNLOCK_KEY = 'rc.rememberUnlock';

  /** 本浏览器的设备编号：第一次打开时随机生成，不是机密 */
  function deviceId() {
    let id = store.get('rc.device');
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      store.set('rc.device', id);
    }
    return id;
  }

  function deviceName() {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
      : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `浏览器（${os}）` : '浏览器';
  }

  let ws = null;
  let authed = false;
  let token = store.get('rc.token');
  let email = store.get('rc.email') || '';
  let iceServers = [];
  let retry = 1000;
  let retryTimer = null;

  let hosts = []; // 账号下的电脑 [{id, name, online}]
  let hostId = store.get('rc.host') || null; // 当前选中的电脑
  let pc = null;
  let dc = null;
  let pendingIce = [];
  let current = null; // 当前选中的窗口 { hwnd, title }
  let windows = [];
  let wantHwnd = Number(store.get('rc.hwnd')) || 0; // 上次看的窗口，重连后自动选回去
  let reselectTimer = null;

  /**
   * 电脑 id -> 被控端推来的状态 { lock: {locked, unlock, untrusted, saved}, key, privacy, v032 }（协议文档 2.9）；
   * 电脑下线、断开服务器时作废。privacy 是隐私屏开着没有（被控端 0.9.32 起，旧版没有，当作没开）；
   * v032 是被控端 0.9.32 起、认隐私屏和"记住解锁密码"（0.9.32 起的 host-state 总带布尔的 privacy，拿它认版本）
   */
  const hostStates = new Map();
  /** 数据通道上收到的锁屏状态（协议文档 4.6），只对正在看的这台电脑、这条画面连接有效 */
  let peerLock = null;
  /** 当前电脑回了窗口列表却没推过 host-state：被控端是 0.9.6 以前的版本，不认不连画面的命令 */
  let hostTooOld = false;
  /** 等回执的命令（解锁、开关隐私屏、忘掉记下的密码）的编号 -> 收到回执时调用（参数是错误码，成功时是 'ok'），via 是 peer 或 server */
  const cmdWaiters = new Map();
  let cmdSeq = 0;
  let unlocking = false;
  /** 解锁框是为哪台电脑打开的：提交时选的电脑换了就不发（输的是原来那台的密码） */
  let unlockFor = null;
  /** 正在等开关隐私屏的回执：要开时是 true、要关时是 false，没在等时是 null */
  let privacyBusy = null;
  /** 正在等"忘掉记下的解锁密码"的回执 */
  let forgetting = false;

  const currentHost = () => hosts.find((h) => h.id === hostId) || null;
  const hostOnline = () => {
    const h = currentHost();
    return !!h && h.online;
  };

  // ---------------------------------------------------------------- 账号：登录、注册、找回密码

  let authMode = 'login';
  let codeTimer = null;

  function authMessage(error, info) {
    el.authError.textContent = error || '';
    el.authError.hidden = !error;
    el.authInfo.textContent = info || '';
    el.authInfo.hidden = !info;
  }

  function setAuthMode(mode) {
    authMode = mode;
    const reg = mode === 'register';
    const forgot = mode === 'forgot';
    el.codeRow.hidden = !(reg || forgot);
    el.authHint.textContent = reg ? '用邮箱注册账号。电脑上的被控端和手机登录同一个账号，就能配对使用'
      : forgot ? '用邮箱验证码重新设置密码，所有已登录的设备都会下线'
        : '登录后查看和操作电脑上的 Claude 会话窗口';
    el.password.placeholder = reg ? '设置密码（至少 8 位）' : forgot ? '新密码（至少 8 位）' : '密码';
    el.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    el.authSubmit.textContent = reg ? '注册并登录' : forgot ? '重置密码' : '登录';
    el.toLogin.hidden = mode === 'login';
    el.toRegister.hidden = reg;
    el.toForgot.hidden = forgot;
    authMessage('', '');
  }

  function showAuth(mode, error) {
    el.app.hidden = true;
    el.auth.hidden = false;
    setAuthMode(mode || 'login');
    if (error) authMessage(error, '');
    el.password.value = '';
    el.code.value = '';
    if (email && !el.email.value) el.email.value = email;
    (el.email.value ? el.password : el.email).focus();
  }

  /** 调账号接口；失败时抛出 { code, message, retryAfter } */
  async function api(path, body, bearer) {
    const headers = { 'content-type': 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let res;
    try {
      res = await fetch(`api/auth/${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    } catch {
      throw { message: '连不上服务器，请检查网络' };
    }
    let data = {};
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
    if (!res.ok) throw { code: data.error, message: data.message || `请求失败（HTTP ${res.status}）`, retryAfter: data.retryAfter };
    return data;
  }

  function startCodeCooldown(sec) {
    clearInterval(codeTimer);
    let left = Math.max(1, Math.round(sec));
    el.sendCode.disabled = true;
    const tick = () => {
      if (left <= 0) {
        clearInterval(codeTimer);
        el.sendCode.disabled = false;
        el.sendCode.textContent = '重新发送';
        return;
      }
      el.sendCode.textContent = `${left} 秒后重发`;
      left -= 1;
    };
    tick();
    codeTimer = setInterval(tick, 1000);
  }

  el.sendCode.addEventListener('click', async () => {
    const addr = el.email.value.trim();
    if (!addr) {
      authMessage('请先填写邮箱', '');
      el.email.focus();
      return;
    }
    el.sendCode.disabled = true;
    try {
      const r = await api('send-code', { email: addr, purpose: authMode === 'forgot' ? 'reset' : 'register' });
      authMessage('', authMode === 'forgot' ? '如果这个邮箱注册过，验证码已经发出，请查收' : '验证码已发出，请查收邮件（也看看垃圾邮件）');
      startCodeCooldown(r.cooldown || 60);
      el.code.focus();
    } catch (err) {
      authMessage(err.message, '');
      if (err.retryAfter) startCodeCooldown(err.retryAfter);
      else el.sendCode.disabled = false;
    }
  });

  el.authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const addr = el.email.value.trim();
    const pw = el.password.value;
    const code = el.code.value.trim();
    if (!addr || !pw) {
      authMessage('请填写邮箱和密码', '');
      return;
    }
    if (authMode !== 'login' && !/^\d{6}$/.test(code)) {
      authMessage('请填写邮件里的 6 位验证码', '');
      return;
    }
    el.authSubmit.disabled = true;
    authMessage('', '');
    try {
      if (authMode === 'forgot') {
        await api('reset-password', { email: addr, code, password: pw });
        history.replaceState(null, '', location.pathname);
        setAuthMode('login');
        el.password.value = '';
        authMessage('', '密码已重置，请用新密码登录');
        el.password.focus();
        return;
      }
      const device = { clientType: 'viewer', deviceId: deviceId(), deviceName: deviceName() };
      const r = authMode === 'register'
        ? await api('register', { email: addr, code, password: pw, ...device })
        : await api('login', { email: addr, password: pw, ...device });
      signedIn(r.token, r.email);
    } catch (err) {
      authMessage(err.message, '');
    } finally {
      el.authSubmit.disabled = false;
    }
  });

  for (const [link, mode] of [[el.toLogin, 'login'], [el.toRegister, 'register'], [el.toForgot, 'forgot']]) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(null, '', mode === 'login' ? location.pathname : `#${mode}`);
      setAuthMode(mode);
    });
  }

  function signedIn(newToken, newEmail) {
    token = newToken;
    email = newEmail;
    store.set('rc.token', token);
    store.set('rc.email', email);
    history.replaceState(null, '', location.pathname);
    el.password.value = '';
    el.code.value = '';
    el.accountEmail.textContent = email;
    showApp();
    refreshStatus();
    connect();
  }

  /** 清掉登录状态回到登录页，返回原来的令牌（用于通知服务器作废） */
  function signOut(error) {
    // 退出登录：先告诉正在控制的电脑不控制了（还连着服务器时才发得出去；登录失效时就不用了）
    releaseHost(hostId);
    const old = token;
    token = null;
    store.del('rc.token');
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    authed = false;
    listWhenVisible = false;
    current = null;
    hosts = [];
    windows = [];
    closePeer();
    closePicker();
    forgetHostData();
    closeOverlays();
    el.fontBar.hidden = true;
    showAuth('login', error);
    return old;
  }

  // ---------------------------------------------------------------- 界面状态

  function showApp() {
    el.auth.hidden = true;
    el.app.hidden = false;
    fitViewport();
  }

  function setDot(kind) {
    el.dot.className = 'dot ' + kind;
  }

  function setHint(text) {
    el.hint.textContent = text || '';
    el.hint.hidden = !text;
  }

  let toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }

  const isLive = () => !!dc && dc.readyState === 'open';

  function refreshStatus() {
    el.curTitle.textContent = current ? current.title : '选择会话';
    const host = currentHost();
    if (!authed) {
      setDot('off');
      setHint('与服务器的连接已断开，正在重连…');
    } else if (!hosts.length) {
      setDot('off');
      setHint('这个账号还没有电脑登录。请在电脑上运行被控端，用同一个账号登录');
    } else if (!host) {
      setDot('wait');
      setHint('请选择要查看的电脑');
    } else if (!host.online) {
      setDot('off');
      setHint(`电脑「${host.name}」不在线`);
    } else if (!current) {
      setDot('wait');
      setHint('请选择要查看的 Claude 会话');
    } else if (pc && pc.connectionState === 'connected' && el.video.videoWidth) {
      setDot('on');
      setHint('');
    } else {
      setDot('wait');
      setHint('正在连接画面…');
    }
    renderHostUi();
  }

  // ---------------------------------------------------------------- 信令

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /**
   * 告诉电脑不再控制它了（host-cmd 的 release，被控端 0.9.32 起，docs/11 第 4.2 节）：被控端马上关掉为这次控制开的虚拟屏、
   * 不再防息屏，开着的隐私屏先锁屏再撤。换到别的电脑、退出登录时发；页面只是切到后台时不发（回个消息电脑就锁屏了）。
   * 只发给推过 host-state 的电脑（认 host-cmd）；0.9.32 以前的回 bad-op，不带 req 就没有回执，不影响什么
   */
  function releaseHost(id) {
    if (id && authed && hostStates.has(id)) send({ type: 'host-cmd', host: id, op: 'release' });
  }

  /** 发给当前所选电脑的消息 */
  function sendHost(obj) {
    if (hostId) send({ ...obj, host: hostId });
  }

  /** 页面藏在后台时连上服务器、电脑上线，没要窗口列表，等回到前台再要 */
  let listWhenVisible = false;

  /**
   * 连上服务器、电脑上线时自动要窗口列表。页面藏在后台（切到别的标签页、手机 App 退到后台）时不要：
   * 被控端会当成在控制这台电脑，防息屏、开虚拟屏（docs/11 第 4.2 节）；记下来，回到前台时再要（见 visibilitychange）
   */
  function requestList() {
    if (!hostOnline()) return;
    if (document.hidden) {
      listWhenVisible = true;
      return;
    }
    listWhenVisible = false;
    sendHost({ type: 'list' });
  }

  function wsUrl() {
    const u = new URL('ws', location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
  }

  function connect() {
    clearTimeout(retryTimer);
    if (!token) return;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    authed = false;
    const sock = new WebSocket(wsUrl());
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', role: 'viewer', token, proto: PROTO, client: CLIENT }));
    sock.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg).catch((err) => console.error(err));
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      authed = false;
      // 服务器会通知电脑这个控制端已离开，画面连接随之作废；电脑的状态也作废，重连后电脑会再推。
      // 审批卡片先留着（正在填的说明、选项不丢），重连后电脑推来的新列表会整份替换
      closePeer();
      forgetHostData({ keepApprovals: true });
      refreshStatus();
      if (!token) return;
      retryTimer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
    sock.onerror = () => {};
  }

  /** 选电脑：记住的那台还在就用它；否则只有一台（在线）时自动选上 */
  function chooseHost() {
    if (hostId && hosts.some((h) => h.id === hostId)) return;
    const online = hosts.filter((h) => h.online);
    const pick = online.length === 1 ? online[0] : hosts.length === 1 ? hosts[0] : null;
    setHost(pick ? pick.id : null);
  }

  function setHost(id) {
    if (id === hostId) return;
    if (hostId && pc) sendHost({ type: 'stop' });
    // 换到别的电脑：告诉原来那台不控制了（马上关虚拟屏、隐私屏先锁屏再撤）。原来那台下线、被删掉了就不用发
    releaseHost(hostId);
    closePeer();
    current = null;
    windows = [];
    hostId = id;
    hostTooOld = false;
    // 解锁框是为原来那台开的（标题、"记住密码"都是那台的）：关掉、清掉输了一半的密码。提交时还会再核对一次
    if (!el.unlockDlg.hidden && unlockFor !== id) {
      closeUnlock();
      toast('选的电脑换了，解锁框已经关掉，密码没有发出去');
    }
    if (id) store.set('rc.host', id);
    else store.del('rc.host');
    wantHwnd = 0;
    store.del('rc.hwnd');
  }

  /** 不管是不是当前所选的电脑都要处理的消息：审批推给所有控制端，状态按电脑分别记 */
  const ANY_HOST_TYPES = new Set(['error', 'approvals', 'approval-result', 'host-state', 'host-cmd-result']);

  async function onMessage(msg) {
    // 电脑发来的其它消息只处理当前所选的那台
    if (typeof msg.host === 'string' && !ANY_HOST_TYPES.has(msg.type) && msg.host !== hostId) return;

    switch (msg.type) {
      case 'auth-ok':
        authed = true;
        authedAt = Date.now();
        retry = 1000;
        iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
        hosts = Array.isArray(msg.hosts) ? msg.hosts : [];
        pruneOfflineHosts();
        if (msg.email) {
          email = msg.email;
          store.set('rc.email', email);
        }
        el.accountEmail.textContent = email;
        chooseHost();
        showApp();
        renderHostTabs();
        refreshStatus();
        if (hostOnline()) requestList();
        else if (hosts.length) openPicker();
        syncPush();
        break;

      case 'auth-fail':
        if (msg.reason === 'locked') {
          toast('连接失败次数太多，稍后自动重试');
          retry = 60000;
          break;
        }
        signOut(msg.reason === 'bad-proto' ? '网页版本太旧，请刷新页面'
          : msg.reason === 'revoked' ? '账号已在别处退出登录或修改了密码，请重新登录'
            : '登录已过期，请重新登录');
        break;

      case 'hosts': {
        const wasOnline = hostOnline();
        hosts = Array.isArray(msg.hosts) ? msg.hosts : [];
        pruneOfflineHosts();
        if (hostId && !hosts.some((h) => h.id === hostId)) setHost(null);
        chooseHost();
        renderHostTabs();
        if (wasOnline && !hostOnline()) closePeer();
        if (hostOnline() && (!wasOnline || !windows.length)) requestList();
        if (!el.picker.hidden) renderList();
        refreshStatus();
        break;
      }

      case 'windows':
        windows = Array.isArray(msg.list) ? msg.list : [];
        // host-state 总比这个控制端的第一份 windows 先到；回了列表还没有，就是旧版被控端（协议文档 2.9）
        hostTooOld = !hostStates.has(hostId);
        renderList();
        if (!isLive()) {
          // 还没有画面：优先回到上次看的窗口，否则让用户选
          const again = windows.find((w) => w.hwnd === (current ? current.hwnd : wantHwnd));
          if (again) select(again);
          else { current = null; openPicker(); }
        }
        refreshStatus();
        break;

      case 'offer':
        await onOffer(msg);
        break;

      case 'ice':
        if (!msg.candidate) break;
        if (pc && pc.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(() => {});
        else pendingIce.push(msg.candidate);
        break;

      case 'selected':
        current = { hwnd: msg.hwnd, title: msg.title };
        resetView();
        refreshStatus();
        break;

      case 'window-closed':
        toast('该窗口已关闭');
        current = null;
        closePeer();
        refreshStatus();
        openPicker();
        break;

      case 'approvals':
        if (typeof msg.host !== 'string') break;
        approvalsByHost.set(msg.host, (Array.isArray(msg.list) ? msg.list : []).map(RcApprovals.normalize).filter(Boolean));
        publishApprovals();
        break;

      case 'approval-result':
        onApprovalResult(msg);
        break;

      case 'host-state':
        if (typeof msg.host !== 'string') break;
        hostStates.set(msg.host, {
          lock: lockFrom(msg.lock),
          key: typeof msg.key === 'string' && msg.key ? msg.key : null,
          privacy: msg.privacy === true,
          v032: typeof msg.privacy === 'boolean',
        });
        if (msg.host === hostId) hostTooOld = false;
        refreshStatus();
        break;

      case 'host-cmd-result':
        if (typeof msg.req === 'string' && cmdWaiters.has(msg.req)) {
          cmdWaiters.get(msg.req).done(msg.ok === true ? 'ok' : (typeof msg.code === 'string' && msg.code) || 'failed');
        }
        break;

      case 'push-register-result':
        // 推送注册的结果只记一下，不打扰用户（服务器可能还不认 push-register）
        console.info('push-register-result', msg.ok === true ? 'ok' : msg.code || msg.error || '');
        break;

      case 'error':
        if (msg.host !== hostId) break;
        toast(ERROR_TEXT[msg.code] || '操作失败');
        if (msg.code === 'host-offline') { closePeer(); refreshStatus(); }
        if (msg.code === 'capture-failed') { current = null; refreshStatus(); openPicker(); }
        break;

      default:
    }
  }

  // ---------------------------------------------------------------- WebRTC

  function closePeer() {
    clearTimeout(reselectTimer);
    pendingIce = [];
    for (const done of [...imageWaiters.values()]) done('closed');
    for (const w of [...cmdWaiters.values()]) if (w.via === 'peer') w.done('closed');
    peerLock = null;
    if (dc) { dc.onclose = null; dc = null; }
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      try { pc.close(); } catch { /* ignore */ }
      pc = null;
    }
    el.video.srcObject = null;
  }

  async function onOffer(msg) {
    closePeer();
    const conn = new RTCPeerConnection({ iceServers });
    pc = conn;
    current = { hwnd: msg.hwnd, title: msg.title };

    conn.ontrack = (e) => {
      try { e.receiver.jitterBufferTarget = 0; } catch { /* 不支持就用默认缓冲 */ }
      el.video.srcObject = e.streams[0] || new MediaStream([e.track]);
      el.video.play().catch(() => {});
    };
    conn.ondatachannel = (e) => {
      dc = e.channel;
      dc.onopen = refreshStatus;
      dc.onclose = refreshStatus;
      dc.onmessage = (m) => {
        let ev;
        try { ev = JSON.parse(m.data); } catch { return; }
        // 带 id 的是图片回执（协议文档 4.5）
        if ((ev.t === 'img-ok' || ev.t === 'err') && typeof ev.id === 'string' && imageWaiters.has(ev.id)) {
          imageWaiters.get(ev.id)(ev.t === 'img-ok' ? 'ok' : ev.code || 'unknown');
          return;
        }
        // 锁屏状态和解锁回执（协议文档 4.6）
        if (ev.t === 'lock') {
          peerLock = lockFrom(ev);
          refreshStatus();
          return;
        }
        if (ev.t === 'unlock-result') {
          const w = typeof ev.id === 'string' && cmdWaiters.get(ev.id);
          if (w) w.done(ev.ok === true ? 'ok' : (typeof ev.code === 'string' && ev.code) || 'failed');
          return;
        }
        if (ev.t === 'err') toast(ERROR_TEXT[ev.code] || '操作失败');
      };
    };
    conn.onicecandidate = (e) => {
      if (e.candidate) sendHost({ type: 'ice', candidate: e.candidate });
    };
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      refreshStatus();
      clearTimeout(reselectTimer);
      if (conn.connectionState === 'failed' || conn.connectionState === 'disconnected') {
        // 网络抖动后自己恢复不了：先让电脑关掉旧连接，再重新要一次画面
        reselectTimer = setTimeout(() => {
          if (pc === conn && conn.connectionState !== 'connected' && current && authed && hostOnline()) {
            const hwnd = current.hwnd;
            sendHost({ type: 'stop' });
            closePeer();
            sendHost({ type: 'select', hwnd });
            refreshStatus();
          }
        }, conn.connectionState === 'failed' ? 300 : 5000);
      }
    };

    await conn.setRemoteDescription(msg.sdp);
    for (const c of pendingIce) await conn.addIceCandidate(c).catch(() => {});
    pendingIce = [];
    await conn.setLocalDescription(await conn.createAnswer());
    sendHost({ type: 'answer', sdp: conn.localDescription });
    resetView();
    refreshStatus();
  }

  function select(w) {
    current = { hwnd: w.hwnd, title: w.title };
    wantHwnd = w.hwnd;
    store.set('rc.hwnd', String(w.hwnd));
    sendHost({ type: 'select', hwnd: w.hwnd });
    closePicker();
    refreshStatus();
  }

  // ---------------------------------------------------------------- 选电脑、选会话

  function renderHostTabs() {
    el.hostTabs.textContent = '';
    if (hosts.length <= 1) return;
    for (const h of hosts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = (h.id === hostId ? 'current' : '') + (h.online ? '' : ' offline');
      const dot = document.createElement('span');
      dot.className = 'dot ' + (h.online ? 'on' : 'off');
      const name = document.createElement('span');
      name.textContent = h.online ? h.name : `${h.name}（离线）`;
      b.append(dot, name);
      b.addEventListener('click', () => {
        if (h.id === hostId) return;
        setHost(h.id);
        renderHostTabs();
        renderList();
        refreshStatus();
        if (h.online) sendHost({ type: 'list' });
      });
      el.hostTabs.append(b);
    }
  }

  function renderList() {
    el.list.textContent = '';
    if (!windows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = !hosts.length ? '这个账号还没有电脑登录被控端'
        : !hostId ? '请先在上面选一台电脑'
          : !hostOnline() ? '这台电脑不在线'
            : '电脑上没有打开的 Claude 窗口';
      el.list.append(empty);
      return;
    }
    for (const w of windows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'win' + (current && current.hwnd === w.hwnd ? ' current' : '');
      if (typeof w.thumb === 'string' && w.thumb.startsWith('data:image/')) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = w.thumb;
        btn.append(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'noimg';
        ph.textContent = w.minimized ? '已最小化' : '无预览';
        btn.append(ph);
      }
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = w.title;
      btn.append(name);
      btn.addEventListener('click', () => select(w));
      el.list.append(btn);
    }
  }

  function openPicker() {
    renderHostTabs();
    renderList();
    el.picker.hidden = false;
  }

  function closePicker() {
    el.picker.hidden = true;
  }

  $('btnPick').addEventListener('click', () => {
    openPicker();
    if (hostOnline()) sendHost({ type: 'list' });
  });
  $('btnRefresh').addEventListener('click', () => {
    if (hostOnline()) sendHost({ type: 'list' });
  });
  $('btnClose').addEventListener('click', closePicker);
  el.picker.addEventListener('click', (e) => {
    if (e.target === el.picker) closePicker();
  });

  // ---------------------------------------------------------------- 画面布局与缩放

  const view = { zoom: 1, panX: 0, panY: 0 };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function layout() {
    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    const sw = el.stage.clientWidth;
    const sh = el.stage.clientHeight;
    if (!vw || !vh || !sw || !sh) return;
    const fit = Math.min(sw / vw, sh / vh, 1.5); // 小窗口最多放大到 1.5 倍，再大就糊了
    const bw = vw * fit;
    const bh = vh * fit;
    const w = bw * view.zoom;
    const h = bh * view.zoom;
    view.panX = w <= sw ? (sw - w) / 2 : clamp(view.panX, sw - w, 0);
    view.panY = h <= sh ? (sh - h) / 2 : clamp(view.panY, sh - h, 0);
    el.video.style.width = bw + 'px';
    el.video.style.height = bh + 'px';
    el.video.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  }

  function resetView() {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    layout();
  }

  /** 以舞台上的 (cx, cy) 为中心缩放，保持手指下的内容不动 */
  function zoomAt(cx, cy, zoom) {
    const next = clamp(zoom, 1, 6);
    const k = next / view.zoom;
    view.panX = cx - (cx - view.panX) * k;
    view.panY = cy - (cy - view.panY) * k;
    view.zoom = next;
    layout();
  }

  /** 屏幕坐标 -> 远程窗口内 0~1 的相对位置；落在画面外时返回 null（clampEdge 为真则贴边） */
  function toRemote(clientX, clientY, clampEdge) {
    const r = el.video.getBoundingClientRect();
    if (!el.video.videoWidth || !r.width || !r.height) return null;
    let x = (clientX - r.left) / r.width;
    let y = (clientY - r.top) / r.height;
    if (clampEdge) {
      x = clamp(x, 0, 1);
      y = clamp(y, 0, 1);
    } else if (x < 0 || x > 1 || y < 0 || y > 1) {
      return null;
    }
    return { x: +x.toFixed(5), y: +y.toFixed(5) };
  }

  el.video.addEventListener('resize', () => { layout(); refreshStatus(); });
  el.video.addEventListener('loadedmetadata', () => { layout(); refreshStatus(); });
  el.video.addEventListener('playing', () => { refreshStatus(); keepAwake(); });
  new ResizeObserver(layout).observe(el.stage);
  $('btnFit').addEventListener('click', resetView);

  // ---------------------------------------------------------------- 输入发送

  function sendInput(ev) {
    if (!isLive()) return false;
    dc.send(JSON.stringify(ev));
    return true;
  }

  // 指针移动和滚动合并后每 16 毫秒最多发一次，避免把数据通道灌满。
  // 用定时器而不是 requestAnimationFrame：页面不在前台时后者完全不触发，事件会一直积压。
  let pendingMove = null;
  const wheel = { x: 0, y: 0, pt: null };
  let frameQueued = false;

  function queueFrame() {
    if (frameQueued) return;
    frameQueued = true;
    setTimeout(() => {
      frameQueued = false;
      if (pendingMove) {
        sendInput({ t: 'm', x: pendingMove.x, y: pendingMove.y });
        pendingMove = null;
      }
      const dx = Math.trunc(wheel.x);
      const dy = Math.trunc(wheel.y);
      if ((dx || dy) && wheel.pt) {
        sendInput({ t: 'w', x: wheel.pt.x, y: wheel.pt.y, dx, dy });
        wheel.x -= dx;
        wheel.y -= dy;
      }
    }, 16);
  }

  function click(pt, button) {
    if (!pt) return;
    sendInput({ t: 'm', x: pt.x, y: pt.y });
    sendInput({ t: 'd', x: pt.x, y: pt.y, b: button });
    sendInput({ t: 'u', x: pt.x, y: pt.y, b: button });
  }

  // ---------------------------------------------------------------- 鼠标（电脑浏览器）

  const isTouch = (e) => e.pointerType === 'touch';

  /** 捕获指针，让移出画面后的移动和抬起事件仍然发给舞台 */
  function capture(e) {
    try { el.stage.setPointerCapture(e.pointerId); } catch { /* 指针已失效时会抛错，忽略 */ }
  }

  function mouseDown(e) {
    if (e.button > 2) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const pt = toRemote(e.clientX, e.clientY, false);
    if (!pt) return;
    capture(e);
    pendingMove = null;
    sendInput({ t: 'm', x: pt.x, y: pt.y });
    sendInput({ t: 'd', x: pt.x, y: pt.y, b: e.button });
  }

  function mouseMove(e) {
    // 拖动时允许移出画面（贴边），否则只在画面内才移动远程指针
    const pt = toRemote(e.clientX, e.clientY, e.buttons !== 0);
    if (!pt) return;
    pendingMove = pt;
    queueFrame();
  }

  function mouseUp(e) {
    if (e.button > 2) return;
    const pt = toRemote(e.clientX, e.clientY, true);
    if (!pt) return;
    pendingMove = null;
    sendInput({ t: 'u', x: pt.x, y: pt.y, b: e.button });
  }

  el.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const box = el.stage.getBoundingClientRect();
    if (e.ctrlKey) {
      // Ctrl+滚轮（或触控板捏合）：本地缩放画面
      zoomAt(e.clientX - box.left, e.clientY - box.top, view.zoom * Math.exp(-e.deltaY / 300));
      return;
    }
    const pt = toRemote(e.clientX, e.clientY, false);
    if (!pt) return;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    wheel.pt = pt;
    wheel.y -= e.deltaY * unit * WHEEL_PER_PIXEL;
    wheel.x += e.deltaX * unit * WHEEL_PER_PIXEL;
    queueFrame();
  }, { passive: false });

  el.stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------- 触摸（手机）
  // 单指轻点 = 左键；单指长按 = 右键；单指拖动 = 滚动远程内容；双指 = 本地缩放和平移画面

  const touches = new Map();
  let gesture = null;
  const TAP_SLOP = 10;
  const LONG_PRESS_MS = 550;

  function twoFingers() {
    const [a, b] = [...touches.values()];
    const box = el.stage.getBoundingClientRect();
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mx: (a.x + b.x) / 2 - box.left,
      my: (a.y + b.y) / 2 - box.top,
    };
  }

  function touchDown(e) {
    e.preventDefault();
    capture(e);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) {
      const pt = toRemote(e.clientX, e.clientY, false);
      gesture = { kind: 'tap', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, pt, axis: null, timer: null };
      const g = gesture;
      g.timer = setTimeout(() => {
        if (gesture !== g || g.kind !== 'tap') return;
        g.kind = 'done';
        if (g.pt) {
          click(g.pt, 2);
          if (navigator.vibrate) navigator.vibrate(30);
        }
      }, LONG_PRESS_MS);
    } else if (touches.size === 2) {
      if (gesture) clearTimeout(gesture.timer);
      const t = twoFingers();
      gesture = { kind: 'pinch', dist: t.dist, zoom: view.zoom, mx: t.mx, my: t.my };
    }
  }

  function touchMove(e) {
    const p = touches.get(e.pointerId);
    if (!p || !gesture) return;
    p.x = e.clientX;
    p.y = e.clientY;

    if (gesture.kind === 'pinch' && touches.size >= 2) {
      const t = twoFingers();
      view.panX += t.mx - gesture.mx;
      view.panY += t.my - gesture.my;
      gesture.mx = t.mx;
      gesture.my = t.my;
      zoomAt(t.mx, t.my, gesture.zoom * (t.dist / gesture.dist));
      return;
    }

    if (gesture.kind === 'tap' && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > TAP_SLOP) {
      clearTimeout(gesture.timer);
      gesture.kind = 'scroll';
      // 起手方向定轴，避免上下滑动时混进横向滚动
      gesture.axis = Math.abs(e.clientX - gesture.sx) > Math.abs(e.clientY - gesture.sy) * 2 ? 'x' : 'y';
    }
    if (gesture.kind === 'scroll' && gesture.pt) {
      const r = el.video.getBoundingClientRect();
      const scale = r.height ? el.video.videoHeight / r.height : 1; // 屏幕上 1 像素对应远程多少像素
      if (gesture.axis === 'y') wheel.y += (e.clientY - gesture.ly) * scale;
      else wheel.x -= (e.clientX - gesture.lx) * scale;
      wheel.pt = gesture.pt;
      gesture.lx = e.clientX;
      gesture.ly = e.clientY;
      queueFrame();
    }
  }

  function touchUp(e) {
    if (!touches.delete(e.pointerId) || !gesture) return;
    if (gesture.kind === 'tap') {
      clearTimeout(gesture.timer);
      if (e.type === 'pointerup') click(gesture.pt, 0);
    }
    if (touches.size === 0) gesture = null;
    else if (gesture.kind === 'pinch') gesture = { kind: 'done' }; // 抬起一指后，剩下那指不再触发任何操作
  }

  el.stage.addEventListener('pointerdown', (e) => (isTouch(e) ? touchDown(e) : mouseDown(e)));
  el.stage.addEventListener('pointermove', (e) => (isTouch(e) ? touchMove(e) : mouseMove(e)));
  el.stage.addEventListener('pointerup', (e) => (isTouch(e) ? touchUp(e) : mouseUp(e)));
  el.stage.addEventListener('pointercancel', (e) => (isTouch(e) ? touchUp(e) : mouseUp(e)));

  // ---------------------------------------------------------------- 键盘（电脑浏览器）

  const inEditable = (target) => !!target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');

  document.addEventListener('keydown', (e) => {
    if (el.app.hidden) return;
    // 弹出层（面板、菜单、对话框）打开时按键不发给电脑，Esc 关掉最上面那一层
    const top = topOverlay();
    if (top) {
      if (e.key === 'Escape') {
        e.preventDefault();
        top();
      }
      return;
    }
    if (inEditable(e.target)) return;
    if (!isLive() || e.isComposing || IGNORED_KEYS.has(e.key) || BROWSER_KEYS.has(e.key)) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const mods = (ctrl ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0);

    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      sendInput({ t: 'k', k: e.key, m: mods });
      return;
    }
    if (e.key.length !== 1) return;
    if (ctrl && !e.altKey && e.key.toLowerCase() === 'v') return; // 交给 paste 事件：粘贴的是本机剪贴板里的文字
    e.preventDefault();
    if ((ctrl || e.altKey) && !(e.ctrlKey && e.altKey)) {
      sendInput({ t: 'k', k: e.key, m: mods }); // 快捷键，如 Ctrl+A
    } else {
      sendInput({ t: 't', s: e.key }); // 普通字符（Ctrl+Alt 同按是 AltGr，也当字符处理）
    }
  });

  document.addEventListener('paste', (e) => {
    // 剪贴板里有图片（比如截图）：在页面任何地方粘贴，包括输入框里，都发到远程窗口
    const file = !el.app.hidden && !topOverlay() && clipboardImage(e);
    if (file) {
      e.preventDefault();
      sendImage(file);
      return;
    }
    // 弹出层（面板、菜单、对话框）开着时文字也不发给电脑，和按键一样
    if (el.app.hidden || topOverlay() || inEditable(e.target) || !isLive()) return;
    const s = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!s) return;
    e.preventDefault();
    sendInput({ t: 't', s });
  });

  // ---------------------------------------------------------------- 发图片（协议文档 4.5）

  const IMAGE_MAX_EDGE = 2048;
  const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
  const PNG_LIMIT = 6 * 1024 * 1024;
  const IMAGE_CHUNK = 16 * 1024;
  const MAX_BUFFERED = 256 * 1024;
  const IMAGE_REPLY_TIMEOUT_MS = 20000;
  let uploading = false;

  function clipboardImage(e) {
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    return item ? item.getAsFile() : null;
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /** 按拍摄方向转正、长边缩到 2048 以内、重新编码：PNG 保持 PNG（太大才转 JPEG），其它转 JPEG */
  async function prepareImage(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    let blob = file.type === 'image/png' ? await canvasBlob(canvas, 'image/png') : null;
    if (!blob || blob.size > PNG_LIMIT) {
      // JPEG 没有透明通道：在图片下面垫一层白色，透明处才不会变黑
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      blob = await canvasBlob(canvas, 'image/jpeg', 0.85);
    }
    if (!blob) throw new Error('编码失败');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
  }

  function waitBuffered(channel) {
    if (channel.bufferedAmount <= MAX_BUFFERED) return Promise.resolve();
    return new Promise((resolve) => {
      channel.bufferedAmountLowThreshold = MAX_BUFFERED / 2;
      channel.addEventListener('bufferedamountlow', resolve, { once: true });
      channel.addEventListener('close', resolve, { once: true });
    });
  }

  function showUpload(text) {
    el.btnImage.textContent = text || '图片';
    el.btnImage.disabled = !!text;
  }

  async function sendImage(file) {
    if (uploading) return toast('上一张图片还在发送');
    if (!isLive()) return toast('还没有连上画面');
    uploading = true;
    showUpload('处理中');
    try {
      let img;
      try {
        img = await prepareImage(file);
      } catch {
        return toast('读取图片失败');
      }
      if (img.bytes.length > IMAGE_MAX_BYTES) return toast('图片太大了');
      toast(await transferImage(img.bytes, img.mime));
    } finally {
      uploading = false;
      showUpload(null);
    }
  }

  async function transferImage(bytes, mime) {
    const channel = dc;
    if (!isLive()) return '还没有连上画面';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let done;
    const reply = new Promise((resolve) => { done = resolve; });
    imageWaiters.set(id, done);
    try {
      channel.send(JSON.stringify({ t: 'img', id, mime, size: bytes.length }));
      for (let offset = 0; offset < bytes.length; offset += IMAGE_CHUNK) {
        await waitBuffered(channel);
        if (dc !== channel || channel.readyState !== 'open') return ERROR_TEXT.closed;
        channel.send(bytes.subarray(offset, Math.min(offset + IMAGE_CHUNK, bytes.length)));
        const sent = Math.min(offset + IMAGE_CHUNK, bytes.length);
        showUpload(Math.floor((sent / bytes.length) * 100) + '%');
      }
      channel.send(JSON.stringify({ t: 'img-end', id }));
      showUpload('粘贴中');
      const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), IMAGE_REPLY_TIMEOUT_MS));
      const code = await Promise.race([reply, timer]);
      if (code === 'ok') return '图片已粘贴到输入框';
      if (code === 'timeout') return '电脑没有回应，电脑上的被控端可能需要更新';
      return ERROR_TEXT[code] || '图片没能粘贴（' + code + '）';
    } catch {
      return ERROR_TEXT.closed;
    } finally {
      imageWaiters.delete(id);
    }
  }

  el.btnImage.addEventListener('click', () => el.imageFile.click());
  el.imageFile.addEventListener('change', () => {
    const file = el.imageFile.files && el.imageFile.files[0];
    el.imageFile.value = '';
    if (file) sendImage(file);
  });

  // ---------------------------------------------------------------- 按键栏、字体大小与输入框（手机）

  // 按键栏和"字体大小"那一条上的按钮都是发一个按键事件（data-k 是键，data-m 是修饰键）。
  // "字体大小"按的是 Claude 桌面端自己的缩放快捷键：Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 还原，
  // 电脑上所有 Claude 窗口一起变，和安卓端的做法一样（docs/04-android-client.md 的"字体大小"）
  for (const bar of [el.keys, el.fontBar]) {
    // 点的时候不要抢走输入框的焦点，否则手机软键盘会收起
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-k]');
      if (!btn) return;
      if (!sendInput({ t: 'k', k: btn.dataset.k, m: Number(btn.dataset.m) || 0 })) toast('还没有连上画面');
    });
  }

  function autosize() {
    el.text.style.height = 'auto';
    el.text.style.height = Math.min(el.text.scrollHeight + 2, 112) + 'px';
  }

  function sendText(withEnter) {
    if (!isLive()) {
      toast('还没有连上画面');
      return;
    }
    const s = el.text.value;
    if (s) sendInput({ t: 't', s });
    if (withEnter) sendInput({ t: 'k', k: 'Enter', m: 0 });
    el.text.value = '';
    autosize();
  }

  el.text.addEventListener('input', autosize);
  el.text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendText(true);
    }
  });
  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendText(true);
  });
  $('btnType').addEventListener('click', () => sendText(false));
  // 按键栏默认收起（安卓端 0.9.2 起也不显示），从菜单里叫出来；开着还是收着记在本浏览器里
  el.keys.hidden = store.get('rc.keys') !== '1';
  el.btnKeys.addEventListener('click', () => {
    closeMenu();
    el.keys.hidden = !el.keys.hidden;
    store.set('rc.keys', el.keys.hidden ? '0' : '1');
    layout();
  });
  // "字体大小"那一条：从菜单里叫出来，调完点"完成"收起，不记
  $('btnFont').addEventListener('click', () => {
    closeMenu();
    el.fontBar.hidden = false;
    layout();
  });
  $('btnFontDone').addEventListener('click', () => {
    el.fontBar.hidden = true;
    layout();
  });

  // ---------------------------------------------------------------- 审批和提问（协议文档 2.7，docs/09）

  /** 电脑 id -> 这台电脑上全部等待中的审批（已整理，见 approvals.js 的 normalize） */
  const approvalsByHost = new Map();
  /** 已提交、等电脑回执的审批 id */
  const answering = new Set();
  let approvalSeq = 0;
  /** 审批 id -> 等回执的定时器 */
  const answerTimers = new Map();
  const ANSWER_REPLY_TIMEOUT_MS = 20000;
  /** 从通知打开时要找的那一条：{ id, timer, deadline }，可能还没连上服务器、审批列表还没推过来 */
  let pendingFocus = null;
  const PENDING_FOCUS_MS = 10000;
  /** 还没登录、没连上时，从通知带来的那一条最多留这么久 */
  const PENDING_FOCUS_MAX_MS = 60000;
  /** 连上服务器以后至少等这么久，电脑的审批列表才算推过来了 */
  const APPROVALS_SETTLE_MS = 5000;
  let authedAt = 0;

  const approvalPanel = RcApprovals.createPanel({ list: el.apprList, onAnswer: answerApproval, copy: copyText });

  /** 所有在线电脑的审批合在一起，按出现时间排 */
  function approvalEntries() {
    const out = [];
    for (const [hid, items] of approvalsByHost) {
      const h = hosts.find((x) => x.id === hid);
      const name = h ? h.name : '电脑';
      for (const item of items) out.push({ hostId: hid, hostName: name, item });
    }
    return out.sort((a, b) => a.item.createdAt - b.item.createdAt);
  }

  function publishApprovals() {
    const entries = approvalEntries();
    const ids = new Set(entries.map((e) => e.item.id));
    for (const id of [...answering]) if (!ids.has(id)) answering.delete(id);
    const manyHosts = new Set(entries.map((e) => e.hostId)).size > 1;
    approvalPanel.update(entries, { manyHosts, answering });
    const n = entries.length;
    el.apprTitle.textContent = n ? `等你处理（${n}）` : '等你处理';
    el.apprEmpty.hidden = n > 0;
    el.btnAppr.hidden = n === 0;
    el.apprCount.textContent = String(n);
    document.title = n ? `(${n}) RemoteClaude` : 'RemoteClaude';
    // 都处理完了就收起面板
    if (!n && !el.approvals.hidden && !pendingFocus) closeApprovals();
    tryPendingFocus(false);
    renderHostUi();
  }

  function openApprovals() {
    closeMenu();
    publishApprovals();
    el.approvals.hidden = false;
  }

  function closeApprovals() {
    el.approvals.hidden = true;
  }

  /**
   * 回答一条审批：choice 是 allow 或 deny，拒绝时 text 是说明；回答提问时 answers 是
   * 问题原文 -> 选项或自己填的文字（多选给数组）。格式和安卓端 Protocol.approvalAnswer 一样
   */
  function answerApproval(hid, id, choice, text, answers) {
    if (!authed || !ws || ws.readyState !== WebSocket.OPEN) {
      toast('与服务器的连接断开了，等重连后再答');
      return;
    }
    const msg = { type: 'approval-answer', host: hid, id, req: `a${++approvalSeq}`, choice, text: text || '' };
    if (answers) msg.answers = answers;
    send(msg);
    answering.add(id);
    clearTimeout(answerTimers.get(id));
    // 电脑一直不回执（旧版被控端、消息丢了）：按钮回来，让用户能再答一次
    answerTimers.set(id, setTimeout(() => {
      answerTimers.delete(id);
      if (!answering.delete(id)) return;
      publishApprovals();
      toast('没收到电脑的确认，可以再答一次');
    }, ANSWER_REPLY_TIMEOUT_MS));
    publishApprovals();
  }

  /** 下线、退出登录的电脑：它推过的审批和状态作废 */
  function pruneOfflineHosts() {
    for (const id of [...approvalsByHost.keys(), ...hostStates.keys()]) {
      if (!hosts.some((h) => h.id === id && h.online)) {
        approvalsByHost.delete(id);
        hostStates.delete(id);
      }
    }
    publishApprovals();
  }

  function onApprovalResult(msg) {
    if (typeof msg.id !== 'string') return;
    answering.delete(msg.id);
    clearTimeout(answerTimers.get(msg.id));
    answerTimers.delete(msg.id);
    publishApprovals();
    if (msg.ok === true) return; // 电脑随后推来的新列表里就没有这一条了
    toast(msg.code === 'gone' ? '这个审批已经在别处答了或已经结束'
      : msg.code === 'bad' ? '答案不完整，请每个问题都选一下'
        : `没能提交（${msg.code || '未知错误'}）`);
  }

  /** 从通知打开：等这一条出现就打开面板并滚到它；一直没出现就如实提示 */
  function focusApprovalWhenReady(id) {
    if (pendingFocus) clearTimeout(pendingFocus.timer);
    pendingFocus = { id, timer: setTimeout(() => tryPendingFocus(true), PENDING_FOCUS_MS), deadline: Date.now() + PENDING_FOCUS_MAX_MS };
    tryPendingFocus(false);
  }

  function tryPendingFocus(final) {
    if (!pendingFocus) return;
    const { id, timer, deadline } = pendingFocus;
    // 还没登录、没连上服务器，或刚连上电脑还没推列表：再等等，不要说"已经结束"
    const settled = token && authed && Date.now() - authedAt >= APPROVALS_SETTLE_MS;
    if (final && !settled) {
      if (Date.now() < deadline) {
        pendingFocus.timer = setTimeout(() => tryPendingFocus(true), PENDING_FOCUS_MS / 2);
        return;
      }
      pendingFocus = null;
      if (token) toast('还没连上服务器，审批列表等连上后在"审批"里看');
      return;
    }
    if (!token) return;
    const entries = approvalEntries();
    if (entries.some((e) => e.item.id === id)) {
      clearTimeout(timer);
      pendingFocus = null;
      closePicker();
      openApprovals();
      approvalPanel.focus(id);
      return;
    }
    if (!final) return;
    pendingFocus = null;
    if (entries.length) {
      openApprovals();
      toast('这条已经处理过了，下面是其它等你处理的');
    } else {
      toast('这条审批已经在别处答了或已经结束');
    }
  }

  /** 复制到手机剪贴板。页面不是 https 打开时没有 navigator.clipboard，退回到老办法 */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
      return;
    } catch { /* 退回到下面 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'offscreen';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    toast(ok ? '已复制' : '没能复制，请长按文字手动复制');
  }

  el.btnAppr.addEventListener('click', openApprovals);
  $('apprClose').addEventListener('click', closeApprovals);
  el.approvals.addEventListener('click', (e) => {
    if (e.target === el.approvals) closeApprovals();
  });
  // 卡片上的时间（"5 分钟前"）每分钟更新一次
  setInterval(() => { if (!el.approvals.hidden) publishApprovals(); }, 60000);

  // ---------------------------------------------------------------- 电脑锁屏、锁定与解锁（协议文档 4.6、2.9）

  /** 退出登录、和服务器断开时：电脑推过的状态作废；审批在断开时先留着（keepApprovals） */
  function forgetHostData({ keepApprovals = false } = {}) {
    if (!keepApprovals) approvalsByHost.clear();
    hostStates.clear();
    answering.clear();
    for (const t of answerTimers.values()) clearTimeout(t);
    answerTimers.clear();
    hostTooOld = false;
    for (const w of [...cmdWaiters.values()]) w.done('closed');
    publishApprovals();
  }

  /**
   * 电脑报来的锁屏状态（host-state 的 lock、数据通道的 lock 消息）。untrusted：电脑上有解锁服务在跑，
   * 但被控端核实不过它（多半是旧版服务，被控端自动升级了、服务没升级），这时 unlock 是 false。
   * saved：电脑记着上次解锁的密码（被控端 0.9.32 起，协议文档 2.9"记住解锁密码"），只在解锁服务能用时算数
   */
  function lockFrom(m) {
    const o = m && typeof m === 'object' ? m : {};
    const unlock = o.unlock === true;
    return { locked: o.locked === true, unlock, untrusted: !unlock && o.untrusted === true, saved: unlock && o.saved === true };
  }

  /** 锁着但不能从这里解锁时的说明 */
  function noUnlockText(lock) {
    return lock && lock.untrusted
      ? '电脑上的解锁服务要重新安装（版本太旧或没通过核实），现在要回到电脑前解锁'
      : '电脑上没装解锁服务，要回到电脑前解锁';
  }

  /** 当前电脑的锁屏状态：连着画面时以数据通道上的为准，否则用 host-state 的；都没有时返回 null */
  function lockInfo() {
    if (isLive() && peerLock) return peerLock;
    const st = hostId && hostStates.get(hostId);
    return st ? st.lock : null;
  }

  /** 右上角菜单里锁定那一项（同安卓 windows/HostCommands.kt 的 menu） */
  function lockMenu() {
    const online = authed && hostOnline();
    const commands = !!hostId && hostStates.has(hostId);
    const ready = online && (commands || isLive());
    const lock = lockInfo() || { locked: false, unlock: false };
    let note = '';
    if (!hostId) note = '还没有选电脑';
    else if (!online) note = '这台电脑不在线';
    else if (!ready) {
      note = hostTooOld ? `不打开会话窗口就锁定、解锁，要电脑上的被控端 ${HOST_CMD_MIN_VERSION} 或更新的版本；升级之前请先打开一个会话窗口`
        : '正在等电脑报告状态…';
    } else if (lock.locked && !lock.unlock) note = noUnlockText(lock);
    return { show: !!hostId, unlock: lock.locked, enabled: ready && (!lock.locked || lock.unlock) && !unlocking, note };
  }

  let bannerSig = '';

  /** 顶栏下面（和会话选择面板里）的提示条：有审批在等、电脑锁屏了；顺带更新菜单 */
  function renderHostUi() {
    const entries = approvalEntries();
    const lock = authed && hostOnline() ? lockInfo() : null;
    const sig = JSON.stringify([entries.map((e) => [e.item.id, e.item.title, e.item.tool, e.item.kind]), lock, unlocking]);
    if (sig !== bannerSig) {
      bannerSig = sig;
      for (const box of [el.banners, el.pickerBanners]) {
        box.textContent = '';
        if (entries.length) box.append(approvalBanner(entries));
        if (lock && lock.locked) box.append(lockBanner(lock));
      }
    }
    if (!el.menuLayer.hidden) renderMenu();
  }

  function span(cls, text) {
    const s = document.createElement(cls === 'strong' ? 'strong' : 'span');
    if (cls !== 'strong') s.className = cls;
    s.textContent = text;
    return s;
  }

  function approvalBanner(entries) {
    const first = entries[0].item;
    const n = entries.length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'banner warn';
    const text = span('banner-text', '');
    text.append(
      span('strong', n > 1 ? `有 ${n} 个审批等你处理` : first.kind === 'ask' ? 'Claude 在问你' : `Claude 要审批 ${first.tool || '工具'}`),
      span('muted', first.title),
    );
    b.append(text, span('banner-act', '处理'));
    b.addEventListener('click', openApprovals);
    return b;
  }

  function lockBanner(lock) {
    const box = document.createElement('div');
    box.className = 'banner bad';
    const text = span('banner-text', '');
    text.append(span('strong', '电脑已锁屏'), span('muted', lock.unlock ? '解锁后才能操作' : noUnlockText(lock)));
    box.append(text);
    if (lock.unlock) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'primary';
      b.textContent = unlocking ? '解锁中…' : '解锁';
      b.disabled = unlocking;
      b.addEventListener('click', startUnlock);
      box.append(b);
    }
    return box;
  }

  function renderMenu() {
    const m = lockMenu();
    const h = currentHost();
    el.menuHost.textContent = h ? `电脑：${h.name}${h.online ? '' : '（离线）'}` : '';
    el.menuHost.hidden = !h;
    el.menuLock.hidden = !m.show;
    el.menuLock.textContent = m.unlock ? (unlocking ? '正在解锁电脑…' : '解锁电脑') : '锁定电脑';
    el.menuLock.disabled = !m.enabled;
    el.menuLockNote.textContent = m.note;
    el.menuLockNote.hidden = !m.show || !m.note;
    renderPrivacyMenu();
    el.menuEmail.textContent = email;
    el.btnKeys.textContent = el.keys.hidden ? '显示按键栏' : '隐藏按键栏';
  }

  /** 菜单挂在点开它的那个"更多"按钮下面（顶栏上的，或会话选择面板里的） */
  function openMenu(e) {
    renderMenu();
    const r = e && e.currentTarget && e.currentTarget.getBoundingClientRect();
    if (r && r.width) {
      const box = el.app.getBoundingClientRect();
      el.menu.style.top = `${Math.round(r.bottom - box.top + 6)}px`;
      el.menu.style.right = `${Math.max(8, Math.round(box.right - r.right))}px`;
    }
    el.menuLayer.hidden = false;
  }

  function closeMenu() {
    el.menuLayer.hidden = true;
  }

  $('btnMore').addEventListener('click', openMenu);
  $('btnMore2').addEventListener('click', openMenu);
  el.menuLayer.addEventListener('click', (e) => {
    if (e.target === el.menuLayer) closeMenu();
  });
  // 菜单的位置是打开时算的，窗口大小一变（转屏、拖窗口）就收起，免得留在不对的地方
  window.addEventListener('resize', closeMenu);
  el.menuLock.addEventListener('click', () => {
    closeMenu();
    const m = lockMenu();
    if (!m.enabled) return;
    if (m.unlock) startUnlock();
    else openLockConfirm();
  });

  /**
   * 菜单里隐私屏、记下的密码那几项（同安卓 ui/HostMenu.kt）。这两个命令只走信令通道的 host-cmd，
   * 要电脑认这种命令（推过 host-state）、在线；隐私屏还要被控端 0.9.32 起（v032，更旧的回 bad-op），
   * 靠解锁服务，装了且核实过、电脑没锁着才显示（锁着时解锁那一下按"解锁时打开隐私屏"自动盖）
   */
  function renderPrivacyMenu() {
    const st = authed && hostOnline() && hostId ? hostStates.get(hostId) : null;
    const lock = st ? lockInfo() : null;
    el.menuPrivacy.hidden = !(st && st.v032 && lock.unlock && !lock.locked);
    el.menuPrivacy.textContent = privacyBusy === true ? '正在打开隐私屏…'
      : privacyBusy === false ? '正在关闭隐私屏…'
        : st && st.privacy ? '关闭隐私屏' : '打开隐私屏';
    el.menuPrivacy.disabled = privacyBusy !== null;
    el.menuForget.hidden = !(lock && lock.saved);
    el.menuForget.textContent = forgetting ? '正在忘掉记下的解锁密码…' : '忘掉记下的解锁密码';
    el.menuForget.disabled = forgetting;
    const on = privacyOnUnlock();
    el.menuPrivacyOnUnlock.setAttribute('aria-checked', String(on));
    el.menuPrivacyOnUnlockState.textContent = on ? '开' : '关';
  }

  el.menuPrivacy.addEventListener('click', () => {
    closeMenu();
    const st = hostId && hostStates.get(hostId);
    setPrivacy(!(st && st.privacy));
  });
  el.menuForget.addEventListener('click', () => {
    closeMenu();
    forgetPassword();
  });
  // 开关一类的设置：点了菜单不收起，看得到变成了什么
  el.menuPrivacyOnUnlock.addEventListener('click', () => {
    const on = !privacyOnUnlock();
    store.set(PRIVACY_ON_UNLOCK_KEY, on ? '1' : '0');
    renderMenu();
    toast(on ? '从这里解锁时，电脑的显示器先盖上黑幕、挡住电脑前的键盘鼠标；不再控制这台电脑时先锁屏再撤掉'
      : '从这里解锁时不再打开隐私屏，电脑前的人能看到桌面');
  });

  /**
   * 给电脑发一条和具体窗口无关的命令。连着画面时走数据通道（旧版被控端只认这条路）；
   * 没连画面时走信令通道的 host-cmd（被控端 0.9.6 起）。发不出去时提示原因，返回 false
   */
  function sendHostCommand(op, peerEvent) {
    if (sendInput(peerEvent)) return true;
    const host = hostCommandTarget();
    if (!host) return false;
    send({ type: 'host-cmd', host, op });
    return true;
  }

  /** 能经信令通道收命令的那台电脑；不行时提示原因，返回 null */
  function hostCommandTarget() {
    if (!hostId || !authed || !hostOnline()) toast('这台电脑不在线');
    else if (hostStates.has(hostId)) return hostId;
    else if (hostTooOld) toast(`电脑上的被控端版本太旧，升级到 ${HOST_CMD_MIN_VERSION} 以后才能在这里操作`);
    else toast('还没收到电脑的状态，稍等再试');
    return null;
  }

  function openLockConfirm() {
    const lock = lockInfo();
    el.lockDlgText.textContent = lock && lock.saved
      ? '效果和在电脑上按 Win+L 一样。电脑记着上次的解锁密码，之后在这里点"解锁"就能解开。'
      : lock && lock.unlock
        ? '效果和在电脑上按 Win+L 一样。之后可以在这里输入 Windows 密码或 PIN 解锁。'
        : lock && lock.untrusted
          ? '效果和在电脑上按 Win+L 一样。这台电脑上的解锁服务要重新安装（版本太旧或没通过核实），锁定后只能回到电脑前解锁。'
          : '效果和在电脑上按 Win+L 一样。这台电脑没装解锁服务，锁定后只能回到电脑前解锁。';
    el.lockDlg.hidden = false;
    $('lockDlgCancel').focus();
  }

  $('lockDlgCancel').addEventListener('click', () => { el.lockDlg.hidden = true; });
  el.lockDlg.addEventListener('click', (e) => {
    if (e.target === el.lockDlg) el.lockDlg.hidden = true;
  });
  $('lockDlgOk').addEventListener('click', () => {
    el.lockDlg.hidden = true;
    // 只在用户明确点了才锁；断开连接、退出登录都不会锁定
    if (sendHostCommand('lock', { t: 'lock-now' })) toast('已发送锁定命令');
  });

  /** 电脑在提示里的叫法：「办公室电脑」，不知道名字时是"这台电脑" */
  function hostLabel(id) {
    const h = hosts.find((x) => x.id === id);
    return h && h.name ? `「${h.name}」` : '这台电脑';
  }

  /**
   * 点了"解锁"：电脑记着密码（lock.saved，协议文档 2.9"记住解锁密码"）就不弹输入框，直接让电脑用记下的解锁，
   * 只试一次、不自动重试（Windows 和解锁服务都限制输错的次数）；没记着就弹输入框
   */
  function startUnlock() {
    if (unlocking || !hostId) return;
    const lock = lockInfo();
    if (lock && lock.saved) unlockPc(hostId, { saved: true });
    else openUnlock('');
  }

  /** 这台电脑的被控端认不认"记住解锁密码"（0.9.32 起）；旧版不认 save，勾了也记不住，就不显示那个勾 */
  function canRemember(id) {
    const st = id && hostStates.get(id);
    return !!st && st.v032;
  }

  /** 弹出输入密码的框，记下是为哪台电脑弹的。note 是框里最上面的提醒（记下的密码不对了），没有时是空串 */
  function openUnlock(note) {
    if (unlocking || !hostId) return;
    unlockFor = hostId;
    el.unlockTitle.textContent = `解锁${hostLabel(hostId)}`;
    el.unlockNote.textContent = note || '';
    el.unlockNote.hidden = !note;
    const remember = canRemember(hostId);
    el.unlockRememberBox.hidden = !remember;
    el.unlockRemember.checked = store.get(REMEMBER_UNLOCK_KEY) !== '0';
    el.unlockHint.textContent = remember ? '输入这台电脑的 Windows 登录密码或 PIN。'
      : '输入这台电脑的 Windows 登录密码或 PIN。只用这一次，手机和电脑都不保存。';
    el.unlockPw.value = '';
    el.unlockDlg.hidden = false;
    el.unlockPw.focus();
  }

  function closeUnlock() {
    el.unlockPw.value = '';
    el.unlockDlg.hidden = true;
    unlockFor = null;
  }

  $('unlockCancel').addEventListener('click', closeUnlock);
  $('unlockOk').addEventListener('click', submitUnlock);
  el.unlockPw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submitUnlock();
    }
  });
  function submitUnlock() {
    const pw = el.unlockPw.value;
    if (!pw) {
      el.unlockPw.focus();
      return;
    }
    const host = unlockFor;
    // 勾没显示（旧版被控端）就不带 save
    const save = el.unlockRememberBox.hidden ? undefined : el.unlockRemember.checked;
    closeUnlock(); // 密码只在这里经过一下，浏览器不保存、不写日志；记不记住由电脑解开以后自己办
    if (!host || host !== hostId) {
      // 框开着的时候换了电脑：输的是原来那台的密码，不能发给现在这台
      toast('选的电脑已经换了，密码没有发出去');
      return;
    }
    if (save !== undefined) store.set(REMEMBER_UNLOCK_KEY, save ? '1' : '0');
    unlockPc(host, { password: pw, save });
  }

  /** 登记一条等回执的命令，返回收到回执时完成的 Promise */
  function waitCmd(id, via) {
    return new Promise((resolve) => {
      cmdWaiters.set(id, { via, done: resolve });
    });
  }

  /** 等 waitCmd 登记的回执，最多等 ms 毫秒。返回错误码，成功时是 'ok'，没等到时是 null */
  async function awaitReply(id, reply, ms) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    const code = await Promise.race([reply, timeout]);
    clearTimeout(timer);
    cmdWaiters.delete(id);
    return code;
  }

  function setUnlocking(on) {
    unlocking = on;
    refreshStatus();
  }

  /**
   * 让电脑 host（就是当前所选的那台）解锁。password 是用户这次输入的 Windows 密码或 PIN，save 是解开以后要不要电脑记住它
   * （被控端 0.9.32 起，false 时电脑把原来记下的也删掉，undefined 时不带、不动）；saved 为 true 时不带密码，让电脑用记下的。
   * 都带上设置"解锁时打开隐私屏"（privacy，docs/11 第 4.4 节）。旧版被控端不认这几个字段，照旧解锁
   */
  async function unlockPc(host, { password = '', save, saved = false } = {}) {
    if (unlocking || (!saved && !password) || !host || host !== hostId) return;
    const id = `u${Date.now().toString(36)}${++cmdSeq}`;
    const privacy = privacyOnUnlock();
    let reply;
    if (isLive()) {
      // 连着画面：走数据通道，端到端加密（协议文档 4.6）
      reply = waitCmd(id, 'peer');
      sendInput(saved ? { t: 'unlock', id, saved: true, privacy } : { t: 'unlock', id, p: password, privacy, save });
    } else {
      // 没连画面：经服务器转发（协议文档 2.9）。用记下的密码时什么都不带，否则先用电脑给的公钥加密
      if (hostCommandTarget() !== host) return;
      const msg = saved
        ? { type: 'host-cmd', host, op: 'unlock', req: id, saved: true, privacy }
        : await sealedUnlock(host, id, password, privacy, save);
      if (!msg) return;
      reply = waitCmd(id, 'server');
      send(msg);
    }
    if (saved) toast(`正在用记下的密码解锁${hostLabel(host)}…`);
    setUnlocking(true);
    const code = await awaitReply(id, reply, UNLOCK_REPLY_TIMEOUT_MS);
    setUnlocking(false);
    if (!token) return; // 退出登录了就不提示
    if (saved && (code === 'saved-wrong' || code === 'no-saved')) {
      // 记下的不对了（电脑已经删掉）、电脑上其实没有：弹输入框让用户手动输。这期间换了电脑就只提示
      if (authed && hostId === host) {
        el.toast.hidden = true;
        openUnlock(ERROR_TEXT[code]);
      } else {
        toast(unlockText(code));
      }
      return;
    }
    toast(unlockText(code)); // 别的错误照常提示，电脑记下的密码留着
  }

  /** 不连画面时的解锁请求：密码用电脑给的公钥加密（unlock.js）。发不了时提示原因、返回 null */
  async function sealedUnlock(host, id, password, privacy, save) {
    const key = hostStates.get(host).key;
    if (!key) {
      toast('电脑上的被控端刚启动，还没准备好，过几秒再试');
      return null;
    }
    setUnlocking(true);
    const r = await RcUnlock.encrypt(key, password);
    if (!r.enc) {
      setUnlocking(false);
      toast(r.code === 'too-long' ? '密码太长，在这里发不了。请打开一个会话窗口，在画面里解锁'
        : r.code === 'no-crypto' ? '浏览器不让在这个页面里加密（要用 https 打开）。请打开一个会话窗口，在画面里解锁'
          : '没能加密密码。请打开一个会话窗口，在画面里解锁');
      return null;
    }
    // 加密要一会儿，这期间可能断开、换了电脑
    if (!authed || hostId !== host || !hostOnline()) {
      setUnlocking(false);
      toast('这台电脑不在线');
      return null;
    }
    return { type: 'host-cmd', host, op: 'unlock', req: id, enc: r.enc, privacy, save };
  }

  /**
   * 开、关隐私屏（host-cmd 的 privacy，被控端 0.9.32 起，docs/11 第 4.4 节）：开是电脑的显示器盖上黑幕、挡住电脑前的键盘鼠标，
   * 关只撤黑幕、不锁屏。只走信令通道，等回执；开着没有以电脑随后推来的 host-state 为准（同安卓 RemoteController.setPrivacy）
   */
  async function setPrivacy(on) {
    if (privacyBusy !== null) return;
    const host = hostCommandTarget();
    if (!host) return;
    const req = `p${Date.now().toString(36)}${++cmdSeq}`;
    const reply = waitCmd(req, 'server');
    send({ type: 'host-cmd', host, op: 'privacy', req, on });
    privacyBusy = on;
    renderHostUi();
    const code = await awaitReply(req, reply, HOST_CMD_REPLY_TIMEOUT_MS);
    privacyBusy = null;
    renderHostUi();
    if (token) toast(privacyText(on, code));
  }

  /** 开关隐私屏的回执对应的提示；code 为 null 表示没等到回执 */
  function privacyText(on, code) {
    if (code === 'ok') return on ? '已打开隐私屏：电脑的显示器盖上了黑幕' : '已关闭隐私屏';
    if (code === null) return '电脑没有回应';
    if (code === 'closed') return on ? '连接断开了，不知道隐私屏打开了没有' : '连接断开了，不知道隐私屏关掉了没有';
    if (code === 'bad-op') return '电脑上的被控端太旧，不支持隐私屏，请升级';
    return on ? '隐私屏没打开，电脑上的解锁服务可能要重新安装' : '隐私屏没关掉';
  }

  /** 让电脑忘掉记下的解锁密码（host-cmd 的 forget-password，被控端 0.9.32 起）。删掉以后电脑会推来不带 saved 的状态 */
  async function forgetPassword() {
    if (forgetting) return;
    const host = hostCommandTarget();
    if (!host) return;
    const req = `f${Date.now().toString(36)}${++cmdSeq}`;
    const reply = waitCmd(req, 'server');
    send({ type: 'host-cmd', host, op: 'forget-password', req });
    forgetting = true;
    renderHostUi();
    const code = await awaitReply(req, reply, HOST_CMD_REPLY_TIMEOUT_MS);
    forgetting = false;
    renderHostUi();
    if (!token) return;
    toast(code === 'ok' ? `${hostLabel(host)}不再记着解锁密码了，下次解锁要重新输入`
      : code === null ? '电脑没有回应'
        : code === 'closed' ? '连接断开了，不知道电脑删掉了没有'
          : code === 'bad-op' ? '电脑上的被控端太旧，请升级'
            : '没能忘掉记下的解锁密码');
  }

  /** 解锁回执对应的提示；code 为 null 表示没等到回执（同安卓 HostCommands.unlockText） */
  function unlockText(code) {
    if (code === null) return '电脑没有回应，电脑上的被控端可能需要更新';
    if (code === 'ok') return '电脑已解锁';
    if (code === 'closed') return '连接断开了，不知道电脑解锁了没有';
    // 被控端重启后换了密钥，这里手里的还是旧的；新的随后会推过来
    if (code === 'bad-key' || code === 'replayed') return '电脑上的被控端刚重启过，请再试一次';
    return ERROR_TEXT[code] || `解锁失败（${code}）`;
  }

  // ---------------------------------------------------------------- 手机壳的接口（鸿蒙 App 注入 window.RemoteClaudeNative）
  // getPushToken() -> 推送令牌，还没拿到时是空串；consumeLaunchIntent() -> 空串，或点通知打开时的 {"approvalId":"…"}。
  // 普通浏览器里没有这个对象，下面的都不做。

  const PUSH_POLL_MS = 3000;
  let pushToken = '';
  /** 在哪条信令连接上用哪个令牌注册过：每次重连都要再注册一次 */
  let pushSent = { sock: null, token: '' };
  let pushPollTimer = null;

  function nativeShell() {
    try {
      const n = window.RemoteClaudeNative;
      return n && (typeof n === 'object' || typeof n === 'function') ? n : null;
    } catch {
      return null;
    }
  }

  /** 调手机壳的一个方法，返回字符串；没有这个方法、出错时返回空串。同步、异步返回都认 */
  async function callNative(name) {
    const n = nativeShell();
    if (!n || typeof n[name] !== 'function') return '';
    try {
      const v = await n[name]();
      return typeof v === 'string' ? v.trim() : '';
    } catch {
      return '';
    }
  }

  /** 拿到推送令牌、连着服务器、这条连接上还没注册过这个令牌时，发 push-register */
  async function syncPush() {
    if (!nativeShell()) return;
    const t = await callNative('getPushToken');
    if (t) pushToken = t;
    if (!pushToken || !authed || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (pushSent.sock === ws && pushSent.token === pushToken) return;
    send({ type: 'push-register', platform: 'harmony', token: pushToken });
    pushSent = { sock: ws, token: pushToken };
  }

  /** 令牌可能过一会儿才到：没拿到之前每几秒问一次 */
  function startPushPoll() {
    clearInterval(pushPollTimer);
    if (!nativeShell()) return;
    pushPollTimer = setInterval(async () => {
      await syncPush();
      if (pushToken) {
        clearInterval(pushPollTimer);
        pushPollTimer = null;
      }
    }, PUSH_POLL_MS);
  }

  /** 退出登录前告诉服务器别再往这台手机推 */
  function unregisterPush() {
    if (pushToken && authed) send({ type: 'push-unregister', token: pushToken });
    pushSent = { sock: null, token: '' };
  }

  /** 点通知打开 App 时，打开审批面板并找到那一条 */
  async function checkLaunchIntent() {
    const raw = await callNative('consumeLaunchIntent');
    if (!raw) return;
    let intent = null;
    try { intent = JSON.parse(raw); } catch { return; }
    if (intent && typeof intent.approvalId === 'string' && intent.approvalId) focusApprovalWhenReady(intent.approvalId);
  }

  // ---------------------------------------------------------------- 弹出层

  /** 最上面那一层弹出的东西的关闭函数；没有时返回 null */
  function topOverlay() {
    if (!el.unlockDlg.hidden) return closeUnlock;
    if (!el.lockDlg.hidden) return () => { el.lockDlg.hidden = true; };
    if (!el.menuLayer.hidden) return closeMenu;
    if (!el.approvals.hidden) return closeApprovals;
    if (!el.picker.hidden) return closePicker;
    return null;
  }

  function closeOverlays() {
    closeUnlock();
    el.lockDlg.hidden = true;
    closeMenu();
    closeApprovals();
  }

  // ---------------------------------------------------------------- 杂项

  // 手机软键盘弹出时，把界面高度收到可视区域内，让输入框停在键盘上方
  function fitViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    window.scrollTo(0, 0);
    layout();
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }

  // 看画面时不让手机自动息屏
  let wakeLock = null;
  async function keepAwake() {
    if (!navigator.wakeLock || wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* 省电模式下会被拒绝，无妨 */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // 藏在后台时没要的窗口列表，现在要；还没连上服务器就等连上时再要（auth-ok）
    if (listWhenVisible && authed) requestList();
    if (isLive()) keepAwake();
    checkLaunchIntent();
    syncPush();
  });

  $('menuLogout').addEventListener('click', () => {
    closeMenu();
    unregisterPush();
    const old = signOut('');
    if (old) api('logout', {}, old).catch(() => {});
  });

  // 被控端上"注册账号""忘记密码"的链接会带 #register、#forgot 打开这里
  const hashMode = location.hash === '#register' ? 'register' : location.hash === '#forgot' ? 'forgot' : null;
  if (token && !hashMode) {
    el.accountEmail.textContent = email;
    showApp();
    refreshStatus();
    connect();
  } else {
    showAuth(hashMode || 'login');
  }
  startPushPoll();
  checkLaunchIntent();
})();
