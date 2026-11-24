'use strict';
/**
 * RemoteClaude 网页控制端
 *
 * 账号（注册、登录、找回密码）走 HTTP 接口 api/auth/...；
 * 信令（列窗口、选窗口、WebRTC 协商）走 WebSocket，发给电脑的消息都带上 host（要操作哪台电脑）；
 * 画面走 WebRTC 视频轨道，鼠标键盘事件走 WebRTC 数据通道。协议见 docs/03-protocol.md。
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
    btnMore: $('btnMore'), menu: $('menu'), menuItems: $('menuItems'), btnKeys: $('btnKeys'),
  };

  const PROTO = 2;
  const CLIENT = 'web/0.4.0';
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
  };
  /** 图片 id -> 收到回执时调用，参数是错误码，成功时是 'ok'（协议文档 4.5） */
  const imageWaiters = new Map();
  const WHEEL_PER_PIXEL = 1.2; // 浏览器滚轮一格约 100 像素，对应 Windows 的 120

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式下可能不可用 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

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
    const old = token;
    token = null;
    store.del('rc.token');
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    authed = false;
    current = null;
    hosts = [];
    windows = [];
    closePeer();
    closePicker();
    el.menu.hidden = true;
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
  }

  // ---------------------------------------------------------------- 信令

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /** 发给当前所选电脑的消息 */
  function sendHost(obj) {
    if (hostId) send({ ...obj, host: hostId });
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
      // 服务器会通知电脑这个控制端已离开，画面连接随之作废
      closePeer();
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
    closePeer();
    current = null;
    windows = [];
    hostId = id;
    if (id) store.set('rc.host', id);
    else store.del('rc.host');
    wantHwnd = 0;
    store.del('rc.hwnd');
  }

  async function onMessage(msg) {
    // 电脑发来的消息只处理当前所选的那台
    if (typeof msg.host === 'string' && msg.type !== 'error' && msg.host !== hostId) return;

    switch (msg.type) {
      case 'auth-ok':
        authed = true;
        retry = 1000;
        iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
        hosts = Array.isArray(msg.hosts) ? msg.hosts : [];
        if (msg.email) {
          email = msg.email;
          store.set('rc.email', email);
        }
        el.accountEmail.textContent = email;
        chooseHost();
        showApp();
        renderHostTabs();
        refreshStatus();
        if (hostOnline()) sendHost({ type: 'list' });
        else if (hosts.length) openPicker();
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
        if (hostId && !hosts.some((h) => h.id === hostId)) setHost(null);
        chooseHost();
        renderHostTabs();
        if (wasOnline && !hostOnline()) closePeer();
        if (hostOnline() && (!wasOnline || !windows.length)) sendHost({ type: 'list' });
        if (!el.picker.hidden) renderList();
        refreshStatus();
        break;
      }

      case 'windows':
        windows = Array.isArray(msg.list) ? msg.list : [];
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
    if (el.app.hidden || inEditable(e.target)) return;
    if (!el.picker.hidden) {
      if (e.key === 'Escape') closePicker();
      return;
    }
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
    const file = !el.app.hidden && clipboardImage(e);
    if (file) {
      e.preventDefault();
      sendImage(file);
      return;
    }
    if (el.app.hidden || inEditable(e.target) || !isLive()) return;
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
  // ---------------------------------------------------------------- "更多"菜单

  // 顶栏右边的"⋮"：按键栏、字体大小、退出登录。手机上顶栏放不下这么多按钮，会话标题会被挤得只剩两三个字
  function closeMenu() {
    el.menu.hidden = true;
  }
  el.btnMore.addEventListener('click', () => {
    el.btnKeys.textContent = el.keys.hidden ? '显示按键栏' : '隐藏按键栏';
    // 菜单贴在"⋮"按钮下面、和它右边对齐
    const r = el.btnMore.getBoundingClientRect();
    el.menuItems.style.top = r.bottom + 4 + 'px';
    el.menuItems.style.right = Math.max(8, el.app.clientWidth - r.right) + 'px';
    el.menu.hidden = false;
  });
  el.menu.addEventListener('click', (e) => {
    if (e.target === el.menu) closeMenu();
  });
  // 菜单的位置是打开时算的，窗口大小一变（转屏、拖窗口）就收起，免得留在不对的地方
  window.addEventListener('resize', closeMenu);

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
    if (document.visibilityState === 'visible' && isLive()) keepAwake();
  });

  $('btnLogout').addEventListener('click', () => {
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
})();
