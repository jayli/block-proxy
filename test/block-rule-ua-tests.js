// 父控拦截与 YouTube UA 豁免的优先级测试：node test/block-rule-ua-tests.js
// 直接调用 proxy.js 中真实的 beforeSendRequest，全程无网络 IO。
//
// 回归的 bug：UA 豁免（浏览器访问 youtube.com 不做去广告 MITM）曾被放在拦截判定之前，
// 直接 return passRequest，导致 block_hosts 里配了 youtube.com 也拦不住浏览器流量。
const assert = require('assert');

const LocalProxy = require('../proxy/proxy');
const mitmRegistry = require('../proxy/mitm/registry');

const rule = LocalProxy._test.getAnyProxyOptions().rule;

const DEVICE_MAC = 'EE:A8:EB:67:F4:AD';
const DEVICE_IP = '192.168.124.48';
const OTHER_IP = '192.168.124.99';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/26.6 Safari/605.1.15';
const YOUTUBE_APP_UA = 'com.google.ios.youtube/20.10.3 (iPhone16,2; U; CPU iOS 18_2 like Mac OS X;)';

function makeRewriteRule() {
  return {
    type: 'beforeSendRequest',
    host: 'youtube.com',
    regexp: '^https://',
    callback: async function () {
      return { response: { statusCode: 204, header: {}, body: '' } };
    }
  };
}

// blockHosts 有 youtube 规则；registry 启用内置 Youtube 组（UA 豁免的前提条件）
function setup(withBlockRule) {
  LocalProxy._test.setEnableMitmForTest('1');
  LocalProxy._test.setRuleRegistryForTest(mitmRegistry.createRegistry({
    builtinRules: { Youtube: [makeRewriteRule()] },
    config: {}
  }));
  LocalProxy._test.setDevicesForTest([
    { ip: DEVICE_IP, mac: DEVICE_MAC },
    { ip: OTHER_IP, mac: '6E:FB:18:4D:9C:3E' }
  ]);
  LocalProxy._test.setBlockHostsForTest(withBlockRule
    ? [{ filter_host: 'youtube.com', filter_mac: DEVICE_MAC, filter_weekday: [1, 2, 3, 4, 5, 6, 7] }]
    : []);
}

function httpsRequestDetail(host, pathStr, sourceIp, userAgent) {
  return {
    url: `https://${host}${pathStr}`,
    protocol: 'https',
    host: `${host}:443`,
    requestOptions: {
      hostname: host,
      host: host,
      path: pathStr,
      method: 'GET',
      port: 443,
      headers: { 'User-Agent': userAgent }
    },
    requestData: Buffer.alloc(0),
    _req: { sourceIp: sourceIp, client: { remoteAddress: sourceIp } }
  };
}

function callBeforeSendRequest(detail) {
  return rule.beforeSendRequest.call(
    { checkProxyAuth: () => true, send407bySocket: () => {} },
    detail
  );
}

function isBlockedResponse(result) {
  return !!(result && result.response);
}

function isPassThrough(result) {
  return !!(result && result.requestOptions && !result.response);
}

async function testBrowserUaCannotBypassBlockRule() {
  setup(true);
  const result = await callBeforeSendRequest(
    httpsRequestDetail('www.youtube.com', '/watch?v=abc', DEVICE_IP, BROWSER_UA)
  );
  assert.ok(isBlockedResponse(result), '浏览器 UA 访问命中拦截规则的域名应被拦截');
  assert.strictEqual(result.response.statusCode, 200);
}

async function testYoutubeAppUaCannotBypassBlockRule() {
  setup(true);
  const result = await callBeforeSendRequest(
    httpsRequestDetail('www.youtube.com', '/youtubei/v1/player', DEVICE_IP, YOUTUBE_APP_UA)
  );
  assert.ok(isBlockedResponse(result), 'YouTube App UA 访问命中拦截规则的域名同样应被拦截');
}

async function testUaExemptionStillSkipsRewrite() {
  setup(false); // 没有拦截规则：UA 豁免应继续让浏览器跳过重写（去广告不生效）
  const browser = await callBeforeSendRequest(
    httpsRequestDetail('www.youtube.com', '/watch?v=abc', DEVICE_IP, BROWSER_UA)
  );
  assert.ok(isPassThrough(browser), '浏览器 UA 无拦截规则时应放行且不触发重写');

  const app = await callBeforeSendRequest(
    httpsRequestDetail('www.youtube.com', '/watch?v=abc', DEVICE_IP, YOUTUBE_APP_UA)
  );
  assert.ok(isBlockedResponse(app), 'YouTube App UA 无拦截规则时应触发重写规则');
  assert.strictEqual(app.response.statusCode, 204);
}

async function testUnmonitoredDeviceUsesItsOwnRules() {
  setup(true);
  const result = await callBeforeSendRequest(
    httpsRequestDetail('www.youtube.com', '/watch?v=abc', OTHER_IP, BROWSER_UA)
  );
  assert.ok(isPassThrough(result), '没有该 MAC 的拦截规则时浏览器流量应放行');
}

(async () => {
  const tests = [
    testBrowserUaCannotBypassBlockRule,
    testYoutubeAppUaCannotBypassBlockRule,
    testUaExemptionStillSkipsRewrite,
    testUnmonitoredDeviceUsesItsOwnRules
  ];
  for (const testFn of tests) {
    await testFn();
    console.log(`PASS ${testFn.name}`);
  }
  console.log('block rule / UA exemption priority tests passed');
  process.exit(0);
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
