'use strict';
/**
 * Claude Code Stop 钩子：手机上答过的"下一步"提问，别让它留在电脑上（说明见仓库 docs/09-approvals.md 第 4 节）。
 *
 * nextstep.js 把会话叫醒、Claude 用 AskUserQuestion 重问、用户答了以后，桌面端显示的还是叫醒前的那个框：
 * 框只有再调一次 mcp__ccd_turn__wrap_up 才会换。Claude 照做完要是没再调（比如停下来等后台任务），这一轮一结束
 * 桌面端又把那个框画出来，里面是已经答过的问题和按钮，用户会以为又要答一遍（2026-11-24 用户遇到）。
 *   1. 这个会话没有叫醒的记录（nextstep-<会话>.json）就什么都不做：绝大多数时候到这里就结束了；
 *   2. 有记录，说明叫醒以后还没有新的"下一步"框（有的话 nextstep.js 已经把记录删了）。从会话记录里找到那次叫醒，
 *      看之后的情况：用户用 AskUserQuestion 答了，就以退出码 2 拦下这次结束，stderr 写上要 Claude 做的事
 *      （调一次不带这个问题的 wrap_up）；用户没回答、Claude 没问、用户自己又说了话，都不管；
 *   3. 一条记录只提醒一次，提醒前先删掉，不会来回拦。
 * 出任何错：退出码 0，照常结束。
 */
const fs = require('fs');
const lib = require('./lib');
const { MARK, askLine, markerFile } = require('./nextstep');

/** 会话记录里的时间和记录里记的时间允许差这么多 */
const WAKE_SLACK_MS = 60000;
/** 叫醒的记录过了这么久、会话记录里还找不到那次叫醒：叫醒没送到，删掉 */
const MARKER_MAX_MS = 600000;
/** 提问的结果里有这些话 = 用户没有回答（手机上超时或拒绝、发了条消息、在电脑上按了 Esc） */
const NO_ANSWER = /没有回答这个问题|did not answer|doesn't want to proceed|tool use was rejected/i;

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => String(lib.asObj(b).text || '')).join('\n') : '';

/** 那次叫醒之后会话里发生了什么：{ woke 找到了叫醒, typed 用户自己又说了话, answer 最后一次提问的结果（没有就是 null） } */
function scan(transcriptPath, ask, at) {
  const seen = { woke: false, typed: false, answer: null };
  const asked = new Set();
  lib.eachLine(transcriptPath, (line) => {
    if (!seen.woke && !line.includes(MARK)) return; // 叫醒之前的不用解析
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!lib.isObj(e) || e.isSidechain === true) return;
    const message = lib.asObj(e.message);
    const blocks = Array.isArray(message.content) ? message.content.map(lib.asObj) : [];
    if (e.type === 'assistant') {
      if (seen.woke) for (const b of blocks) if (b.type === 'tool_use' && b.name === 'AskUserQuestion') asked.add(String(b.id));
    } else if (e.type === 'user' && e.isMeta !== true) {
      if (typeof message.content === 'string') {
        const text = message.content;
        if (text.includes(MARK) && text.includes(askLine(ask)) && !(Date.parse(e.timestamp) < at - WAKE_SLACK_MS)) {
          // 同一个问题叫醒过不止一次时，以最后一次为准
          seen.woke = true;
          seen.typed = false;
          seen.answer = null;
          asked.clear();
        } else if (seen.woke && text.trim() && !text.startsWith('<task-notification>')) {
          seen.typed = true; // 后台任务结束的通知不算用户说话
        }
      } else if (seen.woke) {
        for (const b of blocks) if (b.type === 'tool_result' && asked.has(String(b.tool_use_id))) seen.answer = textOf(b.content);
        if (blocks.length && !blocks.some((b) => b.type === 'tool_result')) seen.typed = true;
      }
    }
  });
  return seen;
}

/** 交给 Claude 的话。带上叫醒消息的开头和"问题："那一行：Claude 要是又把同一个问题放进框里，nextstep.js 认得出来、不再叫醒 */
function nudge(ask) {
  return (
    `${MARK}（用户安装的本地钩子发的，不是用户的回答）：桌面端现在显示的还是上一个"下一步"框，里面的提问用户已经用 AskUserQuestion 答过了，留着会让用户以为又要答一遍：\n` +
    askLine(ask) +
    '请现在调用一次 wrap_up 把它换掉：recap 写现在的情况（做到哪了、还差什么，只是停下来等后台任务也照实写），不要再带这个问题；另有新的事要用户决定才带新的提问。' +
    '之后用一句话收尾就行，不用重复刚才已经写过的答复。用户其实没有回答这个问题的话，不用调用，直接结束。'
  );
}

/** 返回要交给 Claude 的话；不用提醒时返回空串 */
function main(now = Date.now()) {
  const payload = lib.readPayload();
  const session = String(payload.session_id || '');
  if (!lib.safeId(session)) return '';
  const marker = markerFile(session);
  const mark = lib.readJson(marker);
  if (!mark) return '';
  const drop = () => {
    try {
      fs.unlinkSync(marker);
    } catch {}
  };
  const ask = String(mark.ask || '');
  const at = Number(mark.at || 0);
  let seen;
  try {
    seen = scan(String(payload.transcript_path || ''), ask, at);
  } catch (err) {
    drop();
    lib.log(`旧的"下一步"框没管：读会话记录失败: ${err.message}`);
    return '';
  }
  if (!seen.woke) {
    if (now - at > MARKER_MAX_MS) drop();
    return '';
  }
  drop();
  if (seen.typed || seen.answer === null || NO_ANSWER.test(seen.answer)) return '';
  lib.log('"下一步"提问已经答了，框还是旧的：提醒 Claude 再调一次 wrap_up');
  return nudge(ask);
}

if (require.main === module) {
  let message = '';
  try {
    message = main();
  } catch (err) {
    lib.log(`旧框钩子出错: ${err && err.stack ? err.stack : err}`);
  }
  if (!message) process.exit(0);
  // 退出码 2 + stderr：Claude Code 不让这一轮结束，把这段话交给 Claude；写完再退出，免得被截断
  process.stderr.write(message, () => process.exit(2));
}

module.exports = { nudge };
