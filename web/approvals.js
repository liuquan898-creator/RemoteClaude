'use strict';
/**
 * 审批面板（协议文档 2.7，docs/09 第 6 节）：电脑上的 Claude Code 等着审批工具调用、或者用 AskUserQuestion 提问时，
 * 在这里作答。和安卓端 ui/ApprovalsSheet.kt、ui/CodeSpans.kt 的做法一致。
 *
 * 只管画卡片和收集答案；消息的收发、按电脑合并列表在 app.js。卡片按 id 复用：电脑推来新列表时，
 * 还在的卡片原样保留（正在填的文字、选中的选项不会丢），没了的拿掉，新的插进来。
 *
 * window.RcApprovals.normalize(raw)        把被控端推来的一条整理成固定的字段，格式不对返回 null
 * window.RcApprovals.splitCode(text)       按 Markdown 反引号拆成 [{ code: bool, text }]
 * window.RcApprovals.createPanel(opts)     opts: { list, onAnswer(hostId, id, choice, text, answers), copy(text) }
 *   panel.update(entries, { manyHosts, answering })   entries: [{ hostId, hostName, item }]，answering: 已提交、等回执的 id 集合
 *   panel.focus(id)                                  滚到这一条并闪一下；没有这一条返回 false
 */
(() => {
  const str = (v) => (typeof v === 'string' ? v : '');
  const arr = (v) => (Array.isArray(v) ? v : []);
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  /** 计划审批（插件把 ExitPlanMode 显示成"计划"，docs/09 第 3 节） */
  const isPlan = (item) => item.tool === '计划' || item.tool === 'ExitPlanMode';

  function normalize(raw) {
    if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null;
    return {
      id: raw.id,
      kind: raw.kind === 'ask' ? 'ask' : 'permission',
      title: str(raw.title),
      cwd: str(raw.cwd),
      agent: str(raw.agent),
      tool: raw.tool === 'ExitPlanMode' ? '计划' : str(raw.tool),
      description: str(raw.description),
      params: arr(raw.params).filter(isObj).map((p) => ({ key: str(p.key), value: str(p.value) })),
      complete: raw.complete !== false,
      questions: arr(raw.questions).filter(isObj).map((q) => ({
        question: str(q.question),
        header: str(q.header),
        multiSelect: q.multiSelect === true,
        options: arr(q.options).filter(isObj).map((o) => ({ label: str(o.label), description: str(o.description) })),
      })),
      createdAt: Number(raw.createdAt) || 0,
    };
  }

  // ---------------------------------------------------------------- 反引号括起来的命令（CodeSpans.kt 的移植）

  function runLength(s, from) {
    let n = 0;
    while (from + n < s.length && s[from + n] === '`') n++;
    return n;
  }

  /** 找长度正好是 n 的一串反引号；更长或更短的串跳过 */
  function findClose(s, from, n) {
    let j = from;
    while (j < s.length) {
      const k = s.indexOf('`', j);
      if (k < 0) return -1;
      const r = runLength(s, k);
      if (r === n) return k;
      j = k + r;
    }
    return -1;
  }

  /** 代码块：第一行是语言名（或空）就去掉，再去掉首尾换行 */
  function fencedBody(raw) {
    let body = raw;
    const nl = body.indexOf('\n');
    if (nl >= 0 && !/\s/.test(body.slice(0, nl).trim())) body = body.slice(nl + 1);
    return body.replace(/^[\r\n]+|[\r\n]+$/g, '');
  }

  /** 行内代码：两头各有一个空格时各去掉一个（和 Markdown 一样） */
  function inlineBody(raw) {
    return raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() ? raw.slice(1, -1) : raw;
  }

  function splitCode(s) {
    const out = [];
    let plain = '';
    const flush = () => {
      if (plain) out.push({ code: false, text: plain });
      plain = '';
    };
    let i = 0;
    while (i < s.length) {
      if (s[i] !== '`') {
        plain += s[i];
        i++;
        continue;
      }
      const n = runLength(s, i);
      const close = findClose(s, i + n, n);
      if (close < 0) {
        plain += s.slice(i, i + n);
        i += n;
        continue;
      }
      const inner = s.slice(i + n, close);
      const body = n >= 3 ? fencedBody(inner) : inlineBody(inner);
      if (!body.trim()) {
        plain += s.slice(i, close + n);
      } else {
        flush();
        out.push({ code: true, text: body });
      }
      i = close + n;
    }
    flush();
    return out;
  }

  // ---------------------------------------------------------------- 小工具

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(text, cls, onClick) {
    const b = h('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /** 刚刚、5 分钟前、3 小时前、昨天、11月12日（同安卓 TimeText.ago） */
  function ago(at, now) {
    if (!at) return '';
    const diff = now - at;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    const then = new Date(at);
    const today = new Date(now);
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(then, today)) return `${Math.floor(diff / 3600000)} 小时前`;
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (sameDay(then, y)) return '昨天';
    const md = `${then.getMonth() + 1}月${then.getDate()}日`;
    return then.getFullYear() === today.getFullYear() ? md : `${then.getFullYear()}年${md}`;
  }

  // ---------------------------------------------------------------- 面板

  function createPanel({ list, onAnswer, copy }) {
    /** id -> { el, item, hostId, sig, setBusy, setHead } */
    const cards = new Map();

    /** 参数：等宽字体，旁边"复制"；长的先折起来 */
    function paramView(key, value, plan) {
      const box = h('div', 'appr-param');
      const head = h('div', 'appr-param-head');
      head.append(h('span', 'appr-key', key), button('复制', 'link', () => copy(value)));
      const pre = h('pre', plan ? 'appr-value plan' : 'appr-value', value);
      box.append(head, pre);
      const lines = value.split('\n').length;
      const long = plan ? value.length > 1200 || lines > 20 : value.length > 400 || lines > 8;
      if (long) {
        pre.classList.add('folded');
        const more = button('展开全部', 'link appr-more', () => {
          const folded = pre.classList.toggle('folded');
          more.textContent = folded ? '展开全部' : '收起';
        });
        box.append(more);
      }
      return box;
    }

    /** 问题原文：反引号括起来的部分单独一块，带"复制"（docs/09 第 6 节） */
    function textWithCode(text) {
      const box = h('div', 'appr-question');
      for (const part of splitCode(text)) {
        if (!part.code) {
          const t = part.text.trim();
          if (t) box.append(h('p', 'appr-qtext', t));
          continue;
        }
        const row = h('div', 'appr-code');
        row.append(h('pre', null, part.text), button('复制', 'link', () => copy(part.text)));
        box.append(row);
      }
      return box;
    }

    function actionsRow(...buttons) {
      const row = h('div', 'appr-actions');
      row.append(...buttons);
      return row;
    }

    function permissionBody(card, entry) {
      const { item } = entry;
      const plan = isPlan(item);
      const body = h('div', 'appr-body');
      body.append(h('div', 'appr-tool', item.tool || '工具'));
      if (item.description) body.append(h('p', 'appr-desc', item.description));
      for (const p of item.params) body.append(paramView(p.key, p.value, plan));
      if (!item.complete) body.append(h('p', 'appr-warn', '有参数太长，手机上没有显示全'));

      const answer = (choice, text) => onAnswer(entry.hostId, item.id, choice, text, null);
      const buttons = actionsRow(
        button(plan ? '批准' : '允许', 'primary', () => answer('allow', '')),
        button('拒绝', '', () => answer('deny', '')),
        button('拒绝并说明', 'link', () => {
          buttons.hidden = true;
          note.hidden = false;
          noteText.focus();
        }),
      );
      // 拒绝并说明：就地展开输入框，说明原样转给 Claude
      const note = h('div', 'appr-note');
      note.hidden = true;
      const noteText = h('textarea');
      noteText.rows = 3;
      noteText.placeholder = plan ? '告诉 Claude 计划要怎么改' : '告诉 Claude 为什么拒绝、应该怎么做';
      note.append(noteText, actionsRow(
        button('拒绝', 'primary', () => answer('deny', noteText.value.trim())),
        button('取消', '', () => {
          note.hidden = true;
          buttons.hidden = false;
        }),
      ));
      card.actions = [buttons, note];
      body.append(buttons, note);
      return body;
    }

    function askBody(card, entry) {
      const { item } = entry;
      const body = h('div', 'appr-body');
      /** 每个问题：{ q, picked: Set, custom: textarea } */
      const state = item.questions.map((q, qi) => {
        const qb = h('div', 'appr-q');
        if (q.header) qb.append(h('div', 'appr-tool small', q.header));
        qb.append(textWithCode(q.question));
        const picked = new Set();
        const inputs = [];
        const custom = h('textarea');
        custom.rows = 1;
        custom.placeholder = q.multiSelect ? '另外补充（可不填）' : '或者自己填';
        q.options.forEach((o) => {
          const label = h('label', 'appr-opt');
          const input = h('input');
          input.type = q.multiSelect ? 'checkbox' : 'radio';
          input.name = `appr-${item.id}-${qi}`;
          input.addEventListener('change', () => {
            if (q.multiSelect) {
              if (input.checked) picked.add(o.label);
              else picked.delete(o.label);
            } else {
              picked.clear();
              picked.add(o.label);
              custom.value = '';
            }
            refresh();
          });
          inputs.push(input);
          const txt = h('span', 'appr-opt-text');
          txt.append(h('span', null, o.label));
          if (o.description) txt.append(h('span', 'muted small', o.description));
          label.append(input, txt);
          qb.append(label);
        });
        custom.addEventListener('input', () => {
          // 单选时自己填了文字就不再选选项
          if (!q.multiSelect && custom.value) {
            picked.clear();
            for (const i of inputs) i.checked = false;
          }
          refresh();
        });
        qb.append(custom);
        body.append(qb);
        return { q, picked, custom };
      });

      /** 问题原文 -> 选项（单选、自己填的文字）或选项列表（多选）；有问题没答时返回 null */
      function answers() {
        const out = {};
        for (const { q, picked, custom } of state) {
          const text = custom.value.trim();
          if (q.multiSelect && (picked.size || text)) {
            out[q.question] = q.options.map((o) => o.label).filter((l) => picked.has(l)).concat(text ? [text] : []);
          } else if (!q.multiSelect && text) {
            out[q.question] = text;
          } else if (!q.multiSelect && picked.size) {
            out[q.question] = [...picked][0];
          } else {
            return null;
          }
        }
        return out;
      }

      const submit = button('提交', 'primary', () => {
        const a = answers();
        if (a) onAnswer(entry.hostId, item.id, 'allow', '', a);
      });
      function refresh() {
        submit.disabled = !answers();
      }
      refresh();
      const row = actionsRow(submit, button('不回答', 'link', () => onAnswer(entry.hostId, item.id, 'deny', '', null)));
      card.actions = [row];
      body.append(row);
      return body;
    }

    function buildCard(entry) {
      const { item } = entry;
      const card = { hostId: entry.hostId, item, actions: [] };
      const el = h('article', 'appr-card');
      el.dataset.id = item.id;
      const title = h('div', 'appr-title');
      const sub = h('div', 'appr-sub muted');
      const busy = h('p', 'appr-busy muted', '已提交，等电脑确认…');
      busy.hidden = true;
      el.append(title, sub, item.kind === 'ask' ? askBody(card, entry) : permissionBody(card, entry), busy);
      card.el = el;
      card.setHead = (manyHosts, now, hostName) => {
        title.textContent = (manyHosts ? `${hostName} · ` : '') + (item.title || 'Claude');
        const parts = [item.cwd, ago(item.createdAt, now), item.agent ? `子代理 ${item.agent}` : ''].filter(Boolean);
        sub.textContent = parts.join(' · ');
        sub.hidden = !parts.length;
      };
      let wasBusy = false;
      card.setBusy = (on) => {
        busy.hidden = !on;
        el.classList.toggle('busy', on);
        if (on && !wasBusy) {
          for (const a of card.actions) a.dataset.wasHidden = a.hidden ? '1' : '';
          for (const a of card.actions) a.hidden = true;
        } else if (!on && wasBusy) {
          // 回执说没成功：按钮回来，让用户再答一次
          for (const a of card.actions) a.hidden = a.dataset.wasHidden === '1';
        }
        wasBusy = on;
      };
      return card;
    }

    /** 同一个 id 的内容变了（电脑重新推了不一样的）就重画这张卡片 */
    const signature = (entry) => JSON.stringify(entry.item);

    function update(entries, { manyHosts = false, answering = new Set() } = {}) {
      const now = Date.now();
      const keep = new Set(entries.map((e) => e.item.id));
      for (const [id, card] of cards) {
        if (!keep.has(id)) {
          card.el.remove();
          cards.delete(id);
        }
      }
      let prev = null;
      for (const entry of entries) {
        const id = entry.item.id;
        const sig = signature(entry);
        let card = cards.get(id);
        if (card && card.sig !== sig) {
          card.el.remove();
          card = null;
        }
        if (!card) {
          card = buildCard(entry);
          card.sig = sig;
          cards.set(id, card);
        }
        card.setHead(manyHosts, now, entry.hostName);
        card.setBusy(answering.has(id));
        // 按顺序放好：只在位置不对时移动，免得打断正在输入的框
        const want = prev ? prev.nextSibling : list.firstChild;
        if (want !== card.el) list.insertBefore(card.el, want);
        prev = card.el;
      }
    }

    function focus(id) {
      const card = cards.get(id);
      if (!card) return false;
      card.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      card.el.classList.remove('flash');
      void card.el.offsetWidth; // 重新触发动画
      card.el.classList.add('flash');
      return true;
    }

    return { update, focus };
  }

  window.RcApprovals = { normalize, splitCode, createPanel };
})();
