'use strict';
/**
 * Claude Code PermissionRequest 钩子：审批弹窗和 AskUserQuestion 提问推到 RemoteClaude 手机 App 作答
 * （说明见仓库 docs/09-approvals.md 第 3 节）。
 *
 * Claude Code 在钩子运行时照常在电脑上弹窗，哪边先答算哪边。钩子：
 *   1. 被控端没在运行、或是"下一步"框时什么都不做；
 *   2. 先等几秒，用户在电脑上马上点了就不打扰手机；
 *   3. 写 <id>.pending.json，等 <id>.done.json；期间发现电脑上已经答了、Claude Code 没了、等太久，就自己写 closed 结束；
 *   4. 是手机的答案就在 stdout 输出决定。
 * stdout 只放决定的 JSON。出任何错都不输出决定、退出码 0，Claude Code 照常等电脑上的弹窗。
 */
const fs = require('fs');
const lib = require('./lib');

const GRACE_MS = Number(process.env.RC_APPROVAL_GRACE_MS || 3000);
const POLL_MS = 1000;
/**
 * 电脑上的弹窗等多久，手机上就该能答多久，所以给 7 天（插件 1.0.8 起；原来 2 小时，夜里发的提问早上已经从手机上收回了）。
 * 要比 hooks.json 里的 timeout（605100 秒）短
 */
const MAX_WAIT_MS = Number(process.env.RC_APPROVAL_MAX_WAIT_MS || 7 * 24 * 3600 * 1000);
/** 后台子代理的审批在电脑上没有弹窗，钩子不给决定 Claude Code 就一直等，所以只等 5 分钟 */
const SUBAGENT_WAIT_MS = Number(process.env.RC_SUBAGENT_WAIT_MS || 300000);
/** "下一步"框由改道钩子（redirect.js）和后台钩子（nextstep.js）处理，这里不管 */
const SKIPPED = new Set(['mcp__ccd_turn__wrap_up']);
const ASK_TOOL = 'AskUserQuestion';
/** 计划审批（插件 1.0.3 起推到手机）：计划分段放进参数里，被控端每段最多收 8000 字 */
const PLAN_TOOL = 'ExitPlanMode';
const PLAN_CHUNK = 7900;
const PLAN_DESCRIPTION =
  '批准后 Claude 退出计划模式，开始按计划动手。要改就点"拒绝并说明"写上意见，Claude 会留在计划模式里接着改。';
/** 这些工具的 description 是 Claude 自己写的说明，单独显示；别的工具里 description 是真内容 */
const SUMMARY_DESCRIPTION_TOOLS = new Set(['Bash', 'PowerShell', 'Agent', 'Task']);
/** 一个参数最多给手机看这么多字，超过的截头尾，并标为不完整 */
const FIELD_LIMIT = 4000;
const PARAMS_LIMIT = 24000;

function shown(text) {
  return `${text.slice(0, 2400)}\n…（中间省略 ${text.length - 3200} 字）…\n${text.slice(-800)}`;
}

/** pending 文件的内容（字段见 docs/09 第 2 节） */
function buildRequest(id, payload, now = Date.now()) {
  const tool = String(payload.tool_name || '');
  const input = lib.asObj(payload.tool_input);
  const summaryOnly = SUMMARY_DESCRIPTION_TOOLS.has(tool);
  const req = {
    id,
    kind: tool === ASK_TOOL ? 'ask' : 'permission',
    sessionId: String(payload.session_id || ''),
    transcriptPath: String(payload.transcript_path || ''),
    cwd: String(payload.cwd || ''),
    title: lib.sessionTitle(String(payload.transcript_path || '')),
    agent: payload.agent_id ? String(payload.agent_type || '子代理').slice(0, 60) : '',
    tool,
    description: summaryOnly ? String(input.description || '') : '',
    params: [],
    complete: true,
    questions: [],
    createdAt: now,
    waiterPid: process.pid,
  };
  if (tool === PLAN_TOOL) return planRequest(req, input);
  if (req.kind === 'ask') {
    req.questions = (Array.isArray(input.questions) ? input.questions : []).map((q) => {
      const o = lib.asObj(q);
      return {
        question: String(o.question || ''),
        header: String(o.header || ''),
        multiSelect: o.multiSelect === true,
        options: (Array.isArray(o.options) ? o.options : []).map((x) => ({
          label: String(lib.asObj(x).label || ''),
          description: String(lib.asObj(x).description || ''),
        })),
      };
    });
    return req;
  }
  let used = 0;
  let omitted = 0;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'description' && summaryOnly) continue;
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) text = '';
    if (text.length > FIELD_LIMIT) {
      req.complete = false;
      text = shown(text);
    }
    if (omitted || used + text.length > PARAMS_LIMIT) {
      omitted++;
      continue;
    }
    used += text.length;
    req.params.push({ key: String(key).slice(0, 100), value: text });
  }
  if (omitted) {
    req.complete = false;
    req.params.push({ key: '…', value: `还有 ${omitted} 个参数太长，手机上没显示` });
  }
  return req;
}

