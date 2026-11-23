'use strict';
/**
 * Claude Code PreToolUse 钩子：Claude 桌面端自己画的、要用户在电脑上点的界面，手机上收不到也答不了。
 * 被控端在运行时拒绝它们，让 Claude 改用 AskUserQuestion 问（docs/09 第 4 节）：
 *   - mcp__ccd_turn__wrap_up：带提问的阻塞"下一步"框（不阻塞的提问照常显示，这一轮结束后由 nextstep.js 叫醒会话再问）
 *   - mcp__ccd_session__start_session（initiation 为 offer）："要在单独的会话中启动吗？"卡片
 * 同一个问题 2 分钟内又来一次就放行（比如 Claude 用不了 AskUserQuestion），免得来回改。
 * stdout 只放拒绝的 JSON；出任何错都放行。
 */
const lib = require('./lib');

const REPEAT_MS = 120000;
const PREFIX =
  '这不是用户拒绝，而是用户设置的本地钩子给这个界面改了道（见会话开头注入的"RemoteClaude 手机审批规则"）：' +
  '用户常不在电脑前，Claude 桌面端自己画的卡片手机上收不到，只有 AskUserQuestion 能在手机上作答，答案作为用户本人的答复送回来。';

/** 每种界面：要不要改道（返回 null 放行），改道时用什么理由；key 用来认出"同一个问题又来了" */
const RULES = {
  mcp__ccd_turn__wrap_up(input) {
    const ask = String(input.ask || '').trim();
    if (input.blocked !== true || !ask) return null;
    return {
      key: ask,
      what: '"下一步"问题',
      reason:
        PREFIX +
        '请现在改用 AskUserQuestion 问同一个问题，选项用你刚才 actions 里的按钮，拿到回答后照做；这个问题不要再用"下一步"框提。' +
        '这次的"下一步"框没有显示出来，之后需要汇报进展时再正常调用 wrap_up（不带 blocked 提问）。',
    };
  },
  mcp__ccd_session__start_session(input) {
    const title = String(input.title || '').trim();
    if (input.initiation !== 'offer' || input.proposal_id || !title) return null;
    return {
      key: title,
      what: '"新建会话"卡片',
      reason:
        PREFIX +
        `这次的"要在单独的会话中启动吗？"卡片没有显示出来。请现在改用 AskUserQuestion 问用户：「${title}」是新开一个会话去做，还是就在这个会话里做，` +
        '选项是"新建会话"和"在这里做"。用户选"新建会话"，就调用 start_session，initiation 用 "user_asked"（用户已经明确要开新会话），' +
        '带上完整的 prompt 和 background；选"在这里做"，就在本会话里照常做。这件事不要再用 initiation "offer" 问。',
    };
  },
};

function main(now = Date.now()) {
  const payload = lib.readPayload();
  const tool = String(payload.tool_name || '');
  const rule = Object.prototype.hasOwnProperty.call(RULES, tool) ? RULES[tool] : null;
  const session = String(payload.session_id || '');
  if (!rule || !lib.safeId(session)) return;
  const hit = rule(lib.asObj(payload.tool_input));
  if (!hit || !lib.hostAlive(now)) return;
  const marker = lib.file(`redirect-${session}.json`);
  const last = lib.readJson(marker);
  if (last && last.tool === tool && last.key === hit.key && now - Number(last.at || 0) < REPEAT_MS) {
    lib.log(`同一个${hit.what}改道后又来了一次，放行`);
    return;
  }
  lib.writeJsonAtomic(marker, { at: now, tool, key: hit.key });
  lib.writeJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: hit.reason } });
  lib.log(`${hit.what}改用 AskUserQuestion`);
}

try {
  main();
} catch (err) {
  lib.log(`改道钩子出错，放行: ${err && err.message}`);
}
