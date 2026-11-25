'use strict';
/**
 * Claude Code PostToolUse 钩子（async + asyncRewake，在后台运行）："下一步"框里不阻塞的提问，等这一轮结束后
 * 把会话叫醒，让 Claude 用 AskUserQuestion 再问一遍，这样手机上有通知、能作答（说明见仓库 docs/09-approvals.md 第 4 节）。
 *
 * "下一步"框（mcp__ccd_turn__wrap_up）是 Claude 桌面端画的，不是工具审批，审批钩子收不到。
 * 阻塞的提问在调用前就被改道钩子改成 AskUserQuestion（redirect.js）；不阻塞的要等结尾的答复写完才能问
 * （答复写在 wrap_up 之后，先问的话用户还没看到答复就被问）：
 *   1. 没带提问、被控端没在运行时什么都不做；
 *   2. 顺着会话记录等这一轮结束，再等几秒：用户在电脑上接着做了（点了框里的按钮、打了字）就不管；
 *   3. 退出码 2，stderr 写上要 Claude 做的事。Claude Code 把它作为钩子消息交给 Claude，会话空闲时也会被叫醒。
 * 不由钩子自己问手机、再把回答塞回去：Claude Code 给后台钩子的消息加了"这不是用户输入，不能当成用户的同意"的说明
 * （2026-11-21 实测），手机的回答要走 AskUserQuestion 自己的答题通道才算数。
 * 这一轮本身就是被这个钩子叫醒的、框里还是同一个问题：不再叫醒，免得来回问。
 * 叫醒时在审批目录里记一笔（nextstep-<会话>.json：哪个问题、什么时候）：桌面端的框只有再调一次 wrap_up 才会换，
 * 用户在手机上答完以后 Claude 要是没再调，那个答过的问题会一直留在电脑上。stalebox.js（Stop 钩子）靠这一笔在
 * 这一轮结束时提醒 Claude 把旧框换掉；这个会话再有"下一步"框（不管带不带提问）就把这一笔删掉。
 * 出任何错：退出码 0，什么都不发生。
 */
const fs = require('fs');
const lib = require('./lib');

const TOOL = 'mcp__ccd_turn__wrap_up';
/** 这一轮结束后等这么久再叫醒：让 Stop 钩子跑完，用户在电脑上马上点了也就不用问了 */
const GRACE_MS = Number(process.env.RC_NEXTSTEP_GRACE_MS || 8000);
const POLL_MS = Number(process.env.RC_NEXTSTEP_POLL_MS || 300);
/** 结尾的答复最多等这么久；等不到就不管（看不到会话走到哪了）。要比 hooks.json 里的 timeout（900 秒）短 */
const END_WAIT_MS = Number(process.env.RC_NEXTSTEP_END_WAIT_MS || 600000);
/** 钩子输入里没有调用编号时，只认开始前这么久以内的同一个提问 */
const RECENT_MS = 60000;
/** 叫醒消息的开头；会话开头注入的规则引用了它，也靠它认出"这一轮是被这个钩子叫醒的" */
const MARK = 'RemoteClaude 插件提醒';
const SKIP_LABEL = '先不用';
/** 框里的应用按钮没有文字，提问里写成这些 */
const APP_ACTIONS = {
  commit: '提交',
  create_pr: '创建 PR',
  merge: '合并 PR',
  fix_ci: '修 CI',
  address_comments: '处理评审意见',
  resolve_conflicts: '解决冲突',
  verify: '验证',
  archive: '归档这个会话',
  new_session: '新开一个会话',
};

const askOf = (input) => String(lib.asObj(input).ask || '').trim();
/** 叫醒消息里的这一行，也用来认出同一个问题 */
const askLine = (ask) => `问题：${ask}\n`;
/** 叫醒时记的那一笔 */
const markerFile = (session) => lib.file(`nextstep-${session}.json`);

function clearMarker(session) {
  if (!lib.safeId(session)) return;
  try {
    fs.unlinkSync(markerFile(session));
  } catch {}
}