/** 计划审批：显示成"计划"，计划全文分段，放不下的标为不完整 */
function planRequest(req, input) {
  const plan = String(input.plan || '');
  req.tool = '计划';
  req.description = PLAN_DESCRIPTION;
  const chunks = [];
  for (let i = 0; i < plan.length; i += PLAN_CHUNK) chunks.push(plan.slice(i, i + PLAN_CHUNK));
  const fit = chunks.slice(0, Math.floor(PARAMS_LIMIT / PLAN_CHUNK));
  fit.forEach((c, i) => req.params.push({ key: fit.length > 1 ? `计划（${i + 1}/${chunks.length}）` : '计划', value: c }));
  if (!plan) req.params.push({ key: '计划', value: '（计划是空的）' });
  if (chunks.length > fit.length) {
    req.complete = false;
    req.params.push({ key: '…', value: `计划太长，后面 ${plan.length - fit.length * PLAN_CHUNK} 字手机上没显示，完整的在电脑上` });
  }
  if (input.planFilePath) req.params.push({ key: '计划文件', value: String(input.planFilePath) });
  return req;
}

/*
 * 批准计划后的权限模式：2026-11-19 实测，钩子批准后 Claude Code 回到进计划模式之前的模式
 * （从自动模式进计划模式的，回到自动模式；一开始就在计划模式的会话，回到"默认"）。
 * 决定里加 updatedPermissions 的 setMode（auto）试过，不起作用，所以不加。桌面端给钩子的模式建议也是空的。
 */

/** 把手机的答案变成 Claude Code 认的决定；答案不对时返回 null（不给决定，电脑上的弹窗照常） */
function decisionFor(payload, outcome) {
  const asking = payload.tool_name === ASK_TOOL;
  const input = lib.asObj(payload.tool_input);
  let decision;
  const planning = payload.tool_name === PLAN_TOOL;
  if (outcome.choice === 'allow' && asking) {
    if (!lib.isObj(outcome.answers)) return null;
    decision = { behavior: 'allow', updatedInput: { ...input, answers: outcome.answers } };
  } else if (outcome.choice === 'allow' && planning) {
    // ExitPlanMode 光给 allow 不够，要把输入原样带上（docs：Tools that require user interaction）
    decision = { behavior: 'allow', updatedInput: { ...input } };
  } else if (outcome.choice === 'allow') {
    decision = { behavior: 'allow' };
  } else if (outcome.choice === 'deny') {
    let message = asking ? '用户在 RemoteClaude App 上没有回答这个问题。' : '用户在 RemoteClaude App 上拒绝了这次操作。';
    if (planning) message += '这是计划审批：用户没有批准这个计划，请留在计划模式里，按用户的意见修改计划后再提交。';
    const note = String(outcome.text || '').trim().slice(0, 1000);
    if (note) {
      // 会话开头注入的规则引用了这句话；说明放最后，免得里面的内容混淆它到哪儿结束
      message += `按会话开头注入的"RemoteClaude 手机审批规则"，下面的说明等同于用户在本对话里直接输入。用户的说明（原话，到结尾为止）：\n${note}`;
    }
    decision = { behavior: 'deny', message };
  } else {
    return null;
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

async function run(payload, startedAt) {
  const watch = new lib.ToolUseWatch(String(payload.transcript_path || ''), String(payload.tool_name), payload.tool_input, startedAt);
  while (Date.now() - startedAt < GRACE_MS) {
    if (watch.resolved()) return; // 电脑上马上答了
    await lib.sleep(300);
  }

  const id = lib.newId();
  const pending = lib.file(`${id}.pending.json`);
  const done = lib.file(`${id}.done.json`);
  lib.writeJsonAtomic(pending, buildRequest(id, payload));
  const subagent = !!payload.agent_id;
  const limit = subagent ? SUBAGENT_WAIT_MS : MAX_WAIT_MS;
  const parent = process.ppid; // Claude Code
  lib.log(`等待 ${id} ${payload.tool_name}${subagent ? '（子代理）' : ''}`);
  if (payload.tool_name === PLAN_TOOL) {
    // 记下 Claude Code 给的模式建议（不含计划内容），方便核对批准后切到了哪种模式
    const modes = (Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [])
      .filter((x) => lib.isObj(x) && x.type === 'setMode')
      .map((x) => `${x.mode}/${x.destination}`);
    lib.log(`计划审批 ${id}：当前模式 ${payload.permission_mode || '?'}，模式建议 ${modes.join(', ') || '无'}`);
  }

  let outcome = null;
  try {
    for (;;) {
      outcome = lib.readJson(done);
      if (outcome) break;
      let reason = '';
      if (watch.resolved()) reason = 'answered_on_computer';
      else if (!lib.processAlive(parent)) reason = 'waiter_gone';
      else if (Date.now() - startedAt > limit) reason = subagent ? 'subagent_timeout' : 'timeout';
      if (reason) lib.finish(id, { kind: 'closed', reason }); // 下一轮读出生效的那个结果
      else {
        const now = new Date();
        try {
          fs.utimesSync(pending, now, now); // 心跳：钩子还在等
        } catch {}
      }
      await lib.sleep(POLL_MS);
    }
  } finally {
    try {
      fs.unlinkSync(pending);
    } catch {}
  }

  lib.log(`结束 ${id}：${outcome.kind === 'answer' ? `手机作答 ${outcome.choice}` : outcome.reason}`);
  if (outcome.kind !== 'answer') return;
  const out = decisionFor(payload, outcome);
  if (out) lib.writeJson(out);
}

async function main() {
  const startedAt = Date.now();
  const payload = lib.readPayload();
  const tool = String(payload.tool_name || '');
  if (!tool || SKIPPED.has(tool) || !lib.hostAlive()) return;
  await run(payload, startedAt);
}

if (require.main === module) {
  main()
    .catch((err) => lib.log(`审批钩子出错: ${err && err.stack ? err.stack : err}`))
    .finally(() => process.exit(0));
}

module.exports = { buildRequest, decisionFor, run, PLAN_CHUNK };
