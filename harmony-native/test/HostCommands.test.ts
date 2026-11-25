// 对照 android/app/src/test/.../windows/HostCommandsTest.kt 和 WindowCloseTest.kt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostCommands, LockItem } from '../entry/src/main/ets/logic/HostCommands';
import type { HostCommandsMenu } from '../entry/src/main/ets/logic/HostCommands';
import { WindowClose } from '../entry/src/main/ets/logic/WindowClose';

interface MenuArgs {
  online?: boolean;
  commands?: boolean;
  rtcConnected?: boolean;
  tileAvailable?: boolean;
  pcLocked?: boolean;
  unlockAvailable?: boolean;
}

function menu(a: MenuArgs = {}): HostCommandsMenu {
  return HostCommands.menu(
    a.online ?? true,
    a.commands ?? true,
    a.rtcConnected ?? false,
    a.tileAvailable ?? true,
    a.pcLocked ?? false,
    a.unlockAvailable ?? true,
  );
}

function m(tile: boolean, lock: LockItem, lockEnabled: boolean): HostCommandsMenu {
  return { tile, lock, lockEnabled };
}

test('新版被控端：不连画面也全部显示', () => {
  assert.deepEqual(menu(), m(true, LockItem.Lock, true));
  // 平铺没在运行（比如旧的平铺插件还在跑）：只剩锁定
  assert.deepEqual(menu({ tileAvailable: false }), m(false, LockItem.Lock, true));
});

test('旧版被控端只在连着画面时能用', () => {
  assert.deepEqual(menu({ commands: false, tileAvailable: false }), m(false, LockItem.Lock, false));
  assert.deepEqual(menu({ commands: false, rtcConnected: true }), m(true, LockItem.Lock, true));
});

test('离线时全部不可用', () => {
  assert.deepEqual(menu({ online: false }), m(false, LockItem.Lock, false));
  assert.deepEqual(menu({ online: false, pcLocked: true }), m(false, LockItem.Unlock, false));
});

test('电脑锁着、装了解锁服务时可以解锁', () => {
  assert.deepEqual(menu({ pcLocked: true }), m(true, LockItem.Unlock, true));
  assert.deepEqual(menu({ pcLocked: true, unlockAvailable: false }), m(true, LockItem.Unlock, false));
  assert.equal(menu({ pcLocked: true }).lock === LockItem.Unlock, true);
  assert.equal(LockItem.Unlock.name, 'Unlock');
});

test('回过窗口列表却没推过状态才提示升级', () => {
  assert.equal(HostCommands.needsUpgrade(true, true), true);
  assert.equal(HostCommands.needsUpgrade(true, false), false);
  assert.equal(HostCommands.needsUpgrade(false, true), false);
});

test('解锁提示文字', () => {
  assert.equal(HostCommands.unlockText(HostCommands.OK), '电脑已解锁');
  assert.equal(HostCommands.unlockText(null), '电脑没有回应，电脑上的被控端可能需要更新');
  assert.equal(HostCommands.unlockText('closed'), '连接断开了，不知道电脑解锁了没有');
  assert.equal(HostCommands.unlockText('bad-key'), '电脑上的被控端刚重启过，请再试一次');
  assert.equal(HostCommands.unlockText('replayed'), '电脑上的被控端刚重启过，请再试一次');
  // 要先盖隐私屏却没盖上，被控端没解锁：说清楚为什么、怎么办（和安卓端一样）
  assert.equal(
    HostCommands.unlockText('privacy-failed'),
    '隐私屏没盖上，没有解锁。电脑上的解锁服务可能要重新安装；也可以在设置里关掉“解锁时打开隐私屏”',
  );
  assert.equal(HostCommands.unlockText('saved-wrong'), '记下的密码不对了（可能改过密码），已经删掉，请重新输入');
  assert.ok((HostCommands.unlockText('no-saved') ?? '').includes('请输入'));
  // 其余的错误码（still-locked、rate-limited…）用和画面页一样的提示
  assert.equal(HostCommands.unlockText('still-locked'), null);
  assert.equal(HostCommands.unlockText('rate-limited'), null);
  assert.ok(HostCommands.UNSUPPORTED_TEXT.includes(HostCommands.MIN_HOST_VERSION));
  assert.ok(HostCommands.UNSUPPORTED_TOAST.includes(HostCommands.MIN_HOST_VERSION));
});

test('用记下的密码解锁：不对了或没有时才弹输入框，只试一次', () => {
  assert.equal(HostCommands.needsPassword('saved-wrong'), true);
  assert.equal(HostCommands.needsPassword('no-saved'), true);
  for (const code of [HostCommands.OK, 'still-locked', 'rate-limited', 'privacy-failed', 'busy', 'closed', null]) {
    assert.equal(HostCommands.needsPassword(code), false, String(code));
  }
});

test('隐私屏开关的提示', () => {
  assert.equal(HostCommands.privacyText(true, HostCommands.OK), '已打开隐私屏：电脑的显示器盖上了黑幕');
  assert.equal(HostCommands.privacyText(false, HostCommands.OK), '已关闭隐私屏');
  assert.equal(HostCommands.privacyText(true, null), '电脑没有回应');
  assert.equal(HostCommands.privacyText(true, 'bad-op'), '电脑上的被控端太旧，不支持隐私屏，请升级');
  assert.equal(HostCommands.privacyText(true, 'failed'), '隐私屏没打开，电脑上的解锁服务可能要重新安装');
  assert.equal(HostCommands.privacyText(false, 'failed'), '隐私屏没关掉');
});

test('忘掉记下的解锁密码的提示', () => {
  assert.equal(HostCommands.forgetText(HostCommands.OK), '电脑已经忘掉记下的解锁密码');
  assert.equal(HostCommands.forgetText(null), '电脑没有回应');
  assert.equal(HostCommands.forgetText('bad-op'), '电脑上的被控端太旧，请升级');
  assert.equal(HostCommands.forgetText('closed'), '没能忘掉记下的密码（closed）');
});

test('关掉了或本来就没有窗口时拿掉卡片', () => {
  assert.equal(WindowClose.removesCard(true, ''), true);
  assert.equal(WindowClose.removesCard(false, 'gone'), true);
  for (const code of ['changed', 'still-open', 'not-closable', 'failed']) {
    assert.equal(WindowClose.removesCard(false, code), false, code);
  }
});

test('关闭窗口的提示文字', () => {
  assert.equal(WindowClose.resultText(true, '', '推杆系统网口版调试'), '已关闭「推杆系统网口版调试」，会话还在「全部会话」里');
  assert.equal(WindowClose.resultText(false, 'gone', '新会话'), '「新会话」已经关掉了');
  assert.equal(WindowClose.resultText(false, 'changed', 'x'), '这个窗口刚换成了别的会话，没有关，列表已刷新');
  assert.equal(WindowClose.resultText(false, 'not-closable', 'Claude'), 'Claude 主窗口不能从手机关');
  assert.equal(WindowClose.resultText(false, 'still-open', 'x'), '电脑上的「x」没有关掉，请在电脑上看看');
  assert.equal(WindowClose.resultText(false, 'failed', ''), '没能关掉「这个窗口」（failed）');
  assert.ok(WindowClose.UNSUPPORTED_TEXT.includes(WindowClose.MIN_HOST_VERSION));
  assert.equal(WindowClose.TIMEOUT_MS, 10000);
});
