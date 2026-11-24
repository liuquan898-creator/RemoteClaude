// 对照 android/app/src/test/.../protocol/ServerAddressTest.kt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerAddress } from '../entry/src/main/ets/protocol/ServerAddress';
import type { ServerAddressResult } from '../entry/src/main/ets/protocol/ServerAddress';

function ok(input: string, cleartext = false): ServerAddressResult {
  const r = parseServerAddress(input, cleartext);
  assert.equal(r.ok, true, `应当合法: ${input} -> ${JSON.stringify(r)}`);
  return r;
}

function invalid(input: string, cleartext = false): void {
  const r = parseServerAddress(input, cleartext);
  assert.equal(r.ok, false, `应当不合法: ${input} -> ${JSON.stringify(r)}`);
  assert.ok(r.reason.length > 0);
}

test('只写域名时默认 wss', () => {
  const r = ok('rc.example.com');
  assert.equal(r.url, 'wss://rc.example.com/ws');
  assert.equal(r.httpBase, 'https://rc.example.com');
});

test('https 换成 wss', () => {
  assert.equal(ok('https://rc.example.com/').url, 'wss://rc.example.com/ws');
});

test('保留端口和自定义路径', () => {
  const r = ok('wss://rc.example.com:8443/rc/ws');
  assert.equal(r.url, 'wss://rc.example.com:8443/rc/ws');
  assert.equal(r.httpBase, 'https://rc.example.com:8443/rc');
});

test('去掉首尾空白', () => {
  assert.equal(ok('  rc.example.com  ').url, 'wss://rc.example.com/ws');
});

test('只有允许时才能用明文', () => {
  const emulator = ok('ws://10.0.2.2:8787', true);
  assert.equal(emulator.url, 'ws://10.0.2.2:8787/ws');
  assert.equal(emulator.httpBase, 'http://10.0.2.2:8787');
  assert.equal(ok('http://192.168.1.5:8787', true).url, 'ws://192.168.1.5:8787/ws');
  invalid('ws://10.0.2.2:8787');
  invalid('http://rc.example.com');
});

test('不认乱填的', () => {
  invalid('');
  invalid('   ');
  invalid('ftp://rc.example.com');
  invalid('https://');
});