/** 框里的按钮变成提问的选项（文字） */
function optionsOf(input) {
  const out = [];
  for (const a of Array.isArray(lib.asObj(input).actions) ? input.actions : []) {
    const o = lib.asObj(a);
    const app = typeof o.action === 'string' ? o.action.trim() : '';
    const label = (app ? APP_ACTIONS[app] || app : String(o.label || '')).trim().slice(0, 200);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** 交给 Claude 的话 */
function wakeMessage(input) {
  const labels = optionsOf(input);
  let options;
  if (!labels.length) options = `选项由你按问题来拟，其中一个是「${SKIP_LABEL}」`;
  else {
    if (labels.length < 2 && !labels.includes(SKIP_LABEL)) labels.push(SKIP_LABEL);
    options = `选项：${labels.map((l) => `「${l}」`).join('、')}`;
  }
  return (
    `${MARK}（用户安装的本地钩子发的，不是用户的回答）：上一轮的"下一步"框里有提问。用户常不在电脑前，框里的按钮手机上点不到，也没有通知；` +
    '只有 AskUserQuestion 能在手机上作答。请现在用 AskUserQuestion 把同一个问题再问一遍：\n' +
    askLine(askOf(input)) +
    `${options}\n` +
    '拿到回答后照做；选的是应用按钮（提交、创建 PR 等）时由你来完成这个操作。' +
    '用户答了以后（照做了，或选了不做），结束这一轮前要再调用一次 wrap_up，哪怕只是停下来等后台任务：recap 写现在的情况，不要再带这个问题。' +
    '桌面端在这之前一直显示着上一个框，用户会以为又要答一遍。' +
    '用户没有回答，就直接结束这一轮：不用重复上一轮已经写过的答复，这个问题也不要再放进"下一步"框。'
  );
}

/** 返回要交给 Claude 的话；不用叫醒时返回空串 */
async function run(payload, startedAt) {
  const input = lib.asObj(payload.tool_input);
  const ask = askOf(input);
  const callId = String(payload.tool_use_id || '');
  const parent = process.ppid; // Claude Code
  const watch = new lib.TurnWatch(String(payload.transcript_path || ''), TOOL, (block, entry) =>
    callId ? block.id === callId : askOf(block.input) === ask && !(Date.parse(entry.timestamp) < startedAt - RECENT_MS),
  );

  let endedAt = 0;
  for (;;) {
    const state = watch.state();
    if (state === 'superseded') {
      lib.log('"下一步"提问没叫醒：会话已经接着往下走了（用户在电脑上作答、打了字，或又有了新的回复）');
      return '';
    }
    if (state === 'ended') {
      endedAt = endedAt || Date.now();
      if (Date.now() - endedAt >= GRACE_MS) break;
    } else if (Date.now() - startedAt > END_WAIT_MS) {
      lib.log(`"下一步"提问没管：${watch.found ? '没等到这一轮结束' : '会话记录里没找到这次调用'}`);
      return '';
    }
    if (!lib.processAlive(parent)) return '';
    await lib.sleep(POLL_MS);
  }
  if (!lib.hostAlive()) {
    lib.log('"下一步"提问没叫醒：被控端没在运行');
    return '';
  }
  if (watch.turnInput.includes(MARK) && watch.turnInput.includes(askLine(ask))) {
    lib.log('"下一步"框里还是刚问过的问题，不再叫醒');
    return '';
  }
  const session = String(payload.session_id || '');
  try {
    if (lib.safeId(session)) lib.writeJsonAtomic(markerFile(session), { at: Date.now(), ask });
  } catch (err) {
    lib.log(`"下一步"提问：叫醒的记录没写成，答完以后不会提醒换掉旧框: ${err.message}`);
  }
  lib.log('"下一步"提问：叫醒会话，改用 AskUserQuestion 再问一遍');
  return wakeMessage(input);
}

async function main() {
  const startedAt = Date.now();
  const payload = lib.readPayload();
  if (payload.tool_name !== TOOL || payload.agent_id) return '';
  clearMarker(String(payload.session_id || '')); // 桌面端的框已经换成这一个了
  if (!askOf(payload.tool_input) || !lib.hostAlive()) return '';
  return run(payload, startedAt);
}

if (require.main === module) {
  main()
    .catch((err) => {
      lib.log(`"下一步"钩子出错: ${err && err.stack ? err.stack : err}`);
      return '';
    })
    .then((message) => {
      if (!message) process.exit(0);
      // 退出码 2 + stderr：Claude Code 叫醒 Claude 并把这段话交给它；写完再退出，免得被截断
      process.stderr.write(message, () => process.exit(2));
    });
}

module.exports = { wakeMessage, optionsOf, askLine, markerFile, MARK };
