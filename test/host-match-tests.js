// 域名匹配语义单测：filter_host 只匹配自身与子域，不做任意子串匹配
// 关键回归用例：y.qq.com 不得命中 ios.bugly.qq.com
const { test } = require('node:test');
const assert = require('node:assert');

const { hostMatchesRule, normalizeHostToken } = require('../proxy/host-match');

test('filter_host 命中自身', () => {
  assert.strictEqual(hostMatchesRule('y.qq.com', 'y.qq.com'), true);
  assert.strictEqual(hostMatchesRule('baidu.com', 'baidu.com'), true);
});

test('filter_host 命中子域', () => {
  assert.strictEqual(hostMatchesRule('www.y.qq.com', 'y.qq.com'), true);
  assert.strictEqual(hostMatchesRule('mbd.baidu.com', 'baidu.com'), true);
  assert.strictEqual(hostMatchesRule('s0-ant.baidu.com', 'baidu.com'), true);
  assert.strictEqual(hostMatchesRule('api.live.bilibili.com', 'bilibili.com'), true);
});

test('filter_host 不得命中只是后缀相同的其它域名', () => {
  // 本次修复的核心 bug：ios.bugly.qq.com 曾因 includes('y.qq.com') 被误判
  assert.strictEqual(hostMatchesRule('ios.bugly.qq.com', 'y.qq.com'), false);
  assert.strictEqual(hostMatchesRule('noty.qq.com', 'y.qq.com'), false);
  assert.strictEqual(hostMatchesRule('bugly.qq.com', 'y.qq.com'), false);
});

test('filter_host 不得命中前缀拼接的伪造域名', () => {
  assert.strictEqual(hostMatchesRule('y.qq.com.evil.com', 'y.qq.com'), false);
  assert.strictEqual(hostMatchesRule('baidu.com.hack.net', 'baidu.com'), false);
  assert.strictEqual(hostMatchesRule('evilbaidu.com', 'baidu.com'), false);
});

test('带端口的 host 正常匹配', () => {
  assert.strictEqual(hostMatchesRule('www.baidu.com:443', 'baidu.com'), true);
  assert.strictEqual(hostMatchesRule('bilibili.com:8080', 'bilibili.com'), true);
  assert.strictEqual(hostMatchesRule('ios.bugly.qq.com:443', 'y.qq.com'), false);
});

test('方括号 IPv6 带端口可归一化', () => {
  assert.strictEqual(normalizeHostToken('[::1]:443'), '::1');
  assert.strictEqual(normalizeHostToken('[2001:db8::1]:8080'), '2001:db8::1');
});

test('IP 精确匹配，不做子串匹配', () => {
  assert.strictEqual(hostMatchesRule('192.168.1.1', '192.168.1.1'), true);
  assert.strictEqual(hostMatchesRule('192.168.1.10', '192.168.1.1'), false);
  assert.strictEqual(hostMatchesRule('10.0.0.5:443', '10.0.0.5'), true);
});

test('大小写与末尾点归一化', () => {
  assert.strictEqual(hostMatchesRule('WWW.Baidu.COM', 'baidu.com'), true);
  assert.strictEqual(hostMatchesRule('www.baidu.com.', 'baidu.com'), true);
  assert.strictEqual(hostMatchesRule('baidu.com', 'BAIDU.COM'), true);
});

test('配置允许写成前导点形式，视同去掉前导点', () => {
  assert.strictEqual(hostMatchesRule('www.example.com', '.example.com'), true);
  assert.strictEqual(hostMatchesRule('example.com', '.example.com'), true);
  assert.strictEqual(hostMatchesRule('notexample.com', '.example.com'), false);
});

test('空值与非法输入返回 false，不抛异常', () => {
  const badValues = ['', '   ', undefined, null, 0, 123, {}, [], true];
  for (const bad of badValues) {
    assert.strictEqual(hostMatchesRule(bad, 'baidu.com'), false, `host=${String(bad)}`);
    assert.strictEqual(hostMatchesRule('baidu.com', bad), false, `rule=${String(bad)}`);
    assert.strictEqual(normalizeHostToken(bad), '');
  }
});

test('normalizeHostToken 归一化结果', () => {
  assert.strictEqual(normalizeHostToken('  WWW.Baidu.COM  '), 'www.baidu.com');
  assert.strictEqual(normalizeHostToken('example.com.'), 'example.com');
  assert.strictEqual(normalizeHostToken('example.com:443'), 'example.com');
  assert.strictEqual(normalizeHostToken(''), '');
});
