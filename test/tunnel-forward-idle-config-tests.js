// forward 空闲超时可配置的单元测试：node test/tunnel-forward-idle-config-tests.js
//
// 背景：f5e731d 的提交信息写「新增 forwardIdleTimeoutMs 配置项，<=0 可关闭」，
// 但 TunnelManager 只从构造参数读，proxy.js 的 loadConfig / new TunnelManager
// 三处都没转发这个字段 → config.json 写什么都不生效，永远回退 300000。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { FRAME_TYPES } = require('../tunnel/protocol');
const TunnelManager = require('../tunnel/manager');

const PROXY_JS = path.join(__dirname, '..', 'proxy', 'proxy.js');
const DEFAULT_IDLE_MS = 300 * 1000;

function createMockServer() {
  return {
    _sessionA: 'session-a',
    _sentFrames: [],
    setTunnelManager() {},
    setActiveRequestChecker() {},
    sendFrame(frame, sessionId) {
      this._sentFrames.push({ frame, sessionId });
    },
    sendEncodedFrame() {},
  };
}

// ---------- TunnelManager 侧：接受字段且保留 0 ----------

function testManagerDefaultsToFiveMinutes() {
  const manager = new TunnelManager(createMockServer(), { tunnel_domains: [] });
  assert.strictEqual(manager._forwardIdleTimeoutMs, DEFAULT_IDLE_MS);
}

function testManagerAcceptsExplicitTimeout() {
  const manager = new TunnelManager(createMockServer(), {
    tunnel_domains: [],
    forwardIdleTimeoutMs: 1234,
  });
  assert.strictEqual(manager._forwardIdleTimeoutMs, 1234);
}

function testManagerTreatsZeroAsDisabledNotAsDefault() {
  // <=0 表示关闭超时，不能被当成「未配置」而回退默认值
  const manager = new TunnelManager(createMockServer(), {
    tunnel_domains: [],
    forwardIdleTimeoutMs: 0,
  });
  assert.strictEqual(manager._forwardIdleTimeoutMs, 0);
}

// ---------- proxy.js 侧：配置真的被转发（源码级断言）----------

function testProxyJsDeclaresDefault() {
  const source = fs.readFileSync(PROXY_JS, 'utf8');
  assert.match(
    source,
    /tunnel_forward_idle_timeout_ms:\s*300000/,
    'loadConfig 默认对象缺少 tunnel_forward_idle_timeout_ms'
  );
}

function testProxyJsReadsConfigWithoutSwallowingZero() {
  const source = fs.readFileSync(PROXY_JS, 'utf8');
  // 必须用能识别 0 的写法；`|| 300000` 会把合法的 0（关闭）吞掉
  assert.doesNotMatch(
    source,
    /config\.tunnel_forward_idle_timeout_ms\s*=\s*loadedConfig\.tunnel_forward_idle_timeout_ms\s*\|\|/,
    '0 会被 || 兜底吞掉，关闭超时无法生效'
  );
  assert.match(
    source,
    /Number\.isFinite\(loadedConfig\.tunnel_forward_idle_timeout_ms\)/,
    'loadConfig 没有用 Number.isFinite 读取该字段'
  );
}

function testProxyJsForwardsToManager() {
  const source = fs.readFileSync(PROXY_JS, 'utf8');
  const idx = source.indexOf('new TunnelManager(');
  assert.ok(idx > 0, '找不到 new TunnelManager');
  // 构造时传入的 config 对象必须在可见范围内带上映射后的字段
  const around = source.slice(Math.max(0, idx - 4000), idx + 200);
  assert.match(
    around,
    /forwardIdleTimeoutMs:/,
    'new TunnelManager 的 config 里没有 forwardIdleTimeoutMs'
  );
}

// ---------- 默认行为不变 ----------

function testDefaultsMatchLegacyBehaviour() {
  // 不配置时必须与改动前完全一致：300s 双向续命
  const manager = new TunnelManager(createMockServer(), {
    tunnel_domains: [],
    proxy_port: 8001,
  });
  assert.strictEqual(manager._forwardIdleTimeoutMs, DEFAULT_IDLE_MS);
  assert.strictEqual(manager._reverseIdleTimeoutMs, DEFAULT_IDLE_MS);
  assert.ok(FRAME_TYPES.CLOSE === 3);
}

const tests = [
  testManagerDefaultsToFiveMinutes,
  testManagerAcceptsExplicitTimeout,
  testManagerTreatsZeroAsDisabledNotAsDefault,
  testProxyJsDeclaresDefault,
  testProxyJsReadsConfigWithoutSwallowingZero,
  testProxyJsForwardsToManager,
  testDefaultsMatchLegacyBehaviour,
];

let failed = 0;
for (const test of tests) {
  try {
    test();
    console.log(`ok   ${test.name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${test.name}\n     ${e.message}`);
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
